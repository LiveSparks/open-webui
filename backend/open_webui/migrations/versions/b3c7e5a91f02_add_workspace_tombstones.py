"""Add workspace tombstones and knowledge history (ADR 0003).

Deletes of Tools, Prompts, Skills, and Knowledge become 30-day tombstones:
each row gains a `deleted_at` stamp, and a new knowledge_history table records
the structure and file-operation edits a rollback reverses.
"""

import sqlalchemy as sa
from alembic import op

revision = 'b3c7e5a91f02'
down_revision = '0bd252b206fb'
branch_labels = None
depends_on = None

TOMBSTONE_TABLES = ('tool', 'prompt', 'skill', 'knowledge')


def upgrade():
    for table in TOMBSTONE_TABLES:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column('deleted_at', sa.BigInteger(), nullable=True))
        op.create_index(f'ix_{table}_deleted_at', table, ['deleted_at'])
    op.create_table(
        'knowledge_history',
        sa.Column('id', sa.Text(), primary_key=True),
        sa.Column('knowledge_id', sa.Text(), nullable=False),
        sa.Column('operation', sa.Text(), nullable=False),
        sa.Column('parent_id', sa.Text(), nullable=True),
        sa.Column('snapshot', sa.JSON(), nullable=False),
        sa.Column('user_id', sa.Text(), nullable=False),
        sa.Column('commit_message', sa.Text(), nullable=True),
        sa.Column('created_at', sa.BigInteger(), nullable=False),
    )
    op.create_index('ix_knowledge_history_knowledge_id', 'knowledge_history', ['knowledge_id'])


def downgrade():
    op.drop_index('ix_knowledge_history_knowledge_id', table_name='knowledge_history')
    op.drop_table('knowledge_history')
    for table in TOMBSTONE_TABLES:
        op.drop_index(f'ix_{table}_deleted_at', table_name=table)
        with op.batch_alter_table(table) as batch:
            batch.drop_column('deleted_at')
