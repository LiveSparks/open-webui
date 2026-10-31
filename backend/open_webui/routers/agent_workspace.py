"""Agent workspace: tombstones, restore, and knowledge history (PR12, ADR 0003).

Deletes in the four agent-writable artifact families (tool, prompt, skill,
knowledge) never erase — they tombstone for 30 days and restore from anywhere
edit is permitted, history intact. This is the REST surface for that life
cycle, consumed by the workspace UI and the agent's bridge tools alike; the
agent's own authoring tools live in tools/builtin.py.

Kind ids are the lowercase slugs (`tool`, `prompt`, `skill`, `knowledge`),
matching the access-grant resource_type of each family.
"""

from fastapi import APIRouter, Depends, HTTPException, status

from open_webui.config import BYPASS_ADMIN_ACCESS_CONTROL
from open_webui.models.access_grants import AccessGrants
from open_webui.models.knowledge_history import KnowledgeHistories
from open_webui.models.workspace_tombstones import (
    list_tombstones,
    restore_tombstone,
    tombstone_owner,
)
from open_webui.utils.auth import get_admin_user, get_verified_user

router = APIRouter()

_TOMBSTONE_KINDS = ('tool', 'prompt', 'skill', 'knowledge')


async def _restore_authority(kind: str, item_id: str, user) -> None:
    """Restore rides wherever edit is: owner, explicit write grant, or admin."""
    if user.role != 'admin':
        owner = await tombstone_owner(kind, item_id)
        is_owner = owner is not None and owner == user.id
        if not is_owner and not await AccessGrants.has_access(
            user_id=user.id,
            resource_type=kind,
            resource_id=item_id,
            permission='write',
            db=None,
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail='restore follows edit access; no write grant on the tombstone',
            )


@router.get('/deleted')
async def get_recently_deleted(user=Depends(get_verified_user)):
    """The recently-deleted surface: tombstones, newest deletion first.

    Admins under BYPASS_ADMIN_ACCESS_CONTROL see everything; everyone else
    only their own rows."""
    user_id = None
    if not (user.role == 'admin' and BYPASS_ADMIN_ACCESS_CONTROL):
        user_id = user.id
    return await list_tombstones(user_id=user_id)


@router.post('/id/{kind}/{id}/restore')
async def restore_artifact(kind: str, id: str, user=Depends(get_verified_user)):
    if kind not in _TOMBSTONE_KINDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f'unknown artifact kind: {kind}')
    await _restore_authority(kind, id, user)
    return await restore_tombstone(kind, id)


@router.get('/id/{kind}/{id}/history')
async def get_artifact_history(kind: str, id: str, user=Depends(get_verified_user)):
    """Edit history through one uniform surface; knowledge carries the
    structure and file-operation record that a rollback reverses."""
    if kind not in _TOMBSTONE_KINDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f'unknown artifact kind: {kind}')
    if not (
        user.role == 'admin'
        or await AccessGrants.has_access(
            user_id=user.id,
            resource_type=kind,
            resource_id=id,
            permission='read',
            db=None,
        )
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='read access required')
    if kind == 'knowledge':
        return await KnowledgeHistories.get_history_by_knowledge_id(id)
    table_kind = {'tool': 'tool', 'prompt': 'prompt', 'skill': 'skill'}[kind]
    if table_kind == 'tool':
        from open_webui.models.tool_history import ToolHistories

        return await ToolHistories.get_history_by_tool_id(tool_id=id)
    if table_kind == 'prompt':
        from open_webui.models.prompt_history import PromptHistories

        return await PromptHistories.get_history_by_prompt_id(prompt_id=id)
    from open_webui.models.skill_history import SkillHistories

    return await SkillHistories.get_history_by_skill_id(skill_id=id)


@router.post('/purge')
async def purge_now(user=Depends(get_admin_user)):
    """Run the 30-day tombstone reap immediately; the scheduler keeps it routine."""
    from open_webui.models.workspace_tombstones import purge_expired_tombstones

    purged = await purge_expired_tombstones()
    return {'purged': purged}
