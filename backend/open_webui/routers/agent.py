"""Agent event bridge (PR3): the Python side of the pi event splice.

The sidecar hosts pi sessions and streams their raw session events as SSE
(ADR 0001). This module is the translator the event-bridge decision (issue 6)
called for: it turns pi-native SSE into the stream the existing
`streaming_chat_response_handler` already consumes, which keeps the Socket.IO
`events` envelope, DB persistence, and title/tags/follow-up plumbing
loop-owned in Python exactly as they are.

Contract kept here on purpose:

- Inlet (ADR 0005): filters already ran in `process_chat_payload` in Python.
  The handoff to the sidecar carries the prompt head (the system messages)
  plus the new turn only. History is omitted; pi's JSONL session owns it.
- Outlet (ADR 0005): stays where it is today, mutating the persisted copy
  after the final translated frame (`outlet_filter_handler` in middleware).
- Stop: the existing stop-task path cancels the chat task; the bridge posts
  to the sidecar `abort` route and flushes a final done frame with partial
  content preserved.
- Steering (issue 6): a send during an active run is converted into a post
  to the sidecar steer route; the running stream continues in place. The
  send-during-generation UI change lands in PR10.
- Edit-resend (issue 6): when the request's history is at or before what the
  sidecar session hosts, the bridge branches the session back to just before
  the resent turn (`fork` route), then prompts with the edited text.

Session eviction (issue 29, ADR 0006) lives in the sidecar registry; the
bridge only reads the health counts.
"""

import asyncio
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from open_webui.models.chats import Chats
from open_webui.utils.chat_id import is_saved_chat_id

log = logging.getLogger(__name__)

router = APIRouter()

# Model ids routed to the sidecar loop. Empty by default: the bridge is off
# until the deployment names the agent models.
AGENT_LOOP_MODEL_IDS = {
    model_id.strip() for model_id in os.environ.get('AGENT_LOOP_MODEL_IDS', '').split(',') if model_id.strip()
}

STREAM_STALL_TIMEOUT_S = int(os.environ.get('AGENT_SIDECAR_STREAM_TIMEOUT', '0') or 0) or None
REQUEST_TIMEOUT_S = float(os.environ.get('AGENT_SIDECAR_REQUEST_TIMEOUT', '30') or 30)


def sidecar_base_url() -> str:
    port = os.environ.get('AGENT_SIDECAR_PORT', '').strip()
    if not port:
        return ''
    return os.environ.get('AGENT_SIDECAR_URL', '').strip() or f'http://127.0.0.1:{port}'


def _client() -> httpx.AsyncClient:
    headers = {}
    pinned = os.environ.get('AGENT_SIDECAR_VERSION', '').strip()
    if pinned:
        headers['x-agent-client-version'] = pinned
    return httpx.AsyncClient(base_url=sidecar_base_url(), headers=headers, timeout=REQUEST_TIMEOUT_S)


def is_agent_model(model_id: str) -> bool:
    return bool(sidecar_base_url()) and model_id in AGENT_LOOP_MODEL_IDS


def is_internal_task_call(metadata: dict) -> bool:
    """Whether a `generate_chat_completion` payload is a loop-owned Python task call.

    Every task-registry call site (title, tags, follow-ups in `routers/tasks.py`,
    function calling, memory review, context compaction) marks its metadata with
    `task`; a user-facing chat turn never does. One decision at the dispatch, so
    those calls keep their ordinary Python path and never touch the sidecar per
    the plan box "title, tags, and follow-ups keep their
    `background_tasks_handler` plumbing"."""
    return bool(metadata.get('task'))


def _delivery_mode(metadata: dict) -> str:
    """Pick the sidecar's tool approval gate for this turn.

    'ask' raises the approval card on every tool call; 'full' runs them
    silently (trunk's ungated mode). An explicit AGENT_TOOL_APPROVAL_MODE wins;
    otherwise 'full' — the operator's default (2026-10-28): agent tool calls
    run ungated unless the deployment opts into the card.
    """
    forced = os.environ.get('AGENT_TOOL_APPROVAL_MODE', 'full').strip().lower()
    if forced in {'ask', 'full'}:
        return forced
    return 'full'


