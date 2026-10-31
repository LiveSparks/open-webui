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
import re
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from open_webui.models.chats import Chats
from open_webui.loopback_mcp import mint_session_binding
from open_webui.routers.agent_machines import mint_machine_binding
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
    payload: dict = {'chatId': chat_id, **({'system': system} if system else {})}
    raw_binding = client.headers.pop('x-agent-loopback-binding', None)
    if raw_binding:
        # The loopback tool bridge binding (issue 7) rides the client headers
        # rather than the call signature: the three-argument shape is the seam
        # PR3's parity harness patches. One shot: consumed by this create or
        # refresh, then gone.
        try:
            payload['binding'] = json.loads(raw_binding)
        except json.JSONDecodeError:
            log.warning('agent bridge: dropping a malformed loopback binding')
    response = await client.post('/sessions', json=payload)
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
    turn: dict | None = None,
    max_turns: int | None = None,
) -> AsyncIterator[tuple[str, dict]]:
    """Yield `(event, data)` frames from the sidecar prompt SSE stream."""
    # A sub-agent child spawn carries its assistant-turn budget (PR9, issue
    # 18): the sidecar realizes it as a finishTurn hook. Parent turns carry
    # none and stay uncapped, as today.
    body: dict = {
        'message': message,
        'toolApproval': tool_approval,
        **({'turn': turn} if turn else {}),
        **({'maxTurns': max_turns} if max_turns else {}),
    }
    async with client.stream(
        'POST',
        f'/sessions/{chat_id}/prompt',
        json=body,
        timeout=None,
    ) as response:
        if response.status_code >= 400:
            body = (await response.aread()).decode('utf-8', 'replace')
            raise HTTPException(status_code=response.status_code, detail=body)
        event_name = ''
        # The prompt stream always closes with the `done` result frame (an
        # `error` frame only on an outright refusal): a clean EOF without
        # either means the sidecar died mid-run, and the turn must surface
        # as failed, never as a quietly completed partial answer.
        saw_done = False
        saw_error = False
        async for line in response.aiter_lines():
            if not line:
                event_name = ''
                continue
            if line.startswith('event:'):
                event_name = line.removeprefix('event:').strip()
                saw_done = saw_done or event_name == 'done'
                saw_error = saw_error or event_name == 'error'
                continue
            if line.startswith('data:'):
                try:
                    data = json.loads(line.removeprefix('data:').strip())
                except json.JSONDecodeError:
                    continue
                yield (event_name or 'message'), data
        if not (saw_done or saw_error):
            raise HTTPException(status_code=502, detail='agent sidecar disconnected mid-run')


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


