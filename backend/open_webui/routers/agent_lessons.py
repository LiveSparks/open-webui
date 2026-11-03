"""Agent self-learning loop — the OWUI lesson surfaces (PR11, ADR 0004, issue 14).

Three kinds of route live here:

- The user's review surface under `/api/v1/lessons`: list your own lessons,
  confirm one, delete one, and switch learning on or off per user (default on,
  like the admin default).
- The admin surface under `/api/v1/lessons/config` and
  `/api/v1/lessons/admin/summary`: every dial of the loop (witches, the
  reflection model, the relevance floor, the char budget, gates, caps) — so
  learning is dialed down or off without a rebuild — plus the handful of
  aggregates the decision calls for.
- The loopback surface under `/loopback/lessons`, dialed by the sidecar's
  learning hooks with the short-TTL session binding the tool bridge uses:
  `prepare` answers the per-turn retrieval query (dynamic injection — the
  relevance floor applies here; the sidecar applies the char budget and its
  per-turn dedup), `reflect` runs the post-turn reflection job against the
  admin-configured cheap model (credentials never leave OWUI: the model call
  happens here, never on the sidecar), and `ledger` persists the
  sidecar-computed confidence pulses before applying the write-and-invocation
  gates: graduation auto-drafts a Skill as a user-owned artifact and caps rot
  the weakest oldest lessons out.

No durable reflection runner: reflection is a short job, and a mid-job crash
waits for the next run. The observation log itself is sidecar-side (ADR 0004);
`reflect` receives one already-scrubbed observation per call.
"""

import json
import logging
import math
import os
import re
import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from open_webui.events import EVENTS, publish_event
from open_webui.internal.db import get_async_session
from open_webui.loopback_mcp import verify_session_binding
from open_webui.models.lessons import (
    LESSON_STATUS_ACTIVE,
    LESSON_STATUS_DROPPED,
    LESSON_STATUS_GRADUATED,
    LessonModel,
    LessonRecords,
    normalize_lesson_text,
)
from open_webui.models.users import Users
from open_webui.utils.auth import get_admin_user, get_verified_user
from open_webui.utils.chat_id import is_saved_chat_id
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

# The reflection model dials a deployed connection over the OpenAI wire.
REQUEST_TIMEOUT_S = 90.0

# The user-confirmation rule: deterministic, a fixed weight every confirm.
USER_CONFIRM_WEIGHT = 0.08

# Per-user lesson collection in the same vector store Knowledge uses; scoping
# is structural because the collection is per user.
COLLECTION_PREFIX = 'lesson-'

# The staleness rule at retrieval: confidence decays weekly (half-life),
# floored, so a lesson that stops earning evidence stops qualifying.
DECAY_HALF_LIFE_DAYS = 7.0

# The dotted store namespace every dial lives under, and its leading form.
NAMESPACE = 'agent.self_learning'
NAMESPACE_DOT = f'{NAMESPACE}.'

DEFAULTS: dict[str, Any] = {
    'agent.self_learning.enabled': os.environ.get('AGENT_SELF_LEARNING_ENABLED', 'true').lower() != 'false',
    'agent.self_learning.injection_floor': float(os.environ.get('AGENT_SELF_LEARNING_FLOOR', '0.35')),
    'agent.self_learning.confidence_floor': float(os.environ.get('AGENT_SELF_LEARNING_CONFIDENCE_FLOOR', '0.35')),
    'agent.self_learning.char_budget': int(os.environ.get('AGENT_SELF_LEARNING_CHAR_BUDGET', '1200')),
    'agent.self_learning.max_active_lessons': int(os.environ.get('AGENT_SELF_LEARNING_MAX_ACTIVE', '64')),
    'agent.self_learning.reflection_model': os.environ.get('AGENT_SELF_LEARNING_MODEL', ''),
    'agent.self_learning.gate_age_days': int(os.environ.get('AGENT_SELF_LEARNING_GATE_AGE_DAYS', '7')),
    'agent.self_learning.gate_confirmations': int(os.environ.get('AGENT_SELF_LEARNING_GATE_CONFIRMATIONS', '4')),
    'agent.self_learning.gate_confidence': float(os.environ.get('AGENT_SELF_LEARNING_GATE_CONFIDENCE', '0.75')),
    'agent.self_learning.base_confidence': float(os.environ.get('AGENT_SELF_LEARNING_BASE_CONFIDENCE', '0.5')),
}

# Deterministic correction markers: a user message carrying one is a
# correction signal, which the signal-scored reflection budget spends.
CORRECTION_PATTERN = re.compile(r'\b(wrong|incorrect|instead|mistake|correction|regression)\b', re.IGNORECASE)

