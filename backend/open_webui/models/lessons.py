"""Lesson records — the self-learning loop's durable artifact (PR11, ADR 0004).

Lessons sit in OWUI's workspace database beside Skills and Tools as their own
private, user-owned artifact type: short structured records with one section
that commemorates why the lesson exists. The numeric confidence ledger is
enforced client-side (the sidecar's learning loop carries the arithmetic, per
issue 14) — the backend stores the resulting confidence, counters, and event
audit trail, and scopes every read and write per user. Lessons never cross
users, so every lookup keys on `user_id` first.

The vector-store consumer (knowledge reuse) lives in the lessons router; this
model module owns the rows only.
"""

import time
import uuid

from open_webui.internal.db import Base, get_async_db_context
from pydantic import BaseModel, ConfigDict
from sqlalchemy import BigInteger, Float, Index, Integer, Text, Column, func, select
from sqlalchemy.ext.asyncio import AsyncSession


####################
# Lesson DB Schema
####################


class Lesson(Base):
    """One lesson: what to do differently and why it was learned.

    `status`: 'active' (injection candidate), 'graduated' (its Skill was
    auto-drafted; always injected per the maturity rule), 'dropped' (rot
    control expired it or the user deleted it).
    """

    __tablename__ = 'lesson'

    id = Column(Text, primary_key=True, unique=True)
    user_id = Column(Text, nullable=False)  # the driving user; never crosses users

    title = Column(Text, nullable=False)
    trigger = Column(Text, nullable=False)  # when the lesson applies
    action = Column(Text, nullable=False)  # what to do instead
    source = Column(Text, nullable=True)  # the conversation moment that caused it

    chat_id = Column(Text, nullable=True)  # the chat that observed the lesson's birth
    status = Column(Text, default='active')  # active | graduated | dropped
    skill_id = Column(Text, nullable=True)  # the auto-drafted Skill once graduated

    # The ledger's mirror: the sidecar applies the decay arithmetic and posts
    # the resulting numbers; the DB never derives confidence from the model.
    confidence = Column(Float, default=0.5)
    confirmations = Column(Integer, default=0)
    contradictions = Column(Integer, default=0)
    injections = Column(Integer, default=0)

    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)


class LessonEvent(Base):
    """The ledger's audit trail: one evidence row per ledger turn."""

    __tablename__ = 'lesson_event'

    id = Column(Text, primary_key=True, unique=True)
    lesson_id = Column(Text, nullable=False)
    user_id = Column(Text, nullable=False)
    kind = Column(Text, nullable=False)  # written | confide | contradict | inject | drop | graduate
    weight = Column(Float, nullable=True)
    note = Column(Text, nullable=True)
    created_at = Column(BigInteger, nullable=False)


Index('ix_lesson_user_status', Lesson.user_id, Lesson.status)
Index('ix_lesson_event_lesson', LessonEvent.lesson_id)


####################
# Pydantic models
####################


class LessonModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str

    title: str
    trigger: str
    action: str
    source: str | None = None

    chat_id: str | None = None
    status: str = 'active'
    skill_id: str | None = None

    confidence: float = 0.5
    confirmations: int = 0
    contradictions: int = 0
    injections: int = 0

    created_at: int
    updated_at: int


class LessonEventModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    lesson_id: str
    user_id: str
    kind: str
    weight: float | None = None
    note: str | None = None
    created_at: int


####################
# Logic
####################

LESSON_STATUS_ACTIVE = 'active'
LESSON_STATUS_GRADUATED = 'graduated'
LESSON_STATUS_DROPPED = 'dropped'


def normalize_lesson_text(value: str | None) -> str:
    """The dedup key of a lesson: case, punctuation, and blank noise removed."""
    import re

    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]+', ' ', (value or '').lower())).strip()


