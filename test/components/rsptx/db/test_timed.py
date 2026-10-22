"""
Tests for is_on_open_timed_assessment, which decides that an Explain in Plain
English question gives no feedback because it's on an exam.
"""

import datetime
import pytest

from rsptx.db.crud import (
    create_assignment,
    create_assignment_question,
    create_question,
    create_selected_question,
    is_on_open_timed_assessment,
)
from rsptx.db.models import (
    AssignmentQuestionValidator,
    AssignmentValidator,
    QuestionValidator,
)
from rsptx.response_helpers.core import canonical_utcnow

pytestmark = pytest.mark.asyncio(loop_scope="session")

COURSE_NAME = "test_course_1"


async def _question(name, question_type="activecode"):
    return await create_question(
        QuestionValidator(
            base_course=COURSE_NAME,
            name=name,
            chapter="ch1",
            subchapter="sub1",
            author="testuser1",
            timestamp=canonical_utcnow(),
            question_type=question_type,
            is_private=False,
            from_source=False,
            review_flag=False,
        )
    )


async def _assignment(course, name, timed, duedate, questions):
    assignment = await create_assignment(
        AssignmentValidator(
            course=course.id,
            name=name,
            points=1,
            released=True,
            duedate=duedate,
            visible=True,
            from_source=False,
            is_peer=False,
            is_timed=timed,
            kind="Timed" if timed else "Regular",
            current_index=0,
            peer_async_visible=False,
        )
    )
    for question in questions:
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


@pytest.fixture(scope="session")
async def exam_questions(test_course):
    future = datetime.datetime(2099, 1, 1)
    past = datetime.datetime(2000, 1, 1)
    on_exam = await _question("timed_eipe_on_exam")
    served = await _question("timed_eipe_served")
    selector = await _question("timed_eipe_selector", "selectquestion")
    homework = await _question("timed_eipe_homework")
    old_exam = await _question("timed_eipe_old_exam")
    await _assignment(test_course, "timed_open_exam", True, future, [on_exam, selector])
    await _assignment(test_course, "timed_homework", False, future, [homework])
    await _assignment(test_course, "timed_past_exam", True, past, [old_exam])
    await create_selected_question("testuser1", selector.name, served.name)
    return dict(on_exam=on_exam, served=served, homework=homework, old_exam=old_exam)


async def _open(question, sid, course):
    return await is_on_open_timed_assessment(question.id, question.name, sid, course.id)


async def test_question_on_an_open_exam(exam_questions, test_course):
    assert await _open(exam_questions["on_exam"], "testuser1", test_course)


async def test_question_served_by_a_select_question_on_an_open_exam(
    exam_questions, test_course
):
    assert await _open(exam_questions["served"], "testuser1", test_course)
    # only for the student it was served to
    assert not await _open(exam_questions["served"], "testuser2", test_course)


async def test_homework_and_past_exams_are_not_open_exams(exam_questions, test_course):
    assert not await _open(exam_questions["homework"], "testuser1", test_course)
    assert not await _open(exam_questions["old_exam"], "testuser1", test_course)
