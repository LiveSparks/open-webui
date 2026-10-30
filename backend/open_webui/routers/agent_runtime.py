"""Per-turn model, key, and header handoff (PR6): the OWUI side of the seam.

The model-handoff decision (issue 22) and the headers decision (issue 23) fix
the shape: every message the backend resolves the chat's model, its provider
settings, and its header map fresh, and hands the sidecar the resolved
envelope; the key never leaves OWUI — the sidecar dials the key route below
through the same short-TTL signed session binding the tool bridge uses, each
time pi is about to call a provider, and the answer crosses only at the
moment of use.

Three responsibilities live here:

- `build_turn_envelope` (called from the agent router per turn) resolves the
  turn's model expression — a built-in provider pair when pi ships the
  connection's provider (matched against the sidecar's catalog, which also
  carries each model's thinking ladder), a synthesized custom provider entry
  from the connection's stored settings otherwise — plus the resolved header
  map (OWUI's OpenRouter attribution overriding pi's own, per-connection
  custom template headers with their variables filled in server-side, and the
  opt-in user-info forwarding headers) and the resolved body params.
- `POST /loopback/agent/key` is the `getApiKey` target: the sidecar asks
  "key for this connection, this session, now" and the answer is read from
  the connection store fresh, so an admin rotation is the next call.
- `get_sidecar_catalog` fetches and caches the sidecar's provider catalog —
  the pi catalog knowledge (providers, base URLs, thinking ladders) the
  backend needs for the built-in-vs-synthesized decision and the effort
  ladder (issue 20).

The sidecar never sees raw connection settings: templates and attribution are
resolved here, and a synthesized entry carries only the base URL, wire shape,
and model list a provider call needs — never a key.
"""

import hashlib
import logging
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request

from open_webui.loopback_mcp import loopback_url, verify_session_binding

log = logging.getLogger(__name__)

router = APIRouter()

# How long the sidecar catalog cache lives. A restart of the sidecar (new
# models.json) is visible after at most this, without a fetch per turn.
CATALOG_TTL_S = int(__import__('os').environ.get('AGENT_PROVIDER_CATALOG_TTL_S', '300') or 300)

_catalog_cache: dict[str, Any] = {'at': 0.0, 'providers': []}


def _loopback_base(request: Request) -> str:
    """The loopback base the binding URL shares with the key route."""
    return loopback_url(request).rsplit('/loopback/mcp', 1)[0]


# ---------------------------------------------------------------------------
# Sidecar catalog (pi's provider knowledge, cached)
# ---------------------------------------------------------------------------


async def get_sidecar_catalog(request: Request) -> list[dict]:
    """The sidecar's provider catalog, cached for CATALOG_TTL_S.

    An unreachable sidecar degrades to an empty catalog: every connection
    then resolves through the synthesized path, which is still correct.
    """
    from open_webui.routers.agent import sidecar_base_url

    base = sidecar_base_url()
    now = time.monotonic()
    if base and now - _catalog_cache['at'] < CATALOG_TTL_S and _catalog_cache['providers']:
        return _catalog_cache['providers']
    providers: list[dict] = []
    if base:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(f'{base}/catalog')
                response.raise_for_status()
                providers = response.json().get('providers') or []
        except Exception as e:
            log.warning('agent handoff: sidecar catalog fetch failed (%s); falling back to synthesis', e)
    if providers:
        _catalog_cache.update(at=now, providers=providers)
    return providers


def _norm_base_url(url: str) -> str:
    return (url or '').rstrip('/')


def _find_builtin_provider(providers: list[dict], url: str, model_id: str) -> dict | None:
    for provider in providers:
        if _norm_base_url(provider.get('baseUrl') or '') != _norm_base_url(url):
            continue
        if any(model.get('id') == model_id for model in provider.get('models') or []):
            return provider
    return None


# ---------------------------------------------------------------------------
# The per-turn envelope
# ---------------------------------------------------------------------------


async def build_turn_envelope(request: Request, user: Any, form_data: dict, metadata: dict) -> dict:
    """The per-turn handoff envelope (issues 22, 23, and 20).

    Model, provider settings, key handling, and headers resolve fresh here —
    nothing about a provider is cached between turns on this side either.
    """
    from open_webui.utils.anthropic import is_anthropic_url
    from open_webui.utils.headers import get_headers_and_cookies
    from open_webui.utils.model_ids import strip_provider_model_prefix

    model_id = form_data.get('model') or ''
    url, key, api_config, base_model_id = await _resolve_turn_connection(request, user, model_id)
    upstream_model_id = strip_provider_model_prefix(base_model_id, api_config.get('prefix_id'))

    providers = await get_sidecar_catalog(request)
    builtin = _find_builtin_provider(providers, url, upstream_model_id)
    envelope: dict[str, Any] = {}
    if builtin is not None:
        # pi ships the connection's provider: its catalog owns base URL,
        # request shape, and the thinking-level map (issue 22, decision 2).
        envelope['model'] = {'provider': builtin['id'], 'id': upstream_model_id}
    else:
        # Synthesized custom provider entry: the resolved expression of the
        # connection, content-addressed so equal gateways share one
        # registration on the sidecar.
        synth_id = f'owui-synth-{hashlib.sha256(_norm_base_url(url).encode()).hexdigest()[:8]}'
        envelope['model'] = {'provider': synth_id, 'id': upstream_model_id}
        envelope['provider'] = {
            'id': synth_id,
            'name': 'Open WebUI connection',
            'baseUrl': url,
            'api': 'anthropic-messages' if is_anthropic_url(url) else 'openai-completions',
            'authHeader': True,
            'models': [
                {
                    'id': upstream_model_id,
                    'name': upstream_model_id,
                    'reasoning': False,
                    'input': ['text'],
                    # The native loop sends reasoning_effort for the effort
                    # param on OpenAI-compatible connections; so does pi's
                    # adapter for the synthesized entry.
                    'compat': {'supportsReasoningEffort': True},
                }
            ],
        }

    # The resolved header map (issue 23): attribution, custom template
    # headers with variables filled in server-side, user-info forwarding.
    # The Authorization header is stripped — the key travels per call through
    # the key route, never inside the map. Cookies do not cross (issue 23, Q5).
    headers, _cookies = await get_headers_and_cookies(
        request, url, key=key, config=api_config, metadata=metadata, user=user
    )
    headers.pop('Authorization', None)
    headers.update(openrouter_attribution_override(url))
    envelope['headers'] = headers

    # The resolved body params (Chat Controls + custom_params), stashed by
    # apply_params_to_form_data; the effort param becomes the between-turn
    # thinking level (issue 20) and does not merge into the body.
    params: dict = dict(form_data.pop('agent_params', None) or {})
    effort = params.pop('reasoning_effort', None)
    thinking_level = _map_thinking_level(effort)
    if thinking_level:
        envelope['thinkingLevel'] = thinking_level
    if params:
        envelope['params'] = params

    envelope['keyUrl'] = f'{_loopback_base(request)}/loopback/agent/key'
    return envelope