# ---------------------------------------------------------------------------
# Sidecar client: the five routes the bridge needs.
# ---------------------------------------------------------------------------


async def ensure_session(client: httpx.AsyncClient, chat_id: str, system: str | None) -> dict:
    response = await client.post('/sessions', json={'chatId': chat_id, **({'system': system} if system else {})})
    response.raise_for_status()
    return response.json()


async def fork_session(client: httpx.AsyncClient, chat_id: str, keep_turns: int) -> dict:
    response = await client.post(f'/sessions/{chat_id}/fork', json={'keepTurns': keep_turns})
    response.raise_for_status()
    return response.json()


async def steer_session(client: httpx.AsyncClient, chat_id: str, message: str) -> dict:
    response = await client.post(f'/sessions/{chat_id}/steer', json={'message': message})
    response.raise_for_status()
    return response.json()


async def abort_session(client: httpx.AsyncClient, chat_id: str) -> dict:
    response = await client.post(f'/sessions/{chat_id}/abort', json={})
    response.raise_for_status()
    return response.json()


async def interact_session(client: httpx.AsyncClient, chat_id: str, call_id: str, action: str) -> dict:
    """Deliver a browser decision to the gate holding the sidecar run."""
    response = await client.post(f'/sessions/{chat_id}/interact', json={'id': call_id, 'action': action})
    if response.status_code == 409:
        # The gate is already gone: the run resolved or ended by itself.
        return {'ok': False, 'stale': True}
    response.raise_for_status()
    return response.json()


async def stream_sidecar_events(
    client: httpx.AsyncClient,
    chat_id: str,
    message: str,
    tool_approval: str = 'full',
) -> AsyncIterator[tuple[str, dict]]:
    """Yield `(event, data)` frames from the sidecar prompt SSE stream."""
    async with client.stream(
        'POST',
        f'/sessions/{chat_id}/prompt',
        json={'message': message, 'toolApproval': tool_approval},
        timeout=None,
    ) as response:
        if response.status_code >= 400:
            body = (await response.aread()).decode('utf-8', 'replace')
            raise HTTPException(status_code=response.status_code, detail=body)
        event_name = ''
        async for line in response.aiter_lines():
            if not line:
                event_name = ''
                continue
            if line.startswith('event:'):
                event_name = line.removeprefix('event:').strip()
                continue
            if line.startswith('data:'):
                try:
                    data = json.loads(line.removeprefix('data:').strip())
                except json.JSONDecodeError:
                    continue
                yield (event_name or 'message'), data


# ---------------------------------------------------------------------------
# Translator: pi-native session events -> Responses-API SSE lines, plus the
# direct envelope events (status, citations, errors) the streaming handler
# does not carry on its wire.
# ---------------------------------------------------------------------------


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ''.join(part.get('text', '') for part in content if isinstance(part, dict))
    return ''