QUIET_TURN_MARKS = re.compile(r'\b(error|failed|exception|traceback|denied|panic)\b', re.IGNORECASE)

# The reflection prompt speaks one shape; "keep the base" is always valid.
REFLECT_MARKER = 'OWUI_LESSON_REFLECT'
KEEP_THE_BASE = 'KEEP THE BASE'
LESSON_FIELDS = ('title', 'trigger', 'action')

TITLE_MAX_CHARS = 120
SECTION_MAX_CHARS = 420


############################
# Configuration
############################


async def learning_config() -> dict[str, Any]:
    """The loop's dials keyed short: 'injection_floor', not the full dotted
    store key. The environment defaults are overridden by whatever the admin
    persisted in the config store, whose rows carry the dotted keys."""
    from open_webui.models.config import Config

    config = dict(DEFAULTS)
    config.update(await Config.get_namespace(NAMESPACE))
    return {key.removeprefix(NAMESPACE_DOT): value for key, value in config.items() if key.startswith(NAMESPACE_DOT)}


async def config_get(key: str) -> Any:
    from open_webui.models.config import Config

    stored = await Config.get(key)
    return DEFAULTS.get(key) if stored is None else stored


def user_settings_of(user: Any) -> dict:
    """The user's settings as a plain dict: the column is JSON, but reads come
    back through the pydantic UserSettings model, not a mapping."""
    settings = getattr(user, 'settings', None)
    if settings is None or isinstance(settings, dict):
        return dict(settings or {})
    dump = getattr(settings, 'model_dump', None)
    return dict(dump()) if callable(dump) else dict(settings)


async def learning_enabled(user_id: str) -> bool:
    """On by default; the admin switch and the per-user switch both pass."""
    admin_on = await config_get('agent.self_learning.enabled')
    if not admin_on:
        return False
    user = await Users.get_user_by_id(user_id)
    if user is None:
        return False
    user_switch = user_settings_of(user).get('agentLearning', {})
    if isinstance(user_switch, dict):
        return bool(user_switch.get('enabled', True))
    return True


def effective_confidence(lesson: LessonModel, now: int | None = None) -> float:
    """The ledger's decay applied at retrieval: a lesson without fresh
    evidence loses confidence weekly, floored above rot."""
    now = now or int(time.time())
    age_days = max(0.0, (now - lesson.updated_at) / 86400.0)
    decayed = float(lesson.confidence) * math.pow(0.5, age_days / DECAY_HALF_LIFE_DAYS)
    return max(0.05, min(0.95, decayed))


############################
# Forms
############################


class LessonConfigUpdate(BaseModel):
    enabled: bool | None = None
    injection_floor: float | None = None
    confidence_floor: float | None = None
    char_budget: int | None = None
    max_active_lessons: int | None = None
    reflection_model: str | None = None
    gate_age_days: int | None = None
    gate_confirmations: int | None = None
    gate_confidence: float | None = None
    base_confidence: float | None = None


CONFIG_KEYS = {
    'enabled': 'agent.self_learning.enabled',
    'injection_floor': 'agent.self_learning.injection_floor',
    'confidence_floor': 'agent.self_learning.confidence_floor',
    'char_budget': 'agent.self_learning.char_budget',
    'max_active_lessons': 'agent.self_learning.max_active_lessons',
    'reflection_model': 'agent.self_learning.reflection_model',
    'gate_age_days': 'agent.self_learning.gate_age_days',
    'gate_confirmations': 'agent.self_learning.gate_confirmations',
    'gate_confidence': 'agent.self_learning.gate_confidence',
    'base_confidence': 'agent.self_learning.base_confidence',
}

USER_SWITCH_KEY = 'agentLearning'


class LessonSwitchUpdate(BaseModel):
    enabled: bool


class LessonPrepareForm(BaseModel):
    query: str
    activity: str = ''


class LessonReflectForm(BaseModel):
    user_text: str
    assistant_text: str = ''
    tool_calls: list[dict] = []
    injected_lesson_ids: list[str] = []
    outcome: str | None = None
    error: str | None = None


class LedgerPulse(BaseModel):
    lesson_id: str
    confidence: float
    confirmations: int
    contradictions: int
    injections: int = 0


class LedgerForm(BaseModel):
    updates: list[LedgerPulse]


############################
# Signal scoring
############################


def reflection_signals(user_text: str, error: str | None, tool_calls: list[dict]) -> dict:
    """The reflect job's budget driver: failures and user corrections spend
    it, quiet turns pay nothing. Deterministic text rules — the cheap model
    never grades itself (issue 14, decision 3)."""
    error_signal = bool(error) or any(isinstance(tool, dict) and tool.get('error') for tool in tool_calls or [])
    correction_signal = bool(CORRECTION_PATTERN.search(user_text or ''))
    mistake_signal = bool(QUIET_TURN_MARKS.search(user_text or ''))
    return {
        'error': bool(error_signal),
        'correction': correction_signal,
        'mistake': mistake_signal,
        'tools': len([tool for tool in tool_calls or [] if isinstance(tool, dict)]),
        'quiet': not (error_signal or correction_signal or mistake_signal),
    }


