"""Add lesson tables

The self-learning loop (PR11, ADR 0004): lessons are OWUI's own private,
user-owned learning artifact beside Skills and Tools, plus the evidence rows
that make the confidence ledger auditable.

Revision ID: 1a2b3c4d5e6f
Revises: b3c7e5a91f02
Create Date: 2026-10-31 00:00:00.000000

"""

import sqlalchemy as sa
from alembic import op

revision = '1a2b3c4d5e6f'
down_revision = 'b3c7e5a91f02'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = set(inspector.get_table_names())

    if 'lesson' not in existing_tables:
        op.create_table(
            'lesson',
            sa.Column('id', sa.Text(), nullable=False, primary_key=True, unique=True),
            sa.Column('user_id', sa.Text(), nullable=False),
            sa.Column('title', sa.Text(), nullable=True),
            sa.Column('trigger', sa.Text(), nullable=True),
            sa.Column('action', sa.Text(), nullable=True),
            sa.Column('source', sa.Text(), nullable=True),
            sa.Column('chat_id', sa.Text(), nullable=True),
            sa.Column('status', sa.Text(), nullable=True),
            sa.Column('skill_id', sa.Text(), nullable=True),
            sa.Column('confidence', sa.Float(), nullable=True),
            sa.Column('confirmations', sa.Integer(), nullable=True),
            sa.Column('contradictions', sa.Integer(), nullable=True),
            sa.Column('injections', sa.Integer(), nullable=True),
            sa.Column('created_at', sa.BigInteger(), nullable=True),
            sa.Column('updated_at', sa.BigInteger(), nullable=True),
        )

    if 'lesson_event' not in existing_tables:
        op.create_table(
            'lesson_event',
            sa.Column('id', sa.Text(), nullable=False, primary_key=True, unique=True),
            sa.Column('lesson_id', sa.Text(), nullable=True),
            sa.Column('user_id', sa.Text(), nullable=True),
            sa.Column('kind', sa.Text(), nullable=True),
            sa.Column('weight', sa.Float(), nullable=True),
            sa.Column('note', sa.Text(), nullable=True),
            sa.Column('created_at', sa.BigInteger(), nullable=True),
        )


def downgrade():
    op.drop_table('lesson_event')
    op.drop_table('lesson')