class PiEventTranslator:
    """Stateful translation of one sidecar run into translated SSE lines.

    Yields `data: {...}` lines in the OpenAI Responses streaming vocabulary
    (`response.output_item.*`, `*.delta`, `response.completed`), which
    `streaming_chat_response_handler` reduces into the `chat:completion`
    output items the frontend renders. Direct envelope events — status pills,
    errors — go straight through the event emitter with their ordinary
    shapes, per issue 6.
    """

    def __init__(self):
        # Direct envelope events (status pills, errors), emitted in order.
        self.lines: list[str] = []
        self.output_index = 0
        # pi content block index -> (item type, emitted output index)
        self.block_items: dict[int, tuple[str, int]] = {}
        # call_id -> (output index, live item dict): the function-call items
        # the interaction route can still act on (issue 6: approvals).
        self.call_items: dict[str, tuple[int, dict]] = {}
        self.usage: dict | None = None
        self.error: dict | None = None
        self.aborted = False

    async def _emit(self, event: dict) -> None:
        # The translator runs before the response context exists, so direct
        # envelope events ride the stream as marked lines; the agent handler
        # dispatches them through the chat's own event emitter.
        self.lines.append(self._line({'x-owui-event': event}))

    def _line(self, payload: dict) -> str:
        return f'data: {json.dumps(payload, ensure_ascii=False)}\n\n'

    def _added(self, item: dict) -> str:
        payload = {'type': 'response.output_item.added', 'output_index': self.output_index, 'item': item}
        item['_output_index'] = self.output_index
        self.output_index += 1
        return self._line(payload)

    def _added_and_done(self, item: dict) -> int:
        """Emit the item as added then done; returns its output index."""
        output_index = self.output_index
        self._added(item)
        item.pop('_output_index', None)
        self._line({'type': 'response.output_item.done', 'output_index': output_index, 'item': item})
        return output_index

    def _done_item(self, item: dict) -> str:
        output_index = item.pop('_output_index', self.output_index - 1)
        return self._line({'type': 'response.output_item.done', 'output_index': output_index, 'item': item})

    def _ensure_item(self, content_index: int, item_type: str) -> int:
        """Lazily open the OWUI output item for a pi content block."""
        existing = self.block_items.get(content_index)
        if existing and existing[0] == item_type:
            return existing[1]
        item = (
            {'type': 'reasoning', 'id': f'r-{content_index}', 'status': 'in_progress', 'content': [], 'summary': []}
            if item_type == 'reasoning'
            else {
                'type': 'message',
                'id': f'msg-{content_index}',
                'status': 'in_progress',
                'role': 'assistant',
                'content': [],
            }
        )
        self.block_items[content_index] = (item_type, self.output_index)
        self._added(item)
        return self.output_index - 1

    async def translate(self, event: str, data: dict) -> AsyncIterator[str]:
        event_type = data.get('type', event)
        if self.lines:
            # Flush direct envelope events queued by an earlier await.
            for line in self.lines:
                yield line
            self.lines.clear()
        if event_type == 'message_start' and (data.get('message') or {}).get('role') == 'assistant':
            return

        if event_type == 'owui_interaction':
            # A tool call hit the sidecar's approval gate; the call blocks
            # until the browser answers through the chats resolve route, which
            # posts the decision to the sidecar interaction route. Surface the
            # pending card and stop the message so the browser resolves it.
            interaction = data.get('interaction') or {}
            call_id = interaction.get('id')
            tracked = self.call_items.get(call_id) if call_id else None
            tool_name = interaction.get('toolName', 'tool')
            if tracked:
                index, item = tracked
                item['status'] = 'pending'
                yield self._line({'type': 'response.output_item.done', 'output_index': index, 'item': item})
                await self._emit(
                    {
                        'type': 'chat:interaction:pending',
                        'data': {'call_id': call_id, 'tool_name': tool_name},
                    }
                )
            else:
                log.warning('agent bridge: interaction for untracked call %s (tool %s)', call_id, tool_name)
            return

        if event_type == 'message_update':
            assistant_event = data.get('assistantMessageEvent') or {}
            kind = assistant_event.get('type', '')
            content_index = assistant_event.get('contentIndex', 0)
            if kind == 'text_delta':
                item_index = self._ensure_item(content_index, 'message')
                yield self._line(
                    {
                        'type': 'response.output_text.delta',
                        'output_index': item_index,
                        'item_id': f'msg-{content_index}',
                        'content_index': content_index,
                        'delta': assistant_event.get('delta', ''),
                    }
                )
            elif kind == 'thinking_delta':
                item_index = self._ensure_item(content_index, 'reasoning')
                yield self._line(
                    {
                        'type': 'response.reasoning_text.delta',
                        'output_index': item_index,
                        'item_id': f'r-{content_index}',
                        'content_index': content_index,
                        'delta': assistant_event.get('delta', ''),
                    }
                )
            elif kind == 'toolcall_end':
                # pi's toolCall is flat: {type: 'toolCall', id, name, arguments}
                tool_call = assistant_event.get('toolCall') or {}
                call_id = tool_call.get('id') or f'fc-{content_index}'
                arguments = tool_call.get('arguments', {})
                item = {
                    'type': 'function_call',
                    'id': call_id,
                    'call_id': call_id,
                    'name': tool_call.get('name', ''),
                    'arguments': arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False),
                    'status': 'in_progress',
                }
                emitted_index = self._added_and_done(item)
                # Track for the approval card (pending) and the final
                # completed stamp when the executed result lands.
                if emitted_index is not None:
                    self.call_items[call_id] = (emitted_index, item)
            return

        if event_type == 'message_end':
            message = data.get('message') or {}
            if message.get('role') == 'assistant':
                usage = message.get('usage') or {}
                if usage:
                    self.usage = {
                        'input_tokens': usage.get('input', 0),
                        'output_tokens': usage.get('output', 0),
                    }
                    self.usage['total_tokens'] = self.usage['input_tokens'] + self.usage['output_tokens']
                # Block items close through the turn's done frame; the agent
                # handler stamps them completed on finalize.
                self.block_items.clear()
            return

        if event_type == 'tool_execution_start':
            tool_name = data.get('toolName', 'tool')
            await self._emit(
                {
                    'type': 'status',
                    'data': {
                        'action': tool_name,
                        'description': f'Running tool {tool_name}',
                        'done': False,
                    },
                }
            )
            return

        if event_type == 'tool_execution_end':
            tool_name = data.get('toolName', 'tool')
            result = data.get('result') or {}
            result_text = _content_to_text(result.get('content') if isinstance(result, dict) else result)
            call_id = data.get('toolCallId') or f'fco-{self.output_index}'
            item = {
                'type': 'function_call_output',
                # Own id: the reducer matches output items by id first, and the
                # call_id must keep pointing at the call it answers.
                'id': f'fco-{call_id}',
                'call_id': call_id,
                'output': [{'type': 'input_text', 'text': result_text or 'done'}],
                'status': 'failed' if data.get('isError') else 'completed',
            }
            tracked = self.call_items.pop(call_id, None)
            if tracked:
                index, tracked_item = tracked
                if data.get('isError') and tracked_item.get('status') == 'pending':
                    # A gated call the browser denied: pi skipped execution and
                    # completed it as an immediate error result.
                    tracked_item['status'] = 'rejected'
                    yield self._line({'type': 'response.output_item.done', 'output_index': index, 'item': tracked_item})
                else:
                    tracked_item['status'] = 'completed'
                    yield self._line({'type': 'response.output_item.done', 'output_index': index, 'item': tracked_item})
            yield self._added(item)
            yield self._done_item(item)
            await self._emit(
                {'type': 'status', 'data': {'action': tool_name, 'description': f'Tool {tool_name} done', 'done': True}}
            )
            return

        if event_type == 'auto_retry_start':
            attempt = data.get('attempt', '')
            await self._emit(
                {
                    'type': 'status',
                    'data': {'description': f'Retrying ({attempt})', 'done': False},
                }
            )
            return

        if event_type == 'done':
            # The prompt result frame: {reason, assistantText?, sessionId, error?}
            reason = data.get('reason')
            if reason == 'error':
                self.error = {'content': data.get('error') or 'The agent run failed.'}
            elif reason == 'aborted':
                self.aborted = True
            return

        if event_type == 'error':
            self.error = {'content': data.get('error') or data.get('message') or 'The agent run failed.'}
            return

    def flush_lines(self) -> list[str]:
        queued, self.lines = self.lines, []
        return queued

    def final_line(self) -> str:
        """The closing `response.completed` (or `response.failed`) line."""
        if self.error:
            return self._line({'type': 'response.failed', 'response': {'id': 'agent', 'error': self.error}})
        return self._line(
            {'type': 'response.completed', 'response': {'id': 'agent', **({'usage': self.usage} if self.usage else {})}}
        )