############################
# The cheap model call
############################


async def cheap_model_completion(
    request: Request, user_id: str, model_id: str, reflect_body: str
) -> tuple[str | None, str | None]:
    """One chat completion against the reflection model's connection.

    The connection resolver is PR6's own, so reflection and chat share one
    connection truth; the key is used here and dropped, never handed to the
    sidecar. The OpenAI wire streams; the delta text is all this reads.
    """
    from open_webui.routers.agent_runtime import _resolve_turn_connection

    try:
        user = await Users.get_user_by_id(user_id)
        url, key, _api_config, _base_model_id = await _resolve_turn_connection(request, user, model_id)
    except HTTPException as e:
        return None, str(e.detail)

    body = {
        'model': model_id,
        'messages': [
            {
                'role': 'system',
                'content': (
                    'You are the reflection step of Open WebUI\u2019s self-learning loop. '
                    'You read one observed chat turn and decide whether it teaches a lesson. '
                    'Reply with exactly one JSON object: '
                    '{"keep_base": false, "title": "<=80 chars", '
                    '"trigger": "when the lesson applies, <=200 chars", '
                    '"action": "what to do instead, <=300 chars"}. '
                    'The trigger and action must name the concrete mistake in the turn. '
                    f'If the turn teaches nothing, reply with exactly {KEEP_THE_BASE}. '
                    'Never grade confidence.'
                ),
            },
            {'role': 'user', 'content': reflect_body},
        ],
        'stream': True,
        'temperature': 0,
    }
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = f'Bearer {key}'
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_S) as client:
            async with client.stream(
                'POST', f'{url.removesuffix("/")}/chat/completions', json=body, headers=headers
            ) as response:
                if response.status_code != 200:
                    return None, f'reflection model HTTP {response.status_code}'
                text_parts: list[str] = []
                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith('data:'):
                        continue
                    payload = line.removeprefix('data:').strip()
                    if payload == '[DONE]':
                        break
                    try:
                        chunk = json.loads(payload)
                    except ValueError:
                        continue
                    choices = chunk.get('choices') or []
                    delta = (choices[0] if choices else {}).get('delta') or {}
                    piece = delta.get('content')
                    if isinstance(piece, str):
                        text_parts.append(piece)
                return ''.join(text_parts), None
    except Exception as e:
        return None, f'reflection model call failed: {e}'


def _extract_lesson_json(text: str | None) -> dict | None:
    if not text:
        return None
    if KEEP_THE_BASE.lower() in text.lower():
        return {'keep_base': True}
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    well_formed = all(isinstance(parsed.get(field), str) and parsed.get(field, '').strip() for field in LESSON_FIELDS)
    return parsed if well_formed else {'keep_base': True}


def _validate_lesson_field(value: str, limit: int) -> str:
    cleaned = (value or '').strip()
    if len(cleaned) > limit:
        raise ValueError(f'field exceeds {limit} chars')
    return cleaned


############################
# The vector store (per-user lesson collection)
############################


def lesson_collection_name(user_id: str) -> str:
    return f'{COLLECTION_PREFIX}{user_id}'


async def lesson_similarity(request: Request, user_id: str, query_text: str) -> dict[str, float]:
    """Similarity per lesson id for one retrieval query over the user's own
    collection. Vector clients already normalize distances to similarity
    (1 = identical)."""
    from open_webui.config import RAG_EMBEDDING_QUERY_PREFIX
    from open_webui.retrieval.vector.async_client import ASYNC_VECTOR_DB_CLIENT

    embedding_function = getattr(request.app.state, 'EMBEDDING_FUNCTION', None)
    collection = lesson_collection_name(user_id)
    if embedding_function is None or not await ASYNC_VECTOR_DB_CLIENT.has_collection(collection):
        return {}
    try:
        query_embedding = await embedding_function(query_text[:2000], prefix=RAG_EMBEDDING_QUERY_PREFIX)
        result = await ASYNC_VECTOR_DB_CLIENT.search(
            collection_name=collection,
            vectors=[query_embedding],
            limit=12,
        )
    except Exception as e:
        log.warning('lesson similarity search failed: %s', e)
        return {}
    if not result or not result.ids or not result.ids[0]:
        return {}
    distances = result.distances[0] if result.distances and result.distances[0] else []
    return {
        lesson_id: (float(similarity) if similarity is not None else 0.0)
        for lesson_id, similarity in zip(result.ids[0], distances)
    }


