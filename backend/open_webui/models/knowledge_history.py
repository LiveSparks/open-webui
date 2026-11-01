"""Knowledge history: the structure and file-operation record that a rollback reverses.

Unlike the other workspace history tables, a knowledge edit is rarely one diff:
renaming a base, adding a file, removing one, reshaping directories. Each entry
therefore carries an operation (`lang`-free slug: structure, file_added,
file_removed, reset) and its own snapshot, recorded by the acting user so
agent-driven commits stay attributable to the user who drove them.
"""

from __future__ import annotations

import time
import uuid
from typing import Optional

from open_webui.internal.db import Base, get_async_db_context
from open_webui.models.users import UserResponse, Users
from pydantic import BaseModel, ConfigDict
from sqlalchemy import BigInteger, Column, JSON, Text, delete, select
from sqlalchemy.ext.asyncio import AsyncSession


class KnowledgeHistory(Base):
    __tablename__ = 'knowledge_history'

    id = Column(Text, primary_key=True)
    knowledge_id = Column(Text, nullable=False, index=True)
    operation = Column(Text, nullable=False)
    parent_id = Column(Text, nullable=True)
    snapshot = Column(JSON, nullable=False)
    user_id = Column(Text, nullable=False)
    commit_message = Column(Text, nullable=True)
    created_at = Column(BigInteger, nullable=False)


class KnowledgeHistoryModel(BaseModel):
    id: str
    knowledge_id: str
    operation: str
    parent_id: Optional[str] = None
    snapshot: dict
    user_id: str
    commit_message: Optional[str] = None
    created_at: int

    model_config = ConfigDict(from_attributes=True)


class KnowledgeHistoryResponse(KnowledgeHistoryModel):
    user: Optional[UserResponse] = None


class KnowledgeHistoriesTable:
    async def create_history_entry(
        self,
        knowledge_id: str,
        operation: str,
        snapshot: dict,
        user_id: str,
        parent_id: Optional[str] = None,
        commit_message: Optional[str] = None,
        db: Optional[AsyncSession] = None,
    ) -> Optional[KnowledgeHistoryModel]:
        async with get_async_db_context(db) as db:
            entry = KnowledgeHistory(
                id=str(uuid.uuid4()),
                knowledge_id=knowledge_id,
                operation=operation,
                parent_id=parent_id,
                snapshot=snapshot,
                user_id=user_id,
                commit_message=commit_message,
                created_at=int(time.time()),
            )
            db.add(entry)
            await db.commit()
            return KnowledgeHistoryModel.model_validate(entry)

    async def get_history_by_knowledge_id(
        self,
        knowledge_id: str,
        page: int = 1,
        db: Optional[AsyncSession] = None,
    ) -> list[KnowledgeHistoryResponse]:
        async with get_async_db_context(db) as db:
            result = await db.execute(
                select(KnowledgeHistory)
                .filter(KnowledgeHistory.knowledge_id == knowledge_id)
                .order_by(KnowledgeHistory.created_at.desc(), KnowledgeHistory.id.desc())
                .offset((max(1, page) - 1) * 20)
                .limit(20)
            )
            entries = result.scalars().all()

            user_ids = list(set(e.user_id for e in entries))
            users = await Users.get_users_by_user_ids(user_ids, db=db) if user_ids else []
            users_dict = {user.id: user for user in users}

            return [
                KnowledgeHistoryResponse(
                    **KnowledgeHistoryModel.model_validate(entry).model_dump(),
                    user=(users_dict.get(entry.user_id).model_dump() if users_dict.get(entry.user_id) else None),
                )
                for entry in entries
            ]

    async def get_latest_history_entry(
        self,
        knowledge_id: str,
        db: Optional[AsyncSession] = None,
    ) -> Optional[KnowledgeHistoryModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(
                select(KnowledgeHistory)
                .filter(KnowledgeHistory.knowledge_id == knowledge_id)
                .order_by(KnowledgeHistory.created_at.desc(), KnowledgeHistory.id.desc())
                .limit(1)
            )
            entry = result.scalars().first()
            return KnowledgeHistoryModel.model_validate(entry) if entry else None

    async def delete_history_by_knowledge_id(
        self,
        knowledge_id: str,
        db: Optional[AsyncSession] = None,
    ) -> bool:
        async with get_async_db_context(db) as db:
            await db.execute(delete(KnowledgeHistory).filter_by(knowledge_id=knowledge_id))
            await db.commit()
            return True


KnowledgeHistories = KnowledgeHistoriesTable()