class LessonRecords:
    """CRUD over lesson rows, scoped per user everywhere."""

    @staticmethod
    async def insert_new_lesson(
        user_id: str,
        title: str,
        trigger: str,
        action: str,
        source: str | None = None,
        chat_id: str | None = None,
        confidence: float = 0.5,
        db: AsyncSession | None = None,
    ) -> LessonModel:
        async with get_async_db_context(db) as session:
            now = int(time.time())
            entry = Lesson(
                id=uuid.uuid4().hex,
                user_id=user_id,
                title=title,
                trigger=trigger,
                action=action,
                source=source,
                chat_id=chat_id,
                status=LESSON_STATUS_ACTIVE,
                confidence=confidence,
                confirmations=0,
                contradictions=0,
                injections=0,
                created_at=now,
                updated_at=now,
            )
            session.add(entry)
            await session.commit()
            return LessonModel.model_validate(entry)

    @staticmethod
    async def get_lesson_by_id(lesson_id: str, db: AsyncSession | None = None) -> LessonModel | None:
        async with get_async_db_context(db) as session:
            entry = await session.get(Lesson, lesson_id)
            return LessonModel.model_validate(entry) if entry else None

    @staticmethod
    async def get_lessons_by_user(user_id: str, db: AsyncSession | None = None) -> list[LessonModel]:
        """The user's review surface: every surviving lesson, newest first."""
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(Lesson)
                .where(Lesson.user_id == user_id, Lesson.status != LESSON_STATUS_DROPPED)
                .order_by(Lesson.created_at.desc())
            )
            return [LessonModel.model_validate(entry) for entry in result.scalars()]

    @staticmethod
    async def find_duplicate_lesson(
        user_id: str, trigger: str, action: str, db: AsyncSession | None = None
    ) -> LessonModel | None:
        """The dedup guard: a surviving lesson (active or graduated — a
        graduated lesson's Skill has already minted its title, so a repeated
        mistake must rejoin it, never mint a twin) with the same trigger and
        action."""
        trigger_key = normalize_lesson_text(trigger)
        action_key = normalize_lesson_text(action)
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(Lesson)
                .where(
                    Lesson.user_id == user_id,
                    Lesson.status.in_((LESSON_STATUS_ACTIVE, LESSON_STATUS_GRADUATED)),
                )
                .order_by(Lesson.created_at.desc())
            )
            for entry in result.scalars():
                if (
                    normalize_lesson_text(entry.trigger) == trigger_key
                    and normalize_lesson_text(entry.action) == action_key
                ):
                    return LessonModel.model_validate(entry)
            return None

    @staticmethod
    async def get_active_lessons_count(user_id: str, db: AsyncSession | None = None) -> int:
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(func.count())
                .select_from(Lesson)
                .where(Lesson.user_id == user_id, Lesson.status == LESSON_STATUS_ACTIVE)
            )
            return int(result.scalar() or 0)

    @staticmethod
    async def update_lesson_counters(
        lesson_id: str,
        confidence: float | None = None,
        confirmations: int | None = None,
        contradictions: int | None = None,
        injections: int | None = None,
        db: AsyncSession | None = None,
    ) -> LessonModel | None:
        """Persist one ledger pulse. The sidecar computes the numbers; this
        only stores them, so the model could never grade itself even in
        theory."""
        async with get_async_db_context(db) as session:
            entry = await session.get(Lesson, lesson_id)
            if not entry:
                return None
            if confidence is not None:
                entry.confidence = float(confidence)
            if confirmations is not None:
                entry.confirmations = int(confirmations)
            if contradictions is not None:
                entry.contradictions = int(contradictions)
            if injections is not None:
                entry.injections = int(injections)
            entry.updated_at = int(time.time())
            await session.commit()
            return LessonModel.model_validate(entry)

    @staticmethod
    async def update_lesson_status(
        lesson_id: str, status: str, skill_id: str | None = None, db: AsyncSession | None = None
    ) -> LessonModel | None:
        async with get_async_db_context(db) as session:
            entry = await session.get(Lesson, lesson_id)
            if not entry:
                return None
            entry.status = status
            if skill_id is not None:
                entry.skill_id = skill_id
            entry.updated_at = int(time.time())
            await session.commit()
            return LessonModel.model_validate(entry)

    @staticmethod
    async def record_lesson_event(
        lesson_id: str,
        user_id: str,
        kind: str,
        weight: float | None = None,
        note: str | None = None,
        db: AsyncSession | None = None,
    ) -> LessonEventModel:
        async with get_async_db_context(db) as session:
            entry = LessonEvent(
                id=uuid.uuid4().hex,
                lesson_id=lesson_id,
                user_id=user_id,
                kind=kind,
                weight=weight,
                note=note,
                created_at=int(time.time()),
            )
            session.add(entry)
            await session.commit()
            return LessonEventModel.model_validate(entry)

    @staticmethod
    async def get_events_by_lesson(lesson_id: str, db: AsyncSession | None = None) -> list[LessonEventModel]:
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(LessonEvent).where(LessonEvent.lesson_id == lesson_id).order_by(LessonEvent.created_at.asc())
            )
            return [LessonEventModel.model_validate(entry) for entry in result.scalars()]

    @staticmethod
    async def count_lessons_by_status(
        db: AsyncSession | None = None,
    ) -> dict[str, int]:
        """The admin aggregates question: how many lessons survive the TTL."""
        async with get_async_db_context(db) as session:
            result = await session.execute(select(Lesson.status, func.count()).group_by(Lesson.status))
            return {status: int(total) for status, total in result}

    @staticmethod
    async def get_weakest_active_lessons(user_id: str, limit: int, db: AsyncSession | None = None) -> list[LessonModel]:
        """Rot control's candidates: the oldest, weakest active lessons first.

        Maturity outranks retrieval, so graduated lessons are never candidates;
        only `active` rows rot out.
        """
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(Lesson)
                .where(
                    Lesson.user_id == user_id,
                    Lesson.status == LESSON_STATUS_ACTIVE,
                )
                .order_by(Lesson.confidence.asc(), Lesson.created_at.asc())
                .limit(limit)
            )
            return [LessonModel.model_validate(entry) for entry in result.scalars()]

    @staticmethod
    async def get_graduated_lesson_ids(user_id: str, db: AsyncSession | None = None) -> list[str]:
        """The always-on set: graduated lessons ride every eligible turn."""
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(Lesson.id)
                .where(Lesson.user_id == user_id, Lesson.status == LESSON_STATUS_GRADUATED)
                .order_by(Lesson.updated_at.desc())
            )
            return [row[0] for row in result]

    @staticmethod
    async def export_lessons(admin_only_summary: bool = False) -> list[LessonModel]:
        async with get_async_db_context() as session:
            result = await session.execute(select(Lesson).order_by(Lesson.created_at.desc()))
            return [LessonModel.model_validate(entry) for entry in result.scalars()]