async def lesson_vector_delete(user_id: str, lesson_id: str) -> None:
    from open_webui.retrieval.vector.async_client import ASYNC_VECTOR_DB_CLIENT

    collection = lesson_collection_name(user_id)
    try:
        if await ASYNC_VECTOR_DB_CLIENT.has_collection(collection):
            await ASYNC_VECTOR_DB_CLIENT.delete(collection_name=collection, ids=[lesson_id])
    except Exception as e:
        log.warning('lesson vector delete failed for %s: %s', lesson_id, e)


async def lesson_vector_upsert(request: Request, user_id: str, lesson: LessonModel) -> None:
    from open_webui.config import RAG_EMBEDDING_CONTENT_PREFIX
    from open_webui.retrieval.vector.async_client import ASYNC_VECTOR_DB_CLIENT

    embedding_function = getattr(request.app.state, 'EMBEDDING_FUNCTION', None)
    if embedding_function is None:
        return
    content = f'{lesson.title}\nwhen: {lesson.trigger}\nthen: {lesson.action}'
    if lesson.source:
        content = f'{content}\nwhy: {lesson.source}'
    try:
        embedding = await embedding_function(content, prefix=RAG_EMBEDDING_CONTENT_PREFIX)
    except Exception as e:
        log.warning('lesson embedding failed for %s: %s', lesson.id, e)
        return
    if not embedding:
        return
    await ASYNC_VECTOR_DB_CLIENT.upsert(
        collection_name=lesson_collection_name(user_id),
        items=[
            {
                'id': lesson.id,
                'text': content[:2000],
                'vector': embedding,
                'metadata': {'lesson_id': lesson.id, 'user_id': user_id, 'status': lesson.status},
            }
        ],
    )


############################
# Gates: graduation, caps, rot
############################


def maturity_gate(lesson: LessonModel, config: dict[str, Any]) -> dict[str, bool]:
    """The numeric gates: age, confidence, confirmations, contradictions."""
    now = int(time.time())
    return {
        'age': now - lesson.created_at >= int(config['gate_age_days']) * 86400,
        'confirmations': lesson.confirmations >= int(config['gate_confirmations']),
        'contradictions': lesson.contradictions <= 0,
        'confidence': effective_confidence(lesson, now) >= float(config['gate_confidence']),
    }


def graduation_ready(lesson: LessonModel, config: dict[str, Any]) -> bool:
    return all(maturity_gate(lesson, config).values())


def skill_id_for_lesson(lesson: LessonModel) -> str:
    slug = normalize_lesson_text(lesson.title).replace(' ', '-')[:48] or f'lesson-{lesson.id[:8]}'
    return f'self-learned-{slug}-{lesson.id[:8]}'[:120]


def skill_draft_from_lesson(lesson: LessonModel) -> str:
    """The auto-drafted Skill's SKILL.md: frontmatter, the lesson body, and
    the source citation, so the draft carries the lesson's provenance."""
    source = f'Evidence: {lesson.source}\n\n' if lesson.source else ''
    return (
        '---\n'
        f'name: {lesson.title[:80]}\n'
        f'description: Auto-drafted from lesson {lesson.id}\n'
        '---\n\n'
        f'# {lesson.title}\n\n'
        f'When: {lesson.trigger}\n\n'
        f'Then: {lesson.action}\n\n'
        f'{source}'
        f'Graduated from lesson `{lesson.id}`; user-owned and private.'
    )


async def auto_graduate_lesson(
    request: Request, user_id: str, lesson: LessonModel, config: dict[str, Any]
) -> str | None:
    """The write gate: when the gates are met, the loop auto-drafts the Skill
    through the same plumbing any agent-authored artifact uses (ADR 0003), as
    the driving user, private, history kept."""
    from open_webui.models.skills import SkillForm, Skills

    skill_id = skill_id_for_lesson(lesson)
    existing = await Skills.get_skill_by_id(skill_id)
    if existing is None:
        form = SkillForm(
            id=skill_id,
            name=lesson.title[:80],
            description=f'Auto-drafted from lesson {lesson.id} (confidence {lesson.confidence:.2f})',
            content=skill_draft_from_lesson(lesson),
            commit_message=f'Graduated from lesson {lesson.id}',
            is_active=False,  # a draft; the user still turns it on
            meta={'tags': ['self-learning']},
        )
        try:
            await Skills.insert_new_skill(user_id, form)
        except IntegrityError:
            # Another gate rode the same lesson to graduation concurrently
            # (a ledger pulse racing the confirm route): the draft exists —
            # same deterministic id and name, user-owned — keep it.
            if not await Skills.get_skill_by_id(skill_id):
                raise
    await LessonRecords.update_lesson_status(lesson.id, LESSON_STATUS_GRADUATED, skill_id=skill_id)
    await LessonRecords.record_lesson_event(
        lesson.id, user_id, 'graduate', weight=lesson.confidence, note=f'skill {skill_id}'
    )
    refreshed = await LessonRecords.get_lesson_by_id(lesson.id)
    if refreshed:
        await lesson_vector_upsert(request, user_id, refreshed)
    return skill_id


