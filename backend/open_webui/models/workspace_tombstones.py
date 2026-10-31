"""The workspace tombstone registry: deletes hide, restores revive, a purge reaps.

ADR 0003: every agent-writable workspace artifact type (tool, prompt, skill,
knowledge) deletes into a 30-day tombstone rather than an erased row. The row
stays user-owned with its grants and edit history, invisible everywhere except
the recently-deleted surface and restore endpoints (routers/agent_workspace.py).

One registry, four kinds: `list_tombstones` for the recently-deleted surface,
`restore` with a per-kind collision check, and `purge_expired_tombstones` for
the scheduler job. Restore is permitted wherever edit is — callers enforce that
(AgentWorkspace router and the bridge tool both take the user's authority).
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

TOMBSTONE_TTL_DAYS = 30

_KINDS = ('tool', 'prompt', 'skill', 'knowledge')


def tombstone_ttl_epochs(now: int) -> tuple[int, int]:
    """(cutoff_at which a tombstone dies, start of today) as epoch seconds."""
    day = 24 * 60 * 60
    cutoff = now - TOMBSTONE_TTL_DAYS * day
    return cutoff, now - now % day


async def list_tombstones(
    user_id: str | None = None,
    db=None,
) -> list[dict]:
    """Everything tombstoned for a user (or everything, for the admin surface),
    newest deletion first."""
    from open_webui.models.knowledge import Knowledges
    from open_webui.models.prompts import Prompts
    from open_webui.models.skills import Skills
    from open_webui.models.tools import Tools

    items: list[dict] = []
    for kind in _KINDS:
        table = {'tool': Tools, 'prompt': Prompts, 'skill': Skills, 'knowledge': Knowledges}[kind]
        rows = await table._tombstone_rows(user_id=user_id, db=db)
        for row in rows:
            items.append(
                {
                    'kind': kind,
                    'id': row['id'],
                    'name': row.get('name'),
                    'user_id': row.get('user_id'),
                    'deleted_at': row.get('deleted_at'),
                }
            )
    items.sort(key=lambda item: item.get('deleted_at') or 0, reverse=True)
    return items


async def tombstone_owner(kind: str, item_id: str, db=None) -> str | None:
    """The user id a tombstone still belongs to, so restore can ride edit access."""
    for row in await _table_for(kind)._tombstone_rows(db=db):
        if row['id'] == item_id:
            return row.get('user_id')
    return None


async def restore_tombstone(kind: str, item_id: str, db=None):
    """Revive one tombstone with its history intact; raises HTTPException with a
    404 (no such tombstone) or 409 (would collide with a live artifact)."""
    table = _table_for(kind)
    collision = await table._restore_collision(item_id)
    if collision:
        raise HTTPException(status_code=409, detail='a live artifact already holds this name or command')
    restored = await table._restore(item_id)
    if restored is None:
        raise HTTPException(status_code=404, detail='no tombstone with that id')
    return _summarize(restored)


async def purge_expired_tombstones(now: Optional[int] = None) -> list[dict]:
    """Hard-delete every tombstone older than the 30-day TTL. Idempotent."""
    import time

    from open_webui.models.knowledge import Knowledges
    from open_webui.models.knowledge_history import KnowledgeHistories
    from open_webui.models.prompts import Prompts
    from open_webui.models.skills import Skills
    from open_webui.models.tools import Tools

    cutoff = (now if now is not None else int(time.time())) - TOMBSTONE_TTL_DAYS * 24 * 60 * 60
    purged: list[dict] = []
    for kind in _KINDS:
        table = {'tool': Tools, 'prompt': Prompts, 'skill': Skills, 'knowledge': Knowledges}[kind]
        for row in await table._tombstone_rows(older_than=cutoff, db=None):
            if kind == 'knowledge':
                await KnowledgeHistories.delete_history_by_knowledge_id(row['id'])
            if not hasattr(table, '_purge'):
                raise RuntimeError(f'{kind} table has no purge')
            if await table._purge(row['id']):
                purged.append({'kind': kind, 'id': row['id']})
    return purged


def _table_for(kind: str):
    from open_webui.models.knowledge import Knowledges
    from open_webui.models.prompts import Prompts
    from open_webui.models.skills import Skills
    from open_webui.models.tools import Tools

    mapping = {'tool': Tools, 'prompt': Prompts, 'skill': Skills, 'knowledge': Knowledges}
    if kind not in mapping:
        raise HTTPException(status_code=404, detail=f'unknown artifact kind: {kind}')
    return mapping[kind]


def _summarize(restored) -> dict:
    kind_name = type(restored).__name__.removesuffix('Model')
    kind = {'Tool': 'tool', 'Prompt': 'prompt', 'Skill': 'skill', 'Knowledge': 'knowledge'}[kind_name]
    return {
        'kind': kind,
        'id': restored.id,
        'name': getattr(restored, 'name', None),
        'deleted_at': None,
    }
