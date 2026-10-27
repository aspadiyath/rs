"""add eipe answers

Explain in Plain English answers (data-component="eipe"). The book server's
grading endpoint writes these rows itself: the explanation, the code an LLM
wrote from it, and the rest of the grading record, so instructors can review
grades. Modeled on add_matching_answers (8559d59ae185).

Revision ID: e1f7a3c9d2b5
Revises: a6c2e9f4b1d7
Create Date: 2026-10-27 15:30:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from rsptx.db.models import Web2PyBoolean

# revision identifiers, used by Alembic.
revision: str = "e1f7a3c9d2b5"
down_revision: Union[str, None] = "a6c2e9f4b1d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "eipe_answers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("timestamp", sa.DateTime(), nullable=False),
        sa.Column("div_id", sa.String(length=512), nullable=False),
        sa.Column("sid", sa.String(length=512), nullable=False),
        sa.Column("correct", Web2PyBoolean(length=1), nullable=False),
        sa.Column("percent", sa.Float(), nullable=True),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("generated_code", sa.Text(), nullable=True),
        sa.Column("details", sa.JSON(), nullable=True),
        sa.Column("course_name", sa.String(length=512), nullable=False),
        sa.ForeignKeyConstraint(
            ["course_name"],
            ["courses.course_name"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_div_sid_course_eipe",
        "eipe_answers",
        ["sid", "div_id", "course_name"],
        unique=False,
    )
    op.create_index(
        op.f("ix_eipe_answers_course_name"),
        "eipe_answers",
        ["course_name"],
        unique=False,
    )
    op.create_index(
        op.f("ix_eipe_answers_div_id"), "eipe_answers", ["div_id"], unique=False
    )
    op.create_index(op.f("ix_eipe_answers_sid"), "eipe_answers", ["sid"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_eipe_answers_sid"), table_name="eipe_answers")
    op.drop_index(op.f("ix_eipe_answers_div_id"), table_name="eipe_answers")
    op.drop_index(op.f("ix_eipe_answers_course_name"), table_name="eipe_answers")
    op.drop_index("idx_div_sid_course_eipe", table_name="eipe_answers")
    op.drop_table("eipe_answers")