async def enforce_caps(request: Request, user_id: str, config: dict[str, Any]) -> list[LessonModel]:
    """Caps control rot: past the cap, the weakest oldest active lessons drop.
    A graduated lesson never drops by cap pressure, and cap pressure never
    removes a lesson that got there by relevance — only weakness does."""
    cap = int(config['max_active_lessons'])
    active_count = await LessonRecords.get_active_lessons_count(user_id)
    if active_count <= cap:
        return []
    over = active_count - cap
    candidates = await LessonRecords.get_weakest_active_lessons(user_id, over)
    dropped: list[LessonModel] = []
    for lesson in candidates:
        dropped_lesson = await LessonRecords.update_lesson_status(lesson.id, LESSON_STATUS_DROPPED)
        await LessonRecords.record_lesson_event(
            lesson.id, user_id, 'rot_drop', weight=lesson.confidence, note='cap pressure'
        )
        await lesson_vector_delete(user_id, lesson.id)
        if dropped_lesson:
            dropped.append(dropped_lesson)
    return dropped


############################
# Routers: user/admin surface and the loopback surface
############################

user_router = APIRouter()
loopback_router = APIRouter()
router = APIRouter()


############################
# Loopback surface (sidecar dials with the session binding)
############################


def _binding_claims(request: Request) -> dict:
    token = (request.headers.get('authorization') or '').removeprefix('Bearer ').strip()
    return verify_session_binding(token)


def _topic_slug(lesson: LessonModel) -> str:
    """The lesson's topic as a short slugged string for the event data bag."""
    return re.sub(r'[^a-z0-9]+', '-', normalize_lesson_text(lesson.title))[:80].strip('-')


def _saved_row_text(lesson: LessonModel) -> str:
    """The row's en-US content, style-consistent with the memory row: the
    event's message, then the topic the lesson names."""
    return f'{EVENTS.LESSON_SAVED.message}: {lesson.title}'


async def lay_lesson_saved_row(
    request: Request, user_id: str, chat_id: str, message_id: str, lesson: LessonModel
) -> None:
    """The memory-save event style for lessons (operator ruling, 2026-11-01):
    the write publishes one `EVENTS.LESSON_SAVED` (message field 'Lesson
    saved') with a data bag (topic slug, lesson id, chat), then lays one
    persistent in-chat row through the chat event surface — the same
    event-emitter status machinery the memory notices ride, which records the
    row inside the chat record so reloading the chat re-renders it
    (socket/main.py persists a `status` emit through
    Chats.add_message_status_to_chat_by_id_and_message_id; ResponseMessage
    renders the turn's statusHistory). A failed row never fails the reflect
    response."""
    try:
        actor = await Users.get_user_by_id(user_id)
        await publish_event(
            request,
            EVENTS.LESSON_SAVED,
            actor=actor,
            subject_id=lesson.id,
            subject_type='lesson',
            data={
                'lesson_id': lesson.id,
                'topic': _topic_slug(lesson),
                'title': lesson.title,
                'chat_id': chat_id,
                'message_id': message_id,
            },
        )
    except Exception as e:
        log.warning(f'lesson-saved event publish skipped: {e}')

    if not chat_id or not message_id or not is_saved_chat_id(chat_id):
        return
    try:
        from open_webui.socket.main import get_event_emitter

        emitter = await get_event_emitter({'user_id': user_id, 'chat_id': chat_id, 'message_id': message_id})
        if not emitter:
            return
        await emitter(
            {
                'type': 'status',
                'data': {
                    'action': 'lesson_saved',
                    'description': _saved_row_text(lesson),
                    'lessonId': lesson.id,
                    'done': True,
                },
            }
        )
    except Exception as e:
        log.debug(f'lesson-saved row skipped: {e}')