# ---------------------------------------------------------------------------
# Chat entry: routing, inlet handoff, fork decision.
# ---------------------------------------------------------------------------


def _user_message_text(message: dict) -> str:
    return _content_to_text(message.get('content'))


def _split_head_and_turns(messages: list[dict]) -> tuple[str, list[dict], bool]:
    """Return (prompt head, non-system turns, ends_with_assistant) per ADR 0005."""
    head_parts = []
    turns = []
    for message in messages:
        if message.get('role') == 'system':
            head_parts.append(_user_message_text(message))
        else:
            turns.append(message)
    ends_with_assistant = bool(turns) and turns[-1].get('role') == 'assistant'
    return '\n\n'.join(part for part in head_parts if part.strip()), turns, ends_with_assistant


async def generate_agent_chat_completion(request: Request, form_data: dict, user: Any):
    """The sidecar loop for agent-routed models.

    Returns a streaming response whose body is the translated Responses SSE;
    the marker header routes `process_chat_response` to the agent handler so
    persistence, outlet, and background tasks stay loop-owned in Python.
    """
    metadata = form_data.get('metadata') or {}
    chat_id = metadata.get('chat_id') or ''
    messages = form_data.get('messages') or []
    if not chat_id:
        # Guard the boundary (fix round 1): an empty chat_id would otherwise
        # reach the sidecar sessions lookup as `chatId: ""` and answer 500.
        raise HTTPException(status_code=400, detail='chat_id is required for the agent loop.')
    head, turns, ends_with_assistant = _split_head_and_turns(messages)

    disposition = metadata.get('tool_approval_resume')
    if disposition and metadata.get('assistant_message_id'):
        # Approvals ride the translator's interaction callbacks (issue 6): the
        # browser's approve/deny lands through the chats resolve route, the
        # approval resume re-enters here with the persisted decision, and the
        # sidecar interaction route delivers it to the gate that holds the
        # run. The run's own bridge stream (still open on the paused gate)
        # carries the verdict to the chat; this resume turn itself lands
        # nothing, so the agent handler steps aside.
        return await resolve_agent_interaction(metadata)

    prompt_text = ''
    keep_turns = 0

    if ends_with_assistant and metadata.get('assistant_message_id'):
        # Continue-response: the session already hosts every turn; prompt
        # asks the model to carry on from where it stopped. No fork.
        prompt_text = 'continue'
        keep_turns = len([m for m in turns if m.get('role') == 'user'])
    else:
        user_turns = [m for m in turns if m.get('role') == 'user']
        if not user_turns:
            raise HTTPException(status_code=400, detail='No user message to send to the agent.')
        prompt_text = _user_message_text(user_turns[-1])
        keep_turns = len(user_turns) - 1

    client = _client()
    try:
        session_info = await ensure_session(client, chat_id, head or None)

        if session_info.get('running'):
            # Steering (issue 6): the run continues in place on its own
            # stream; this request posts to the steer route and completes.
            # The send-during-generation UI change lands in PR10. Checked
            # before the fork decision: a send during a run never rewinds.
            disposition = await steer_session(client, chat_id, prompt_text)
            log.info('agent bridge: steered chat %s (%s)', chat_id, disposition)
            return StreamingResponse(
                _steer_acknowledgement(),
                media_type='text/event-stream',
                headers={'x-agent-loop': 'pi', 'x-agent-steer': 'true'},
            )

        if not ends_with_assistant and keep_turns < session_info.get('userTurns', 0):
            # Edit-resend or regeneration: history rewound, fork-or-restore
            # to just before the resent turn (issue 6, ADR 0005).
            await fork_session(client, chat_id, keep_turns)

        # The gate mode for this run: 'ask' raises the approval card, 'full'
        # runs tool calls silently (trunk's ungated mode).
        tool_approval = _delivery_mode(metadata)

        async def sse_stream() -> AsyncIterator[str]:
            translator = PiEventTranslator()
            try:
                async for event, data in stream_sidecar_events(client, chat_id, prompt_text, tool_approval):
                    async for line in translator.translate(event, data):
                        yield line
                    for line in translator.flush_lines():
                        yield line
                yield translator.final_line()
                yield 'data: [DONE]\n\n'
            except asyncio.CancelledError:
                # Stop (issue 6): the task-registry cancel reaches us here.
                # Post abort so the sidecar run ends, then flush the done
                # frame with partial content preserved.
                try:
                    await abort_session(client, chat_id)
                except Exception:
                    log.exception('agent bridge: abort post failed for chat %s', chat_id)
                yield translator.final_line()
                yield 'data: [DONE]\n\n'
                raise
            except HTTPException as e:
                # Sidecar refused or died mid-run: surface a terminal error
                # frame so the browser gets a usable done state (issue 6).
                yield translator._line(
                    {'type': 'response.failed', 'response': {'error': {'content': e.detail or 'agent sidecar error'}}}
                )
                yield 'data: [DONE]\n\n'
            except Exception as e:
                log.exception('agent bridge: prompt stream failed for chat %s', chat_id)
                yield translator._line(
                    {'type': 'response.failed', 'response': {'error': {'content': f'agent sidecar error: {e}'}}}
                )
                yield 'data: [DONE]\n\n'
            finally:
                await client.aclose()

        return StreamingResponse(
            sse_stream(),
            media_type='text/event-stream',
            headers={'x-agent-loop': 'pi'},
        )
    except HTTPException:
        await client.aclose()
        raise
    except Exception as e:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f'agent sidecar unreachable: {e}')


