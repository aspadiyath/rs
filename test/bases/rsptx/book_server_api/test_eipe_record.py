"""
A graded Explain in Plain English answer is saved to eipe_answers, with the
code written from it, and scored through the usual grading path.
"""

import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from rsptx.book_server_api.routers import eipe
from rsptx.db.async_session import async_session
from rsptx.db.crud import (
    create_assignment,
    create_assignment_question,
    create_question,
    fetch_course,
    fetch_question_grade,
)
from rsptx.db.models import (
    AssignmentQuestionValidator,
    AssignmentValidator,
    EiPEAnswers,
    QuestionValidator,
)
from rsptx.response_helpers.core import canonical_utcnow

pytestmark = pytest.mark.asyncio(loop_scope="session")

COURSE_NAME = "test_course_1"


@pytest.fixture(scope="session")
async def eipe_assignment(init_test_db):
    course = await fetch_course(COURSE_NAME)
    questions = {}
    for name in ("eipe_record_passed", "eipe_record_failed"):
        questions[name] = await create_question(
            QuestionValidator(
                base_course=COURSE_NAME,
                name=name,
                chapter="ch1",
                subchapter="sub1",
                author="testuser1",
                timestamp=canonical_utcnow(),
                question_type="eipe",
                is_private=False,
                from_source=False,
                review_flag=False,
            )
        )
    assignment = await create_assignment(
        AssignmentValidator(
            course=course.id,
            name="eipe_record_homework",
            points=2,
            released=True,
            duedate=datetime.datetime(2099, 1, 1),
            visible=True,
            from_source=False,
            is_peer=False,
            is_timed=False,
            kind="Regular",
            current_index=0,
            peer_async_visible=False,
        )
    )
    for question in questions.values():
        await create_assignment_question(
            AssignmentQuestionValidator(
                assignment_id=assignment.id,
                question_id=question.id,
                points=1,
                activities_required=0,
                reading_assignment=False,
                sorting_priority=0,
                which_to_grade="last_answer",
                autograde="pct_correct",
            )
        )
    # grade_submission needs only who the student is and in which course.
    user = SimpleNamespace(
        username="testuser1", course_id=course.id, course_name=COURSE_NAME
    )
    return SimpleNamespace(assignment=assignment, user=user)


async def _answers(div_id):
    async with async_session() as session:
        rows = await session.execute(
            select(EiPEAnswers).where(EiPEAnswers.div_id == div_id)
        )
        return rows.scalars().all()


async def _record(setup, div_id, passed, exam=False):
    await eipe._record_grade(
        setup.user,
        COURSE_NAME,
        {
            "problem_id": div_id,
            "aid": f"{div_id}-1",
            "assignment_id": setup.assignment.id,
        },
        "returns the largest number in the list",
        {
            "passed": passed,
            "generated_code": "def foo(nums):\n    return max(nums)",
            "counterexample": None if passed else {"input": "[3, 9, 2]"},
            "missed": None,
        },
        exam,
    )


async def test_a_passing_explanation_is_saved_and_scored(eipe_assignment):
    await _record(eipe_assignment, "eipe_record_passed", passed=True)
    [row] = await _answers("eipe_record_passed")
    assert row.answer == "returns the largest number in the list"
    assert row.generated_code == "def foo(nums):\n    return max(nums)"
    assert row.correct
    assert row.details["aid"] == "eipe_record_passed-1"
    grade = await fetch_question_grade("testuser1", COURSE_NAME, "eipe_record_passed")
    assert grade.score == 1


async def test_a_failing_explanation_keeps_where_it_differed(eipe_assignment):
    await _record(eipe_assignment, "eipe_record_failed", passed=False, exam=True)
    [row] = await _answers("eipe_record_failed")
    assert not row.correct
    assert row.details == {
        "aid": "eipe_record_failed-1",
        "exam": True,
        "counterexample": {"input": "[3, 9, 2]"},
        "missed": None,
    }
    grade = await fetch_question_grade("testuser1", COURSE_NAME, "eipe_record_failed")
    assert grade.score == 0