@loopback_router.post('/prepare')
async def prepare_turn_injection(request: Request):
    """The per-turn retrieval the injector calls before the model runs.

    The answer is the store-side half of dynamic injection: similarity above
    the relevance floor plus the always-on mature set, confidence floored,
    staleness decayed. The sidecar keeps the char budget and dedup.
    """
    claims = _binding_claims(request)
    user_id = claims.get('user_id') or ''
    try:
        form = LessonPrepareForm(**(await request.json()))
    except Exception:
        form = LessonPrepareForm(query='')

    if not await learning_enabled(user_id):
        return {'ok': True, 'enabled': False, 'lessons': []}

    config = await learning_config()
    query_text = f'{form.query}\n{form.activity}'.strip() if form.activity else form.query
    scores = await lesson_similarity(request, user_id, query_text)

    lessons = await LessonRecords.get_lessons_by_user(user_id)
    now = int(time.time())
    injection_floor = float(config['injection_floor'])
    confidence_floor = float(config['confidence_floor'])

    injected: list[dict] = []
    for lesson in lessons:
        similarity = scores.get(lesson.id, 0.0)
        always_on = lesson.status == LESSON_STATUS_GRADUATED
        effective = effective_confidence(lesson, now)
        if effective < confidence_floor and not always_on:
            continue
        if similarity < injection_floor and not always_on:
            # The relevance floor out: a lesson below it stays out even when
            # the budget is free (maturity outranks retrieval; the always-on
            # set above is that rule).
            continue
        injected.append(
            {
                'id': lesson.id,
                'title': lesson.title,
                'trigger': lesson.trigger,
                'action': lesson.action,
                'confidence': lesson.confidence,
                'effectiveConfidence': round(effective, 4),
                'similarity': round(similarity, 4),
                'alwaysOn': always_on,
                'chars': len(lesson.title) + len(lesson.trigger) + len(lesson.action),
            }
        )

    injected.sort(key=lambda entry: (not entry['alwaysOn'], -entry['similarity']))
    return {
        'ok': True,
        'enabled': True,
        'lessons': injected[:12],
        'config': {'charBudget': int(config['char_budget'])},
    }


@loopback_router.post('/reflect')
async def reflect_after_turn(request: Request):
    """The post-turn reflection job: signals first, then the cheap model.

    Signals are deterministic failures and user corrections; quiet turns cost
    nothing. A learned lesson lands in this user's store with its vector
    embedding and the evidence of the moment that caused it. "Keep the base"
    is always valid; the dedup guard absorbs an identical lesson.
    """
    claims = _binding_claims(request)
    user_id = claims.get('user_id') or ''
    chat_id = claims.get('chat_id') or ''
    message_id = claims.get('message_id') or ''
    try:
        form = LessonReflectForm(**(await request.json()))
    except Exception:
        return {'ok': False, 'outcome': 'unprocessable'}

    config = await learning_config()
    if not await learning_enabled(user_id):
        return {'ok': True, 'enabled': False, 'outcome': 'disabled'}

    signals = reflection_signals(form.user_text, form.error, form.tool_calls)
    if signals['quiet']:
        return {'ok': True, 'enabled': True, 'outcome': 'quiet', 'signals': signals}

    # The cheap model: admin config first, the turn's own connection falling
    # back, so a reflection needs no second credential holder.
    reflection_model = (await config_get('agent.self_learning.reflection_model') or '').strip()
    if not reflection_model:
        reflection_model = claims.get('model_id') or ''
    if not reflection_model:
        return {'ok': True, 'enabled': True, 'outcome': 'no_reflection_model', 'signals': signals}

    reflect_body = json.dumps(
        {
            'chat': chat_id,
            'injected_lesson_ids': form.injected_lesson_ids,
            'turn': {
                'user': form.user_text[:2000],
                'assistant': form.assistant_text[:2000],
                'tools': [
                    {
                        'name': str(tool.get('name') or '')[:80],
                        'arguments': str(tool.get('arguments') or '')[:200],
                        'error': tool.get('error') or None,
                    }
                    for tool in form.tool_calls or []
                    if isinstance(tool, dict)
                ],
                'outcome': form.outcome or '',
                'error': form.error or '',
            },
            'reflect': REFLECT_MARKER,
        },
        ensure_ascii=False,
    )
    text, failure = await cheap_model_completion(request, user_id, reflection_model, reflect_body)
    if failure:
        return {
            'ok': True,
            'enabled': True,
            'outcome': 'reflection_model_unavailable',
            'detail': failure,
            'signals': signals,
        }

    parsed = _extract_lesson_json(text)
    if parsed is None:
        return {'ok': True, 'enabled': True, 'outcome': 'invalid', 'signals': signals}
    if parsed.get('keep_base'):
        return {'ok': True, 'enabled': True, 'outcome': 'kept_base', 'signals': signals}

    try:
        title = _validate_lesson_field(parsed['title'], TITLE_MAX_CHARS)
        trigger = _validate_lesson_field(parsed['trigger'], SECTION_MAX_CHARS)
        action = _validate_lesson_field(parsed['action'], SECTION_MAX_CHARS)
    except Exception as e:
        return {'ok': True, 'enabled': True, 'outcome': 'invalid', 'detail': str(e), 'signals': signals}

    duplicate = await LessonRecords.find_duplicate_lesson(user_id, trigger, action)
    if duplicate:
        return {
            'ok': True,
            'enabled': True,
            'outcome': 'duplicate',
            'lessonId': duplicate.id,
            'signals': signals,
        }

    source = f'user asked: "{form.user_text[:160]}"'
    lesson = await LessonRecords.insert_new_lesson(
        user_id=user_id,
        title=title,
        trigger=trigger,
        action=action,
        source=source,
        chat_id=chat_id,
        confidence=float(config['base_confidence']),
    )
    await LessonRecords.record_lesson_event(lesson.id, user_id, 'written', note=source[:200])
    await lay_lesson_saved_row(request, user_id, chat_id, message_id, lesson)
    await lesson_vector_upsert(request, user_id, lesson)
    await enforce_caps(request, user_id, config)
    return {
        'ok': True,
        'enabled': True,
        'outcome': 'written',
        'lesson': lesson.model_dump(),
        'signals': signals,
    }