async def _steer_acknowledgement() -> AsyncIterator[str]:
    """A steered send closes immediately; the run's own stream carries the reply."""
    yield f'data: {json.dumps({"type": "response.completed", "response": {"id": "agent-steer"}})}\n\n'
    yield 'data: [DONE]\n\n'


async def _empty_acknowledgement() -> AsyncIterator[str]:
    """A resolution turn that lands nothing of its own."""
    yield 'data: [DONE]\n\n'


async def resolve_agent_interaction(metadata: dict) -> StreamingResponse:
    """The approval-resume turn: carry the browser's decision to the sidecar.

    The chats resolve route already wrote the decision into the assistant
    message (approve, or a rejected call with its error output). Read it from
    the persisted message, post it to the sidecar interaction route, and hand
    back a no-op stream: the run's own bridge stream, still open on the gate,
    finalizes the message with the resumed answer.
    """
    from open_webui.models.chats import Chats as _Chats

    chat_id = metadata.get('chat_id') or ''
    message_id = metadata.get('assistant_message_id') or ''
    assistant_message = await _Chats.get_message_by_id_and_message_id(chat_id, message_id)
    call_id, action = None, 'approve'
    if assistant_message:
        output = assistant_message.get('output') or []
        has_rejected_output = any(
            item.get('type') == 'function_call_output' and item.get('status') == 'rejected'
            for item in output
            if isinstance(item, dict)
        )
        for item in output:
            if not isinstance(item, dict) or item.get('type') != 'function_call':
                continue
            if item.get('status') == 'queued' and item.get('approved') is True and not has_rejected_output:
                call_id, action = item.get('call_id') or item.get('id'), 'approve'
                break
            if item.get('status') == 'rejected' or has_rejected_output:
                call_id, action = item.get('call_id') or item.get('id'), 'reject'
                break
    if not call_id:
        log.info(
            'agent bridge: approval resume for %s/%s found no decision, leaving the gate as it is', chat_id, message_id
        )
        return StreamingResponse(
            _empty_acknowledgement(),
            media_type='text/event-stream',
            headers={'x-agent-loop': 'pi', 'x-agent-interaction': 'stale'},
        )
    try:
        result = await interact_session(_client(), chat_id, call_id, action)
        log.info('agent bridge: interaction %s for %s/%s resolved: %s', action, chat_id, message_id, result)
    except Exception:
        log.exception('agent bridge: interaction delivery failed for %s/%s', chat_id, message_id)
    return StreamingResponse(
        _empty_acknowledgement(),
        media_type='text/event-stream',
        headers={'x-agent-loop': 'pi', 'x-agent-interaction': 'delivered'},
    )


