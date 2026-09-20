"""Add pre-generated learning assets to article variants.

Revision ID: 0002_learning_assets
Revises: 0001_content_pipeline
"""

from alembic import op
import sqlalchemy as sa


revision = "0002_learning_assets"
down_revision = "0001_content_pipeline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("article_variants") as batch:
        batch.add_column(sa.Column("sentence_translations", sa.JSON(), nullable=False, server_default="{}"))
        batch.add_column(sa.Column("glossary", sa.JSON(), nullable=False, server_default="[]"))


def downgrade() -> None:
    with op.batch_alter_table("article_variants") as batch:
        batch.drop_column("glossary")
        batch.drop_column("sentence_translations")