@loopback_router.post('/ledger')
async def apply_ledger_pulse(request: Request):
    """Persist the sidecar's confidence pulses, then apply the gates: a
    pulse can graduate a lesson (auto-drafting its Skill), and caps rot the
    weak ones out. The numbers come from the sidecar's ledger; the model is
    never asked for one."""
    claims = _binding_claims(request)
    user_id = claims.get('user_id') or ''
    try:
        form = LedgerForm(**(await request.json()))
    except Exception:
        return {'ok': False, 'outcome': 'unprocessable'}

    if not await learning_enabled(user_id):
        return {'ok': True, 'enabled': False}

    config = await learning_config()
    updated: list[dict] = []
    graduated: list[dict] = []
    for pulse in form.updates:
        checkpoint = await LessonRecords.get_lesson_by_id(pulse.lesson_id)
        if checkpoint is None or checkpoint.user_id != user_id:
            continue
        # The loop's counters (contradictions, injections) are the sidecar's
        # to report; the user's own confirmations are the review surface's,
        # and a pulse can never erase one — nor lower the confidence a
        # confirm just raised above the loop's arithmetic.
        lesson = await LessonRecords.update_lesson_counters(
            pulse.lesson_id,
            confidence=max(checkpoint.confidence, max(0.05, min(0.95, pulse.confidence))),
            contradictions=max(0, pulse.contradictions),
            injections=max(0, pulse.injections),
        )
        await LessonRecords.record_lesson_event(
            lesson.id, user_id, 'confide', weight=lesson.confidence, note='ledger pulse'
        )
        updated.append(lesson.model_dump())
        if lesson.status == LESSON_STATUS_ACTIVE and graduation_ready(lesson, config):
            skill_id = await auto_graduate_lesson(request, user_id, lesson, config)
            if skill_id:
                refreshed = await LessonRecords.get_lesson_by_id(lesson.id)
                graduated.append({'lessonId': lesson.id, 'skillId': skill_id, 'lesson': refreshed.model_dump()})
    rot = await enforce_caps(request, user_id, config)
    return {
        'ok': True,
        'enabled': True,
        'updated': updated,
        'graduated': graduated,
        'rotDropped': [lesson.id for lesson in rot],
    }


############################
# User surface
############################


@user_router.get('')
async def get_my_lessons(user=Depends(get_verified_user), db: AsyncSession = Depends(get_async_session)):
    """The review surface: this user's surviving lessons, newest first."""
    return [lesson.model_dump() for lesson in await LessonRecords.get_lessons_by_user(user.id, db=db)]


@user_router.get('/switch')
async def get_switch(user=Depends(get_verified_user)):
    user_switch = user_settings_of(user).get(USER_SWITCH_KEY, {})
    enabled = bool(user_switch.get('enabled', True)) if isinstance(user_switch, dict) else True
    return {'enabled': enabled, 'adminEnabled': await config_get('agent.self_learning.enabled')}


@user_router.post('/switch')
async def set_switch(request: Request, user=Depends(get_verified_user)):
    """The per-user switch: learning on by default, off for one user here
    without touching anyone else."""
    form = LessonSwitchUpdate(**(await request.json()))
    settings = user_settings_of(user)
    user_switch = dict(settings.get(USER_SWITCH_KEY) or {})
    user_switch['enabled'] = bool(form.enabled)
    settings[USER_SWITCH_KEY] = user_switch
    await Users.update_user_settings_by_id(user.id, settings)
    return {'enabled': form.enabled, 'adminEnabled': await config_get('agent.self_learning.enabled')}