THINKING_LEVELS = {'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}


def openrouter_attribution_override(url: str) -> dict:
    """OWUI's attribution on an OpenRouter connection (issue 23, Q1).

    `get_headers_and_cookies` already carries HTTP-Referer/X-Title; the null
    values here delete pi's own telemetry-gated attribution on the sidecar
    (a null header deletes the default in pi's merge), so OpenRouter sees the
    same calling app it sees today.
    """
    if 'openrouter.ai' not in (url or ''):
        return {}
    return {'X-OpenRouter-Title': None, 'X-OpenRouter-Categories': None}


def _map_thinking_level(effort: Any) -> str | None:
    """The stored `reasoning_effort` value on pi's ladder; None stays truly unset.

    Old stored values like 'none' read as 'off' (issue 20). Unknown values are
    dropped with a log rather than guessed.
    """
    if not isinstance(effort, str) or not effort.strip():
        return None
    level = effort.strip().lower()
    if level == 'none':
        return 'off'
    if level in THINKING_LEVELS:
        return level
    log.warning('agent handoff: dropping unknown reasoning_effort %r', effort)
    return None


# ---------------------------------------------------------------------------
# The sidecar's getApiKey target
# ---------------------------------------------------------------------------


@router.post('/key')
async def resolve_turn_key(request: Request):
    """Answer one sidecar key fetch: "key for this connection, this session, now".

    Authenticated with the same short-TTL signed session binding the tool
    bridge uses; the claims carry the chat, the user, and the turn's model.
    The key is read from the connection store fresh — an admin rotation is
    the next call — and crosses only on the wire, never stored on the sidecar.
    """
    from open_webui.models.users import Users
    from open_webui.utils.headers import get_headers_and_cookies

    token = (request.headers.get('authorization') or '').removeprefix('Bearer ').strip()
    if not token:
        raise HTTPException(status_code=401, detail='binding token missing')
    claims = verify_session_binding(token)

    user = await Users.get_user_by_id(claims['user_id'])
    if user is None:
        raise HTTPException(status_code=401, detail='binding user no longer exists')

    model_id = claims.get('model_id') or ''
    if not model_id:
        raise HTTPException(status_code=400, detail='binding carries no model')
    url, key, api_config, _base_model_id = await _resolve_turn_connection(request, user, model_id)

    metadata = {
        'chat_id': claims.get('chat_id') or '',
        'message_id': claims.get('message_id') or '',
        'model_id': model_id,
    }
    # Reuse the native loop's token resolution (bearer/none/session/oauth/
    # azure) by reading the Authorization it builds; the map itself is not
    # used on this route.
    headers, _cookies = await get_headers_and_cookies(
        request, url, key=key, config=api_config, metadata=metadata, user=user
    )
    api_key = headers.get('Authorization', '').removeprefix('Bearer ').strip()
    return {'ok': True, 'apiKey': api_key or None}


async def _resolve_turn_connection(request: Request, user: Any, model_id: str) -> tuple[str, str, dict, str]:
    """The connection a chat turn resolves to: (base url, key, api config, upstream model id).

    A workspace preset wraps a direct-connection model through base_model_id;
    the connection and the upstream model id come from that base model row,
    the same resolution the native loop's openai router performs.
    """
    from open_webui.routers.openai import get_all_models, get_openai_connection

    async def base_row() -> tuple[dict, str]:
        model = request.app.state.MODELS.get(model_id) or {}
        base_model_id = (model.get('info') or {}).get('base_model_id') or model_id
        openai_models = getattr(request.app.state, 'OPENAI_MODELS', None) or {}
        row = openai_models.get(base_model_id) or {}
        return row, base_model_id

    base, base_model_id = await base_row()
    if 'urlIdx' not in base:
        # An admin connection save clears the registry cache; repopulate once.
        await get_all_models(request, user=user)
        base, base_model_id = await base_row()
    if 'urlIdx' not in base:
        raise HTTPException(status_code=400, detail=f'model {model_id} does not resolve to a direct connection.')
    url, key, api_config = await get_openai_connection(base['urlIdx'])
    return url, key, api_config, base_model_id