class CodeInterpreterStreamError(Exception):
    """The bridged execute_code turn streamed code-interpreter deltas
    (PR7); the browser renders the native "Analyzed" block from them."""

    def __init__(self, payload: dict | None = None):
        super().__init__('code interpreter stream')
        self.payload = payload or {}


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
        # The code interpreter rides the loopback bridge: the tool's code text
        # streams through the normal message_update path and is captured here
        # so the result can carry the code back to the Analyzed block.
        self._pending_code: dict[str, str] = {}

    @staticmethod
    def _tool_call_of(event: dict) -> dict:
        """A pi toolcall event's flat tool call, from the event or its partial.

        toolcall_end carries the full ToolCall; toolcall_start and
        toolcall_delta carry it inside the partial message's content."""
        tool_call = event.get('toolCall') or {}
        if not tool_call:
            for content in (event.get('partial') or {}).get('content') or []:
                if isinstance(content, dict) and content.get('type') == 'toolCall':
                    tool_call = content
                    break
        return tool_call

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
            elif kind == 'toolcall_start':
                # A code interpreter call opens the native "Analyzed" item on
                # start, so the browser watches the code arrive live (PR7,
                # plan: streamed code deltas).
                tool_call = self._tool_call_of(assistant_event)
                if tool_call.get('name') == 'execute_code':
                    call_id = tool_call.get('id') or f'fc-{content_index}'
                    item = {
                        'type': 'open_webui:code_interpreter',
                        'id': f'ci-{call_id}',
                        'call_id': call_id,
                        'status': 'in_progress',
                        'code': '',
                        'stdout': '',
                        'stderr': '',
                        'result': '',
                        'images': [],
                    }
                    self.block_items[content_index] = ('open_webui:code_interpreter', self.output_index)
                    self.call_items[call_id] = (self.output_index, item)
                    self._pending_code[call_id] = ''
                    yield self._added(item)
                return
            elif kind == 'toolcall_delta':
                # The model writes the code as arguments deltas; the code
                # interpreter streams them into the open item so the code
                # text grows while the turn runs.
                pending = self._tool_call_of(assistant_event)
                call_id = pending.get('id') or ''
                tracked = self.call_items.get(call_id)
                if tracked and self._pending_code.get(call_id) is not None:
                    delta = assistant_event.get('delta', '')
                    index, item = tracked
                    item['code'] = (item.get('code') or '') + delta
                    self._pending_code[call_id] = item['code']
                    yield self._line(
                        {
                            'type': 'response.output_text.delta',
                            'output_index': index,
                            'item_id': item.get('id'),
                            'content_index': content_index,
                            'delta': delta,
                        }
                    )
                return
            elif kind == 'toolcall_end':
                # pi's toolCall is flat: {type: 'toolCall', id, name, arguments}
                tool_call = assistant_event.get('toolCall') or {}
                call_id = tool_call.get('id') or f'fc-{content_index}'
                arguments = tool_call.get('arguments', {})
                # The code interpreter's code text finalizes on the argument
                # close; the item stays in_progress until the execution result
                # merges in at tool_execution_end.
                if tool_call.get('name') == 'execute_code' and call_id in self.call_items:
                    ci_args = arguments
                    if isinstance(ci_args, str):
                        try:
                            ci_args = json.loads(ci_args)
                        except Exception:
                            ci_args = {}
                    if isinstance(ci_args, dict) and ci_args.get('code'):
                        index, item = self.call_items[call_id]
                        item['code'] = ci_args.get('code')
                        self._pending_code[call_id] = item['code']
                    return
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

            # The code interpreter rides the bridge: an execute_code result
            # carries the ResultModel shape {stdout, stderr, result} and
            # translates into the native open_webui:code_interpreter item —
            # the browser's "Analyzed" block — instead of a plain text output.
            # The item opened at toolcall_start; the execution result merges
            # into it and the merged item is emitted as done.
            if tool_name == 'execute_code' and isinstance(result, dict):
                try:
                    tracked = self.call_items.get(call_id)
                    code = self._pending_code.pop(call_id, None)
                    if tracked:
                        index, item = tracked
                        merged = _to_code_interpreter_item(code if code is not None else item.get('code') or '', result)
                        item.update(merged)
                        item['status'] = 'completed'
                        yield self._line({'type': 'response.output_item.done', 'output_index': index, 'item': item})
                    else:
                        ci_item = _to_code_interpreter_item(code or '', result)
                        yield self._added(ci_item)
                        yield self._done_item(ci_item)
                    self.call_items.pop(call_id, None)
                    await self._emit(
                        {
                            'type': 'status',
                            'data': {'action': tool_name, 'description': 'Code interpreter done', 'done': True},
                        }
                    )
                    return
                except Exception:
                    log.exception('code interpreter translation failed; falling back to plain tool output')

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
# Code interpreter translation: the bridged execute_code result maps onto the
# native `open_webui:code_interpreter` item — the browser's "Analyzed" block.
# The shape contract lives in `sidecar/src/codeInterpreter.ts` (the sidecar is
# the one that talks to the browser); the backend mirrors it here so a tool
# result lands as the native item without any extra sidecar round-trip.
# ---------------------------------------------------------------------------


_CODE_INTERPRETER_IMAGE_RE = re.compile(r'data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)')


def _to_code_interpreter_item(code: str, result: dict) -> dict:
    """Translate a ResultModel-shaped execute_code result into the native item.

    The sidecar contract (codeInterpreter.ts) defines the shape; this keeps the
    backend and the sidecar consistent without a cross-process call. Images
    ride the stdout/stderr/result payloads as data URIs and get extracted into
    the `images` array the browser renders inline.
    """
    images = []
    for text in (result.get('stdout'), result.get('stderr'), result.get('result')):
        if isinstance(text, str):
            for mime, payload in _CODE_INTERPRETER_IMAGE_RE.findall(text):
                images.append({'type': mime.replace('image/', ''), 'base64': ''.join(payload.split())})
    return {
        'type': 'open_webui:code_interpreter',
        'code': code or '',
        'stdout': result.get('stdout') or '',
        'stderr': result.get('stderr') or '',
        'result': result.get('result') or '',
        'images': images,
    }


# ---------------------------------------------------------------------------
# Chat entry: routing, inlet handoff, fork decision.
# ---------------------------------------------------------------------------


def _user_message_text(message: dict) -> str:
    return _content_to_text(message.get('content'))


# The phase-1 prompt-head section (PR7): the agent's execute_code tool rides
# the loopback bridge, and this section tells it which surface it used, where
# it runs, and how isolated its effects are. Pyodide rides the bridge's
# browser `execute:python` event-call on direct connections; Jupyter is the
# server surface otherwise.


