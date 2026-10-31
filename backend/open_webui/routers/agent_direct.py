"""Direct OpenAPI tools relay into the pi loop through the user's browser (PR13).

Per-user direct connections were the one tool-server kind the loopback bridge
could not carry: the bridge presumes backend-side execution, and a direct
connection's key lives in the user's browser, so OWUI has nothing to dial with.
The direct-connections decision (issue 15) closes the gap in the direction the
facts allow: a direct server's tools join the pi loop day one by bridging
through the same loopback MCP bridge, and execution relays to the user's
browser over the existing Socket.IO event (`execute:tool`) — the same relay
today's native loop uses, with no new auth and no key-custody change.

This module owns the relay's backend side:

- **The claims stay OWUI-blind.** A connection's key never reaches the backend,
  so the turn's direct entries ride the binding as a slim key-free map (name →
  spec + server URL) and the relayed event carries only what the browser dials
  with — the URL, and the browser resolves its own token from its own settings.
- **Built-ins never take a browser-held connection.** An entry whose name would
  shadow a resolved builtin is refused here, before any relay exists, and the
  bridge merges the relays before the builtin fill, so a builtin's callable
  always wins its name.
- **Ownership per-user, context per-chat.** The relay rides the binding's
  identifiers: `get_event_call` targets only the emitting user's own live tab
  for that chat, and a binding without the turn's selection carries nothing.
- **Failures translate the ordinary way.** A relay the browser cannot take answers
  byte-for-byte what the native loop's direct arm answers, and a browser-reported
  error crosses verbatim, for the ordinary tool-failure paths to surface.

The browser side needs nothing: `execute:tool` lands on the tab's existing
`executeTool` handler (`src/routes/+layout.svelte`), which already resolves the
connection and its key client-side.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable
from uuid import uuid4

log = logging.getLogger(__name__)

# The native loop's direct arm answers a relayed call with this exact string
# when no browser session could be resolved for the turn, and the parity
# module asserts that byte equality at the arm itself — so this literal must
# not drift from middleware's `execute_tool_call` direct branch.
NO_BROWSER_SESSION_RESULT = 'Error: Browser session is not connected for this direct tool.'

# The claims key under which the turn's direct entries ride the binding.
DIRECT_TOOLS_CLAIM_KEY = 'direct_tools'


def slim_server_view(server: dict) -> dict:
    """The relayed server view: an allowlist, not a copy.

    A re-strip, not a convenience: the chat body a client sends already carries
    URL and specs only, but an entry is never trusted to stay that shape — the
    relay's payload is rebuilt from the fields the browser needs, so no key or
    auth material can ride it even if a client shape ever gains one.
    """
    view = {'url': server.get('url') or ''}
    if server.get('is_terminal') is True:
        view['is_terminal'] = True
    return view


def slim_direct_tools(metadata: dict) -> dict[str, dict]:
    """The turn's direct tool entries as a slim, key-free claims map.

    Source of truth is the turn's resolved tool surface (middleware's
    `tools_dict`): the entries it flagged `direct` — direct OpenAPI and direct
    terminal tool servers, whose execution happens in the user's browser. Each
    rides the signed binding as spec + slim server view; OWUI never carries a
    key for these, so none crosses.
    """
    carried: dict[str, dict] = {}
    for name, tool_dict in sorted((metadata.get('tools') or {}).items()):
        if not isinstance(tool_dict, dict) or tool_dict.get('direct') is not True:
            continue
        spec = tool_dict.get('spec')
        if not isinstance(spec, dict) or not isinstance(spec.get('name'), str) or not spec['name']:
            continue
        server = tool_dict.get('server')
        if not isinstance(server, dict):
            continue
        carried[name] = {
            'spec': dict(spec),
            'server': slim_server_view(server),
        }
    return carried


def make_browser_relay(
    name: str,
    spec: dict,
    server_view: dict,
    event_caller: Callable[[dict], Awaitable[Any]] | None,
    session_id: str,
) -> Callable[..., Awaitable[Any]]:
    """The backend-side executor of one direct tool: relays to the browser.

    The event shape and the result handling mirror the native loop's direct arm
    (`execute_tool_call`) exactly — the browser answers `execute:tool` through
    the ordinary bubble, and a relay the browser cannot take fails the
    ordinary way, byte-for-byte.
    """

    async def execute(**params: Any) -> Any:
        allowed_params = (spec.get('parameters', {}).get('properties') or {}).keys()
        relayed = {key: value for key, value in params.items() if key in allowed_params}
        if event_caller is None:
            return NO_BROWSER_SESSION_RESULT
        try:
            return await event_caller(
                {
                    'type': 'execute:tool',
                    'data': {
                        'id': str(uuid4()),
                        'name': name,
                        'params': relayed,
                        'server': dict(server_view),
                        'session_id': session_id,
                    },
                }
            )
        except Exception as e:
            return {'error': str(e)}

    return execute


def build_relay_tools(
    claims: dict,
    event_caller: Callable[[dict], Awaitable[Any]] | None,
    builtin_names: set[str] | None = None,
) -> dict[str, dict]:
    """The bridge tool entries for the binding's direct servers.

    Each entry is shaped like the native loop's direct entry (spec, direct
    flag, server view) plus the callables that make the entry bridgeable: the
    browser relay. Where the native loop leaves direct entries callable-less
    and unbridgeable, these carry the relay, so `_mcp_tools_payload` lists
    them and `_call_tool` reaches the user's tab.

    A name that would shadow a resolved builtin is refused: pi's built-ins
    never bind to a direct connection (issue 15, decision 2) — a colliding
    terminal-only entry dies at build time with a log, never as a live relay.
    """
    builtin_names = builtin_names if builtin_names is not None else set()
    carried = claims.get(DIRECT_TOOLS_CLAIM_KEY)
    if not isinstance(carried, dict):
        return {}
    tools: dict[str, dict] = {}
    for name, entry in sorted(carried.items()):
        if not isinstance(entry, dict):
            continue
        spec = entry.get('spec')
        server = entry.get('server')
        server_view = slim_server_view(server) if isinstance(server, dict) else {}
        if not isinstance(spec, dict) or not server_view.get('url'):
            continue
        if name in builtin_names:
            log.warning('agent direct relay: refusing builtin name %s from a direct connection', name)
            continue
        tools[name] = {
            'spec': dict(spec),
            'direct': True,
            'server': server_view,
            'callable': make_browser_relay(name, spec, server_view, event_caller, claims.get('session_id') or ''),
        }
    return tools
