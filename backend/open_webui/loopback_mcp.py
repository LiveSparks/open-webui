"""Loopback MCP server (PR4): OWUI's own capabilities as MCP tools for the sidecar.

The tool-bridge decision (issue 7) fixed the mechanism: one loopback MCP server
hosted by the FastAPI backend, consumed by pi through its MCP extension, with
no `mcp.json` — the sidecar hands each session its own bridge entry with a
session token in headers. This module is the server side.

Auth is a short-TTL signed session binding minted at chat start
(`mint_session_binding`, called from the agent router). Every bridge call
carries the token; the server verifies the signature and expiry, then
re-resolves chat -> user -> model -> tool gating (`get_tools`, MCP relay,
`get_builtin_tools`) with the same functions the native Python loop uses, so
access control, valves, and per-tool auth stay owned by OWUI. Credentials
never leave the backend; a compromised sidecar holds one binding, not an
identity.

Exposure (direct vs deferred) is the sidecar's `toolExposure` config per the
bridge decision; this server lists everything the resolved tool set carries and
never sees the exposure split.

Wire protocol: streamable HTTP, single JSON responses per request (the
sidecar's transport accepts `application/json`), notifications answered 202,
the server-to-client GET stream refused with 405. State by design: no
`Mcp-Session-Id`, nothing cached between requests — each call re-resolves.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from open_webui.env import WEBUI_SECRET_KEY
from open_webui.utils.json_codec import JSONCodec

log = logging.getLogger(__name__)

router = APIRouter()

MCP_SERVER_NAME = 'owui'
SERVER_INFO = {'name': MCP_SERVER_NAME, 'version': '1.0.0'}
SERVER_INSTRUCTIONS = (
    "Open WebUI's own capabilities: memory, knowledge bases, chat files, web "
    'search, image generation, code execution, workspace tools, and relayed '
    "MCP servers. All calls run as the driving user with OWUI's own access "
    'control.'
)
# The client (pi-mcp) supports these; echo the requested one when we know it.
SUPPORTED_PROTOCOL_VERSIONS = {'2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'}
LATEST_PROTOCOL_VERSION = '2025-11-25'

BINDING_TTL_S = int(os.environ.get('AGENT_LOOPBACK_BINDING_TTL_S', '1800') or 1800)

# Builtins whose contract is a live browser websocket (the approval card and
# the terminal), not a loopback call. The sidecar owns the ask flow; PR5 owns
# machines.
BRIDGE_EXCLUDED_TOOLS = {'ask_user', 'play_animation'}

JSON_RPC_PARSE_ERROR = -32700
JSON_RPC_METHOD_NOT_FOUND = -32601
JSON_RPC_INVALID_PARAMS = -32602
JSON_RPC_INTERNAL_ERROR = -32603


# ---------------------------------------------------------------------------
# Signed session binding
# ---------------------------------------------------------------------------


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _from_b64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def _signature(payload: bytes) -> str:
    return hmac.new(WEBUI_SECRET_KEY.encode('utf-8'), payload, hashlib.sha256).hexdigest()


def _user_id_of(user: Any) -> str:
    return getattr(user, 'id', None) or (user.get('id') if isinstance(user, dict) else '') or ''


def loopback_url(request: Request) -> str:
    """The bridge URL the sidecar dials for this session.

    The request's own address is right wherever the sidecar can reach the
    backend the way the chat reached it (the same host in the packaged shape).
    AGENT_LOOPBACK_URL overrides it for deployments where the sidecar must
    dial a different interface.
    """
    override = os.environ.get('AGENT_LOOPBACK_URL', '').strip()
    if override:
        return override
    base = str(request.base_url).rstrip('/')
    return f'{base}/loopback/mcp'


def _selected_direct_tools(metadata: dict) -> list[str]:
    """Names of the turn's user-selected tools that should be declared direct.

    The Tools registry entries (and direct tool servers) the chat attached are
    deliberate choices, so they ride the binding as direct exposure; the MCP
    relay stays deferred behind discovery per the bridge decision.
    """
    resolved = metadata.get('tools') or {}
    return sorted(
        name
        for name, tool_dict in resolved.items()
        if isinstance(tool_dict, dict) and tool_dict.get('type') != 'mcp' and 'spec' in tool_dict
    )


def mint_session_binding(request: Request, user: Any, metadata: dict, model_id: str | None = None) -> dict:
    """Mint the short-TTL binding for one agent turn.

    Claims carry the identifiers the bridge re-resolves per call (chat, user,
    model, message, websocket session) plus the turn's tool selection and
    attached files, so a bridge call reconstructs the same tool surface the
    native loop built for the turn. Signed with the backend's secret key; the
    sidecar never sees it.
    """
    now = int(time.time())
    claims = {
        'chat_id': metadata.get('chat_id') or '',
        'user_id': _user_id_of(user),
        'message_id': metadata.get('message_id') or '',
        'session_id': metadata.get('session_id') or '',
        'model_id': model_id or '',
        'tool_ids': metadata.get('tool_ids') or [],
        'files': metadata.get('files') or [],
        'features': metadata.get('features') or {},
        'iat': now,
        'exp': now + BINDING_TTL_S,
    }
    payload = _b64url(json.dumps(claims, separators=(',', ':')).encode('utf-8'))
    token = f'{payload}.{_signature(payload.encode("ascii"))}'
    # The sidecar declares these names direct; they ride the binding, not the
    # signed payload, since they steer exposure only.
    return {'url': loopback_url(request), 'token': token, 'direct': _selected_direct_tools(metadata)}


def verify_session_binding(token: str) -> dict:
    """Verify a binding token and return its claims, or refuse with 401."""
    try:
        payload, signature = token.split('.', 1)
    except ValueError:
        raise HTTPException(status_code=401, detail='malformed binding token')
    if not hmac.compare_digest(signature, _signature(payload.encode('ascii'))):
        raise HTTPException(status_code=401, detail='binding token signature mismatch')
    try:
        claims = json.loads(_from_b64url(payload))
    except Exception:
        raise HTTPException(status_code=401, detail='malformed binding token')
    if not isinstance(claims, dict) or not claims.get('user_id'):
        raise HTTPException(status_code=401, detail='malformed binding token')
    if int(claims.get('exp') or 0) < int(time.time()):
        raise HTTPException(status_code=401, detail='binding token expired')
    return claims


# ---------------------------------------------------------------------------
# Tool surface: what the native loop would have built for this turn.
# ---------------------------------------------------------------------------


def make_relay_callable(client, function_name):
    async def tool_function(**kwargs):
        return await client.call_tool(function_name, function_args=kwargs)

    return tool_function


async def _relay_tools(request: Request, mcp_tool_ids: list[str], user: Any, extra_params: dict) -> tuple[dict, list]:
    """Resolve OWUI's MCP client connections into bridged tools (the relay).

    The backend dials the external MCP servers — it owns the per-user OAuth and
    headers — and the sidecar reaches them through this bridge only, per the
    bridge decision. Returns the tool entries and the open clients so the
    dispatcher can close them in the same task that opened them.
    """
    from open_webui.utils.tools import connect_mcp_server

    tools: dict[str, dict] = {}
    clients: list = []
    for tool_id in mcp_tool_ids:
        server_id = tool_id[len('server:mcp:') :]
        connected = await connect_mcp_server(request, server_id, user, extra_params)
        if connected is None:
            continue
        client, tool_specs = connected
        clients.append(client)
        for tool_spec in tool_specs:
            function_name = tool_spec['name']
            tool_name = f'{server_id}_{function_name}'
            tools[tool_name] = {
                'spec': {**tool_spec, 'name': tool_name},
                'callable': make_relay_callable(client, function_name),
                'type': 'mcp',
            }
    return tools, clients


async def resolve_bridge_tools(request: Request, claims: dict) -> tuple[dict[str, dict], list]:
    """The tools_dict this turn would carry, rebuilt from the binding claims.

    Same resolution order as `process_chat_payload`: the Tools registry and
    tool servers via `get_tools`, the MCP relay, then builtins filling names
    not taken. Entries without a callable (direct tool servers executed
    client-side) never bridge.
    """
    from open_webui.models.chats import Chats
    from open_webui.models.models import Models
    from open_webui.models.users import Users
    from open_webui.utils.middleware import get_event_emitter_and_caller
    from open_webui.utils.tools import get_builtin_tools, get_tools

    user = await Users.get_user_by_id(claims['user_id'])
    if user is None:
        raise HTTPException(status_code=401, detail='binding user no longer exists')
    chat_id = claims.get('chat_id') or ''
    if chat_id and await Chats.get_chat_by_id(chat_id) is None:
        raise HTTPException(status_code=401, detail='binding chat no longer exists')

    model_id = claims.get('model_id') or ''
    # The same assembled model dict the native loop used (info.meta carries the
    # capabilities the builtin gating reads); fall back to a fresh DB read.
    model = (getattr(request.app.state, 'MODELS', {}) or {}).get(model_id)
    if model is None and model_id:
        model_row = await Models.get_model_by_id(model_id)
        if model_row is not None:
            model = {
                'id': model_row.id,
                'name': model_row.name,
                'base_model_id': model_row.base_model_id,
                'info': model_row.model_dump(),
            }

    metadata = {
        'chat_id': chat_id,
        'message_id': claims.get('message_id') or '',
        'session_id': claims.get('session_id') or '',
        'model_id': model_id,
        'files': claims.get('files') or [],
    }
    event_emitter, event_caller = await get_event_emitter_and_caller(metadata)
    extra_params = {
        '__request__': request,
        '__user__': user.model_dump(),
        '__event_emitter__': event_emitter,
        '__event_call__': event_caller,
        '__metadata__': metadata,
        '__files__': metadata['files'],
        '__chat_id__': chat_id,
        '__message_id__': metadata['message_id'],
        '__model__': model,
        '__messages__': [],
    }

    tool_ids = [tool_id for tool_id in claims.get('tool_ids') or [] if isinstance(tool_id, str)]
    mcp_tool_ids = [tool_id for tool_id in tool_ids if tool_id.startswith('server:mcp:')]
    plain_tool_ids = [tool_id for tool_id in tool_ids if not tool_id.startswith('server:mcp:')]

    tools_dict = await get_tools(request, plain_tool_ids, user, extra_params)
    relay, clients = await _relay_tools(request, mcp_tool_ids, user, extra_params)
    tools_dict = {**tools_dict, **relay}
    builtin_tools = await get_builtin_tools(request, extra_params, claims.get('features') or {}, model)
    for name, tool_dict in builtin_tools.items():
        if name not in tools_dict:
            tools_dict[name] = tool_dict
    return tools_dict, clients


def _mcp_tools_payload(tools_dict: dict[str, dict]) -> list[dict]:
    tools = []
    for name, tool_dict in sorted(tools_dict.items()):
        if name in BRIDGE_EXCLUDED_TOOLS:
            continue
        callable = tool_dict.get('callable')
        spec = tool_dict.get('spec')
        if callable is None or not isinstance(spec, dict):
            # Direct tool servers execute client-side; nothing bridges.
            continue
        tools.append(
            {
                'name': spec.get('name', name),
                'description': spec.get('description', name),
                'inputSchema': spec.get('parameters', {'type': 'object', 'properties': {}}),
            }
        )
    return tools


# ---------------------------------------------------------------------------
# JSON-RPC dispatch
# ---------------------------------------------------------------------------


def _rpc_result(request_id: Any, result: Any) -> dict:
    return {'jsonrpc': '2.0', 'id': request_id, 'result': result}


def _rpc_error(request_id: Any, code: int, message: Any) -> dict:
    return {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': code, 'message': message}}


async def _call_tool(request: Request, claims: dict, request_id: Any, name: str, arguments: dict) -> dict:
    tools_dict, clients = await resolve_bridge_tools(request, claims)
    try:
        tool_dict = tools_dict.get(name)
        if tool_dict is None or tool_dict.get('callable') is None or name in BRIDGE_EXCLUDED_TOOLS:
            return _rpc_error(request_id, JSON_RPC_INVALID_PARAMS, f'tool not bridged: {name}')
        result = await tool_dict['callable'](**arguments)
        if not isinstance(result, str):
            result = JSONCodec.dumps(result, ensure_ascii=False)
        return _rpc_result(
            request_id,
            {'content': [{'type': 'text', 'text': result or 'done'}], 'isError': False},
        )
    except HTTPException:
        raise
    except Exception as e:
        log.exception('loopback mcp: tool %s failed', name)
        return _rpc_error(
            request_id,
            JSON_RPC_INTERNAL_ERROR,
            {'content': [{'type': 'text', 'text': f'tool failed: {e}'}], 'isError': True},
        )
    finally:
        for client in clients:
            try:
                await client.disconnect()
            except Exception:
                log.exception('loopback mcp: relay disconnect failed')


async def _dispatch(request: Request, claims: dict, message: dict) -> dict | None:
    """One JSON-RPC message -> result, error, or None for notifications."""
    method = message.get('method', '')
    request_id = message.get('id')
    params = message.get('params') or {}

    if method == 'initialize':
        requested = params.get('protocolVersion')
        protocol = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else LATEST_PROTOCOL_VERSION
        return _rpc_result(
            request_id,
            {
                'protocolVersion': protocol,
                'capabilities': {'tools': {'listChanged': False}},
                'serverInfo': SERVER_INFO,
                'instructions': SERVER_INSTRUCTIONS,
            },
        )
    if method == 'tools/list':
        tools_dict, clients = await resolve_bridge_tools(request, claims)
        try:
            return _rpc_result(request_id, {'tools': _mcp_tools_payload(tools_dict)})
        finally:
            for client in clients:
                try:
                    await client.disconnect()
                except Exception:
                    log.exception('loopback mcp: relay disconnect failed')
    if method == 'tools/call':
        name = params.get('name', '')
        arguments = params.get('arguments')
        if not isinstance(arguments, dict):
            arguments = {}
        return await _call_tool(request, claims, request_id, name, arguments)
    if method == 'ping':
        return _rpc_result(request_id, {})
    if request_id is None:
        # Notification we have no use for (initialized, cancelled, logging).
        return None
    return _rpc_error(request_id, JSON_RPC_METHOD_NOT_FOUND, f'method not supported: {method}')


@router.post('')
@router.post('/')
async def mcp_endpoint(request: Request):
    """The streamable-HTTP MCP endpoint for the sidecar's bridge connection."""
    auth = request.headers.get('authorization', '')
    token = auth.removeprefix('Bearer ').strip() if auth.startswith('Bearer ') else ''
    if not token:
        raise HTTPException(status_code=401, detail='missing binding token')
    claims = verify_session_binding(token)

    try:
        body = json.loads((await request.body()) or b'null')
    except json.JSONDecodeError:
        return JSONResponse(_rpc_error(None, JSON_RPC_PARSE_ERROR, 'invalid JSON body'), status_code=400)
    if not isinstance(body, dict):
        return JSONResponse(_rpc_error(None, JSON_RPC_PARSE_ERROR, 'expected one JSON-RPC message'), status_code=400)

    result = await _dispatch(request, claims, body)
    if result is None:
        # Notifications get no reply; 202 with an empty body.
        return Response(status_code=202)
    return JSONResponse(result)


@router.get('')
@router.get('/')
async def mcp_get_stream():
    """No server-to-client stream: this bridge is call-and-answer only."""
    return Response(status_code=405, content='loopback bridge opens no SSE stream')


@router.delete('')
@router.delete('/')
async def mcp_delete_session():
    # The transport deletes its session on close; stateless here, so nothing
    # to drop. Answer 200 so the client's close is clean.
    return Response(status_code=200)