def _code_interpreter_surface(engine: str = 'pyodide') -> str:
    """One surface descriptor for the configured engine."""
    if engine == 'jupyter':
        return (
            'Surface: Jupyter server kernel. Your code runs on the configured '
            "Jupyter server, outside the browser, with the kernel's full "
            'package environment. Effects persist in the kernel session until '
            'it is restarted.'
        )
    return (
        "Surface: Pyodide in the browser. Your code runs inside the user's "
        'browser tab on a sandboxed WebAssembly Python runtime through the '
        'bridge execute:python event-call. Effects are isolated to the '
        'sandbox and disappear when the tab closes; no server state changes.'
    )


async def _code_interpreter_head_section() -> str:
    """The phase-1 prompt-head section for execute_code (PR7, plan build)."""
    from open_webui.models.config import Config

    engine = await Config.get('code_interpreter.engine', 'pyodide')
    return '## Code execution\n\nYou can run Python with the execute_code tool.\n\n' + _code_interpreter_surface(engine)


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
        # The code interpreter rides the loopback bridge (PR7): a phase-1
        # prompt-head section tells the agent which surface it runs on, where
        # it runs, and how isolated the effects are, before the session or the
        # fork decides anything else.
        try:
            head = (
                f'{head}\n\n{await _code_interpreter_head_section()}'
                if head
                else await _code_interpreter_head_section()
            )
        except Exception:
            log.warning('code interpreter prompt-head section unavailable', exc_info=True)

        # The loopback tool bridge: a fresh short-TTL binding every turn, so a
        # rebuilt session re-enters with a live token and a running session
        # refreshes its MCP entry at the next turn_start. The mint needs the
        # request's own address for the bridge URL; a request-less dispatch
        # (internal calls, direct harness drives) carries no binding and the
        # bridge stays off for that turn.
        binding = mint_session_binding(request, user, metadata, form_data.get('model')) if request is not None else None
        if binding:
            machine = await mint_machine_binding(request, user, metadata, form_data.get('model'))
            if machine:
                binding['machine'] = machine
            client.headers['x-agent-loopback-binding'] = json.dumps(binding)
        session_info = await ensure_session(client, chat_id, head or None)

        if session_info.get('running'):
            # Steering (issue 6): the run continues in place on its own
            # stream; this request posts to the steer route and completes.
            # The send-during-generation UI change lands in PR10. Checked
            # before the fork decision: a send during a run never rewinds.
            steered = False
            try:
                disposition = await steer_session(client, chat_id, prompt_text)
                steered = True
            except httpx.HTTPStatusError as e:
                if e.response.status_code != 409:
                    raise
                # Race (issue 32): the run ended between the running check
                # and the steer post, so the sidecar steer route answers 409
                # and an unhandled post would fail a send whose message is
                # already persisted. Re-read the session once: a send after
                # run-end is just a new turn, so fall through to the prompt
                # path below with the fresh state; a session running again
                # gets one steer retry.
                session_info = await ensure_session(client, chat_id, head or None)
                if session_info.get('running'):
                    disposition = await steer_session(client, chat_id, prompt_text)
                    steered = True
            if steered:
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

        # The per-turn handoff (PR6, issues 22/23/20): model, provider
        # expression, header map, and params resolve fresh every message and
        # ride the prompt; the key never crosses here — the sidecar fetches
        # it at the moment of use through the binding-authenticated key
        # route.
        from open_webui.routers.agent_runtime import build_turn_envelope

        turn = await build_turn_envelope(request, user, form_data, metadata)

        max_turns = getattr(request.state, 'max_tool_call_iterations', None)

        async def sse_stream() -> AsyncIterator[str]:
            translator = PiEventTranslator()
            try:
                async for event, data in stream_sidecar_events(
                    client, chat_id, prompt_text, tool_approval, turn, max_turns
                ):
                    async for line in translator.translate(event, data):
                        yield line
                    for line in translator.flush_lines():
                        yield line
                yield translator.final_line()
                yield 'data: [DONE]\n\n'

            # The code interpreter rides the bridge (PR7): an execute_code tool
            # turn streams its execution output as native code_interpreter
            # deltas so the "Analyzed" block grows live, instead of a single
            # final tool result frame.
            except CodeInterpreterStreamError as ci_error:
                async for line in translator.translate('code_interpreter', ci_error.payload):
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
        # The translator frames a failed run as {'content': <string>} (and a
        # stream refusal carries the same shape on e.detail); the caller that
        # stores an error expects the string itself, so a nested dict would
        # render wrong in the chat record and in every error.content reader.
        if isinstance(error_content, dict):
            inner = error_content.get('content')
            error_content = (
                inner if isinstance(inner, str) else json.dumps(inner if inner is not None else error_content)
            )
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
