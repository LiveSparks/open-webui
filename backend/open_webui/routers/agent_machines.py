"""Machine loopback executor (PR5): pi's local tools rebound to the selected machine.

The machine-binding decision (issue 8, ADR 0002): pi's `bash`, `read`, `edit`,
and `write` run on the machine the chat selected, never on the sidecar. The
sidecar's rebound tool operations call this endpoint; every call re-resolves
the machine from the binding's claims, then forwards through the same
`execute_tool_server` client the native loop uses, so auth headers, group
access, and the connection's own sanitization stay owned by OWUI. The sidecar
learns this endpoint's loopback URL and a short-TTL token; it never learns a
machine URL or key.

Fail closed, both ends: a turn with no machine selected mints no machine
binding, so the sidecar binds no local tools at all; a selection that points
at a machine that is gone, disabled, or inaccessible is refused with a clear
status at mint time (the turn errors) and again here (the call errors).

Wire shape: one JSON call per operation, `{"op": "bash" | "read" | "write",
...args}`. `edit` is not an operation of its own — pi's edit tool is built on
read and write operations and reuses them. Paths arrive already stripped of
the per-chat root the sidecar resolves against, so a machine-relative path
lands in the machine's per-chat session directory (`X-Session-Id`), and an
absolute path escapes it deliberately.
"""

import json
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from open_webui.loopback_mcp import (
    BINDING_TTL_S,
    _b64url,
    _signature,
    verify_session_binding,
)
from open_webui.utils.terminals import (
    TERMINAL_CONTEXT_HEADER,
    resolve_turn_machine,
    terminal_context_id,
    verify_selected_machine,
)

log = logging.getLogger(__name__)

router = APIRouter()

MACHINE_EXECUTOR_MAX_WAIT_S = 300

# pi op -> the machine tool (operationId) that executes it.
OP_TO_OPERATION = {'bash': 'run_command', 'read': 'read_file', 'write': 'write_file'}


def machine_executor_url(request: Request) -> str:
    """The executor URL the sidecar dials for machine-bound sessions.

    Same address discipline as the MCP bridge URL: the request's own base,
    or AGENT_LOOPBACK_URL with its bridge suffix swapped for this router's.
    """
    override = os.environ.get('AGENT_LOOPBACK_URL', '').strip()
    if override:
        base = override.rstrip('/').removesuffix('/loopback/mcp')
    else:
        base = str(request.base_url).rstrip('/')
    return f'{base}/loopback/machines'


def _sign_claims(claims: dict) -> str:
    payload = _b64url(json.dumps(claims, separators=(',', ':')).encode('utf-8'))
    return f'{payload}.{_signature(payload.encode("ascii"))}'


async def mint_machine_binding(request: Request, user: Any, metadata: dict, model_id: str | None) -> dict | None:
    """The machine binding for one agent turn, or None when no machine applies.

    Resolves the turn's machine server-side: the chat metadata's selection
    first, else the model's scoped default terminal. A selection that points
    at a gone, disabled, or inaccessible machine raises a clear 404/403 so the
    turn fails closed with a status instead of running somewhere else.
    """
    machine_id = await resolve_turn_machine(request, user, metadata or {}, model_id)
    if not machine_id:
        return None
    now = int(time.time())
    token = _sign_claims(
        {
            'chat_id': (metadata or {}).get('chat_id') or '',
            'user_id': getattr(user, 'id', None) or (user.get('id') if isinstance(user, dict) else '') or '',
            'terminal_id': machine_id,
            'iat': now,
            'exp': now + BINDING_TTL_S,
        }
    )
    return {'url': machine_executor_url(request), 'token': token}


@router.post('')
@router.post('/')
async def execute_machine_op(request: Request):
    """One machine operation for a machine-bound pi session."""
    auth = request.headers.get('authorization', '')
    token = auth.removeprefix('Bearer ').strip() if auth.startswith('Bearer ') else ''
    if not token:
        raise HTTPException(status_code=401, detail='missing machine binding token')
    claims = verify_session_binding(token)

    chat_id = claims.get('chat_id') or ''
    terminal_id = claims.get('terminal_id') or ''
    if not chat_id or not terminal_id:
        raise HTTPException(status_code=401, detail='binding carries no machine binding')

    try:
        body = json.loads((await request.body()) or b'null')
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail='invalid JSON body')
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail='expected one JSON operation')

    op = body.get('op')
    operation = OP_TO_OPERATION.get(op) if isinstance(op, str) else None
    if not operation:
        raise HTTPException(status_code=400, detail=f'unsupported machine operation: {op}')

    connection = await verify_selected_machine(request, claims['user_id'], terminal_id)

    from open_webui.utils.tools import (
        build_tool_server_headers,
        execute_tool_server,
        get_terminal_server_url,
        get_terminal_servers,
    )

    params: dict[str, Any] = {}
    if op == 'bash':
        command = body.get('command')
        if not isinstance(command, str) or not command.strip():
            raise HTTPException(status_code=400, detail='machine bash needs a command')
        params['command'] = command
        timeout = body.get('timeout')
        if isinstance(timeout, (int, float)) and timeout > 0:
            params['wait'] = min(float(timeout), MACHINE_EXECUTOR_MAX_WAIT_S)
    elif op == 'read':
        path = body.get('path')
        if not isinstance(path, str) or not path.strip():
            raise HTTPException(status_code=400, detail='machine read needs a path')
        params['path'] = path
    else:
        path, content = body.get('path'), body.get('content')
        if not isinstance(path, str) or not path.strip() or not isinstance(content, str):
            raise HTTPException(status_code=400, detail='machine write needs a path and content')
        params = {'path': path, 'content': content}

    user_model = await _claims_user(claims['user_id'])
    headers, cookies = await build_tool_server_headers(connection, request, user_model, metadata={'chat_id': chat_id})
    headers['Content-Type'] = 'application/json'
    headers['X-User-Id'] = user_model.id
    headers['X-Session-Id'] = chat_id
    context_id = terminal_context_id(connection, {'chat_id': chat_id}, 'chat')
    if context_id:
        headers[TERMINAL_CONTEXT_HEADER] = context_id

    server_data = next(
        (server for server in await get_terminal_servers(request) if server.get('id') == terminal_id), None
    )
    if server_data is None:
        raise HTTPException(status_code=404, detail='the selected machine is unavailable')

    result, _response_headers = await execute_tool_server(
        url=get_terminal_server_url(connection),
        headers=headers,
        cookies=cookies,
        name=operation,
        params=params,
        server_data=server_data,
    )
    if isinstance(result, dict) and result.get('error'):
        # execute_tool_server wraps transport and routing failures in {'error': ...}.
        raise HTTPException(status_code=502, detail=f'machine operation failed: {result["error"]}')
    return {'ok': True, 'result': result}


async def _claims_user(user_id: str):
    from open_webui.models.users import Users

    user = await Users.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=401, detail='binding user no longer exists')
    return user
