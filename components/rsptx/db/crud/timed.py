from typing import List, Tuple
from datetime import datetime
from sqlalchemy import select, update, delete, and_

from ..models import (
    TimedExam,
    TimedExamValidator,
    Useinfo,
    Assignment,
    AssignmentQuestion,
    Question,
    SelectedQuestion,
)
from ..async_session import async_session
from rsptx.logging import rslogger
from rsptx.response_helpers.core import canonical_utcnow


async def fetch_timed_exam(
    sid: str, exam_id: str, course_name: str
) -> TimedExamValidator:
    """
    Retrieve the TimedExam entry for the given sid, exam_id, and course_name.

    :param sid: str, the student id
    :param exam_id: str, the id of the timed exam
    :param course_name: str, the name of the course
    :return: TimedExamValidator, the TimedExamValidator object
    """
    query = (
        select(TimedExam)
        .where(
            (TimedExam.div_id == exam_id)
            & (TimedExam.sid == sid)
            & (TimedExam.course_name == course_name)
        )
        .order_by(TimedExam.id.desc())
    )
    async with async_session() as session:
        res = await session.execute(query)
        rslogger.debug(f"{res=}")
        return TimedExamValidator.from_orm(res.scalars().first())


async def did_start_timed(sid: str, exam_id: str, course_name: str) -> bool:
    """
    Retrieve the start time for the given sid, exam_id, and course_name.

    :param sid: str, the student id
    :param exam_id: str, the id of the timed exam
    :param course_name: str, the name of the course
    :return: bool, whether the exam has started
    """
    start_query = select(Useinfo).where(
        and_(
            Useinfo.sid == sid,
            Useinfo.div_id == exam_id,
            Useinfo.course_id == course_name,
            Useinfo.event == "timedExam",
            Useinfo.act == "start",
        )
    )
    async with async_session() as session:
        start = await session.execute(start_query)
        return start.scalars().first() is not None


async def create_timed_exam_entry(
    sid: str, exam_id: str, course_name: str, start_time: datetime
) -> TimedExamValidator:
    """
    Create a new TimedExam entry with the given sid, exam_id, course_name, and start_time.

    :param sid: str, the student id
    :param exam_id: str, the id of the timed exam
    :param course_name: str, the name of the course
    :param start_time: datetime, the start time of the exam
    :return: TimedExamValidator, the TimedExamValidator object
    """
    new_te = TimedExam(
        div_id=exam_id,
        sid=sid,
        course_name=course_name,
        start_time=start_time,
        correct=0,
        incorrect=0,
        skipped=0,
    )
    async with async_session.begin() as session:
        session.add(new_te)
    return TimedExamValidator.from_orm(new_te)


async def fetch_timed_assessments(course_id: int) -> List[Tuple[str, str]]:
    """
    Retrieve all timed assessments for a given course.

    :param course_id: int, the course id
    :return: List[Tuple[str, str]], list of (name, description) tuples for timed assessments
    """
    query = (
        select(Assignment.name, Assignment.description)
        .where(
            (Assignment.course == course_id)
            & ((Assignment.is_timed == "T") | (Assignment.kind == "Timed"))
        )
        .order_by(Assignment.name)
    )

    async with async_session() as session:
        res = await session.execute(query)
        return [(row.name, row.description or "") for row in res.all()]


async def is_on_open_timed_assessment(question_id: int, course_id: int) -> bool:
    """
    Whether a question is on a timed assessment in this course that isn't
    past due. Explain in Plain English questions use this to withhold the code
    generated from a student's explanation, and every hint, while an exam that
    uses them may still be taken; the decision is the server's, so a student
    can't get the feedback by calling the grading endpoint directly.

    :param question_id: int, the question's id
    :param course_id: int, the course id
    :return: bool, True if any such assessment exists
    """
    query = (
        select(Assignment.id)
        .join(AssignmentQuestion, AssignmentQuestion.assignment_id == Assignment.id)
        .where(
            (AssignmentQuestion.question_id == question_id)
            & (Assignment.course == course_id)
            & ((Assignment.is_timed == "T") | (Assignment.kind == "Timed"))
            & (Assignment.duedate > canonical_utcnow())
        )
        .limit(1)
    )
    async with async_session() as session:
        res = await session.execute(query)
        return res.first() is not None


async def was_served_on_open_timed_assessment(
    sid: str, question_name: str, course_id: int
) -> bool:
    """
    Whether a select question on a timed assessment in this course that
    isn't past due served this question to this student. Exams usually wrap
    their questions in select questions, so the assessment lists the select
    question, not the question the student sees; ``selected_questions`` has
    the server's record of what each student was served.

    :param sid: str, the student's username
    :param question_name: str, the served question's name (div_id)
    :param course_id: int, the course id
    :return: bool, True if any such assessment served it
    """
    query = (
        select(Assignment.id)
        .join(AssignmentQuestion, AssignmentQuestion.assignment_id == Assignment.id)
        .join(Question, Question.id == AssignmentQuestion.question_id)
        .join(SelectedQuestion, SelectedQuestion.selector_id == Question.name)
        .where(
            (SelectedQuestion.sid == sid)
            & (SelectedQuestion.selected_id == question_name)
            & (Assignment.course == course_id)
            & ((Assignment.is_timed == "T") | (Assignment.kind == "Timed"))
            & (Assignment.duedate > canonical_utcnow())
        )
        .limit(1)
    )
    async with async_session() as session:
        res = await session.execute(query)
        return res.first() is not None


async def reset_student_assessment(
    username: str, assessment_name: str, course_name: str
) -> bool:
    """
    Reset a student's timed assessment by:
    1. Updating useinfo records to set act="start_reset"
    2. Deleting timed_exam records
    3. Deleting selected_questions records for exam questions

    :param username: str, the student's username
    :param assessment_name: str, the name of the assessment to reset
    :param course_name: str, the name of the course
    :return: bool, True if reset was successful
    """
    try:
        async with async_session.begin() as session:
            # Update useinfo records for this exam to mark as reset
            useinfo_update = (
                update(Useinfo)
                .where(
                    (Useinfo.sid == username)
                    & (Useinfo.div_id == assessment_name)
                    & (Useinfo.course_id == course_name)
                    & (Useinfo.event == "timedExam")
                )
                .values(act="start_reset")
            )
            await session.execute(useinfo_update)

            # Delete timed_exam records
            timed_exam_delete = delete(TimedExam).where(
                (TimedExam.sid == username)
                & (TimedExam.div_id == assessment_name)
                & (TimedExam.course_name == course_name)
            )
            await session.execute(timed_exam_delete)

            # Get all question names for this assessment
            assessment_questions_query = (
                select(Question.name)
                .join(AssignmentQuestion, Question.id == AssignmentQuestion.question_id)
                .join(Assignment, AssignmentQuestion.assignment_id == Assignment.id)
                .where(Assignment.name == assessment_name)
            )
            question_result = await session.execute(assessment_questions_query)
            question_names = [row for row in question_result.scalars().all()]

            # Delete selected_questions records for all questions in this exam
            if question_names:
                selected_questions_delete = delete(SelectedQuestion).where(
                    (SelectedQuestion.sid == username)
                    & (SelectedQuestion.selector_id.in_(question_names))
                )
                await session.execute(selected_questions_delete)

            return True

    except Exception as e:
        rslogger.error(f"Error resetting exam {course_name}: {e}")
        return False