# ---------------------------------------------------------------------------
# The agent response handler: the loop-owned Python plumbing (persistence,
# redis stream snapshots, outlet, background tasks) applied to the
# translated stream. Mirrors the essential outer shape of
# `streaming_chat_response_handler` without its provider-specific branches.
# ---------------------------------------------------------------------------


async def agent_chat_response_handler(response: StreamingResponse, ctx: dict):
    from open_webui.tasks import clear_response_stream, save_response_stream
    from open_webui.utils.middleware import background_tasks_handler, outlet_filter_handler, publish_chat_finished_event
    from open_webui.utils.misc import get_output_text
    from open_webui.utils.response import handle_responses_streaming_event, normalize_usage

    request = ctx['request']
    user = ctx['user']
    metadata = ctx['metadata']
    event_emitter = ctx['event_emitter']
    chat_id = metadata.get('chat_id') or ''
    save_to_chat = is_saved_chat_id(chat_id)
    response_stream_task_id = metadata.get('task_id') or metadata.get('message_id')

    if metadata.get('tool_approval_resume'):
        # The interaction-resolution turn: the run's own bridge stream (still
        # open on the sidecar's gate) carries the decision and finalizes the
        # message. This turn landed nothing and owns nothing.
        return None

    # Pre-stream events from process_chat_payload (e.g. RAG sources), same as
    # the standard handler's first loop.
    for event in ctx.get('events') or []:
        if event_emitter:
            await event_emitter({'type': 'chat:completion', 'data': event})
        if save_to_chat:
            await Chats.upsert_message_to_chat_by_id_and_message_id(
                metadata['chat_id'], metadata['message_id'], {**event}
            )

    output: list = []
    usage: dict | None = None
    error: dict | None = None
    last_flush = 0.0
    pending_delta = False

    async def flush(force: bool = False):
        nonlocal last_flush, pending_delta
        if not pending_delta:
            return
        now = time.monotonic()
        if not force and now - last_flush < 0.15:
            return
        last_flush = now
        pending_delta = False
        if event_emitter:
            await event_emitter({'type': 'chat:completion', 'data': {'output': output}})
        # Refresh the redis snapshot so a reload mid-stream overlays the
        # flushed output (the snapshot stays loop-owned in Python).
        try:
            await save_response_stream(
                request.app.state.redis, response_stream_task_id, chat_id, metadata.get('message_id'), output
            )
        except Exception:
            log.exception('agent bridge: response stream snapshot failed')

    async def persist_error(error_content: Any) -> None:
        if save_to_chat:
            await Chats.upsert_message_to_chat_by_id_and_message_id(
                metadata['chat_id'], metadata['message_id'], {'error': {'content': error_content}}
            )
        if event_emitter:
            await event_emitter({'type': 'chat:message:error', 'data': {'error': {'content': error_content}}})

    body = response.body_iterator
    cancelled = False
    try:
        async for line in body:
            line = line.decode('utf-8', 'replace') if isinstance(line, bytes) else line
            if not line or line.isspace():
                continue
            payload = line.removeprefix('data:').strip()
            if not payload or payload == '[DONE]':
                continue
            try:
                data = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if not isinstance(data, dict):
                continue

            direct = data.get('x-owui-event')
            if isinstance(direct, dict):
                if direct.get('type') == 'chat:interaction:pending':
                    # A gated tool call awaits the browser: persist the pending
                    # card now (the approval route reads the saved message) and
                    # stop the message so the browser resolves it. The run
                    # itself is blocked on the sidecar's gate; its verdict and
                    # the resumed answer arrive later on this same stream.
                    if save_to_chat:
                        try:
                            await Chats.upsert_message_to_chat_by_id_and_message_id(
                                metadata['chat_id'],
                                metadata['message_id'],
                                {'done': False, 'output': output},
                                touch=False,
                            )
                        except Exception:
                            log.exception('agent bridge: pending interaction persist failed')
                    if event_emitter:
                        await event_emitter({'type': 'chat:completion', 'data': {'done': False, 'output': output}})
                    continue
                if event_emitter:
                    try:
                        await event_emitter(direct)
                    except Exception:
                        log.exception('agent bridge: envelope emit failed')
                continue

            output, response_metadata = handle_responses_streaming_event(data, output)
            if response_metadata:
                if response_metadata.get('usage'):
                    usage = {**(usage or {}), **response_metadata['usage']}
                if response_metadata.get('error'):
                    error = response_metadata['error']

            if data.get('type', '').endswith('.delta'):
                pending_delta = True
                await flush()
            else:
                await flush(force=True)
    except asyncio.CancelledError:
        # Stop (issue 6): the task-registry cancel reached the loop. Post
        # abort so the sidecar run ends (a no-op if the stream already
        # flushed its aborted done frame), then finalize below: partial
        # content preserved, done state usable.
        cancelled = True
        try:
            await asyncio.shield(abort_session(_client(), chat_id))
        except Exception:
            log.exception('agent bridge: abort post failed for chat %s', chat_id)
    finally:
        # Close the upstream sidecar connection.
        if hasattr(body, 'aclose'):
            try:
                await asyncio.shield(body.aclose())
            except Exception:
                pass

    if error and not cancelled:
        await persist_error(error)

    for item in output:
        if item.get('status') == 'in_progress':
            item['status'] = 'incomplete' if cancelled or error else 'completed'
        elif item.get('status') == 'pending':
            # A gated call the run ended without resolving (the browser never
            # answered): nothing will execute it again, so land it rejected
            # like the stop path finalizes approval cards.
            item['status'] = 'rejected'

    usage = normalize_usage(usage or {})
    current_output = output

    if save_to_chat:
        await Chats.upsert_message_to_chat_by_id_and_message_id(
            metadata['chat_id'],
            metadata['message_id'],
            {
                'done': True,
                'output': current_output,
                **({'usage': usage} if usage else {}),
            },
        )

    await clear_response_stream(request.app.state.redis, response_stream_task_id)
    await publish_chat_finished_event(
        request,
        user,
        metadata,
        await Chats.get_chat_title_by_id(chat_id) if save_to_chat else '',
        get_output_text(current_output),
        current_output,
    )

    if event_emitter:
        await event_emitter(
            {
                'type': 'chat:tasks:cancel' if cancelled else 'chat:completion',
                'data': {
                    'done': True,
                    'output': current_output,
                    'title': await Chats.get_chat_title_by_id(chat_id) if save_to_chat else '',
                    **({'usage': usage} if usage else {}),
                    **({'error': error} if error else {}),
                },
            }
        )

    ctx['assistant_message'] = {
        'content': get_output_text(current_output),
        'output': current_output,
        **({'usage': usage} if usage else {}),
    }
    try:
        await outlet_filter_handler(ctx)
    except Exception:
        log.exception('agent bridge: outlet filter failed')
    await background_tasks_handler(ctx)