@user_router.post('/{lesson_id}/confirm')
async def confirm_lesson(
    request: Request,
    lesson_id: str,
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    """The user's own confirmation: evidence plus a fixed deterministic delta."""
    lesson = await LessonRecords.get_lesson_by_id(lesson_id, db=db)
    if lesson is None or lesson.user_id != user.id or lesson.status == LESSON_STATUS_DROPPED:
        raise HTTPException(status_code=404, detail='lesson not found')
    await LessonRecords.update_lesson_counters(lesson_id, confirmations=lesson.confirmations + 1)
    lesson = await LessonRecords.update_lesson_counters(
        lesson_id, confidence=min(0.95, lesson.confidence + USER_CONFIRM_WEIGHT)
    )
    await LessonRecords.record_lesson_event(
        lesson_id, user.id, 'confide', weight=USER_CONFIRM_WEIGHT, note='user confirmed'
    )
    refreshed = await LessonRecords.get_lesson_by_id(lesson_id, db=db)
    # The user's confirmation is one of the gates, so a confirm that closes
    # the numeric gates graduates right there — no wait for the next pulse.
    config = await learning_config()
    if refreshed and refreshed.status == LESSON_STATUS_ACTIVE and graduation_ready(refreshed, config):
        await auto_graduate_lesson(request, user.id, refreshed, config)
        refreshed = await LessonRecords.get_lesson_by_id(lesson_id, db=db)
    return refreshed.model_dump()


@user_router.delete('/{lesson_id}')
async def delete_my_lesson(
    lesson_id: str,
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    lesson = await LessonRecords.get_lesson_by_id(lesson_id, db=db)
    if lesson is None or lesson.user_id != user.id:
        raise HTTPException(status_code=404, detail='lesson not found')
    await LessonRecords.update_lesson_status(lesson_id, LESSON_STATUS_DROPPED)
    await LessonRecords.record_lesson_event(lesson_id, user.id, 'drop', note='user deleted')
    await lesson_vector_delete(user.id, lesson_id)
    return {'ok': True}


@user_router.get('/{lesson_id}/events')
async def get_lesson_events(
    lesson_id: str,
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    lesson = await LessonRecords.get_lesson_by_id(lesson_id, db=db)
    if lesson is None or lesson.user_id != user.id:
        raise HTTPException(status_code=404, detail='lesson not found')
    return [event.model_dump() for event in await LessonRecords.get_events_by_lesson(lesson_id, db=db)]


############################
# Admin surface
############################


@user_router.get('/config')
async def get_learning_config(admin=Depends(get_admin_user)):
    return await learning_config()


@user_router.post('/config')
async def set_learning_config(request: Request, admin=Depends(get_admin_user)):
    """Every dial persisted in the config store: switch off here and observe,
    reflect, and inject all stop, chat unaffected, without a rebuild."""
    from open_webui.models.config import Config

    form = LessonConfigUpdate(**(await request.json()))
    updates: dict[str, Any] = {}
    for field, key in CONFIG_KEYS.items():
        value = getattr(form, field)
        if value is None:
            continue
        if field in ('injection_floor', 'confidence_floor', 'gate_confidence', 'base_confidence'):
            value = max(0.0, min(1.0, float(value)))
        elif field in ('char_budget', 'max_active_lessons', 'gate_age_days', 'gate_confirmations'):
            value = int(value)
        elif field == 'enabled':
            value = bool(value)
        elif field == 'reflection_model':
            value = str(value).strip()
        updates[key] = value
    if updates:
        await Config.upsert(updates)
    return await learning_config()


@user_router.get('/admin/summary')
async def admin_lesson_summary(admin=Depends(get_admin_user)):
    """The aggregates the decision calls for: lessons surviving the TTL, the
    confirm rate, the corrections trend."""
    counts = await LessonRecords.count_lessons_by_status()
    lessons = await LessonRecords.export_lessons()
    confirmations = sum(lesson.confirmations for lesson in lessons)
    contradictions = sum(lesson.contradictions for lesson in lessons)
    active = counts.get(LESSON_STATUS_ACTIVE, 0)
    return {
        'statusCounts': counts,
        'lessons': len(lessons),
        'active': active,
        'graduated': counts.get(LESSON_STATUS_GRADUATED, 0),
        'dropped': counts.get(LESSON_STATUS_DROPPED, 0),
        'confirmations': confirmations,
        'contradictions': contradictions,
        'confirmRate': round(confirmations / len(lessons), 4) if lessons else 0.0,
    }


# The joins sit at module end: include_router() snapshots the source router
# at call time, and the decorated routes all live above.
router.include_router(user_router, prefix='/api/v1/lessons')
router.include_router(loopback_router, prefix='/loopback/lessons')
