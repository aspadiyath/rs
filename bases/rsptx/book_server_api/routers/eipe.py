# ***********************************************
# |docname| - Explain in Plain English questions
# ***********************************************
# An EiPE question (data-component="eipe", runestone/eipe) shows a function
# read-only and asks the student to explain it. Its source is a textarea
# holding the function and its tests, as in an activecode, so the helpers
# CodeTailor uses for activecode questions read it. This endpoint grades the
# explanation (see eipe_grading.py), writes it to eipe_answers with the code
# written from it, and scores it through the usual grading path.
#
# question_json.check_inputs, if the author gives it, lists argument strings
# (e.g. '["banana", "cherry", "cat"]') on which code written from an
# explanation must behave like the explained function -- inputs that separate
# it from plausible misreadings.
#
# Imports
# =======
# These are listed in the order prescribed by `PEP 8`_.
#
# Standard library
# ----------------
import asyncio
import json
from typing import Optional

# Third-party imports
# -------------------
from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import JSONResponse

# Local application imports
# -------------------------
from rsptx.auth.session import get_optional_user
from rsptx.db.crud import (
    create_answer_table_entry,
    create_useinfo_entry,
    fetch_course,
    is_on_open_timed_assessment,
)
from rsptx.db.models import EiPEAnswersValidation, UseinfoValidation
from rsptx.grading_helpers import grade_submission
from rsptx.logging import rslogger
from rsptx.response_helpers.core import canonical_utcnow
from rsptx.validation.schemas import LogItemIncoming

from ..activecode_questions import (
    clean_python_testcase,
    data_file_candidates,
    fetch_data_files,
    find_question,
    question_test_code,
    starter_code_from_question,
)
from ..openai_token import DEV_API_KEY, fetch_openai_token, uses_dev_api_key
from .eipe_grading import check_explanation, grade_explanation

# Routing
# =======
# See `APIRouter config` for an explanation of this approach.
router = APIRouter(
    prefix="/eipe",
    tags=["eipe"],
)


def _error(detail, code=status.HTTP_400_BAD_REQUEST):
    return JSONResponse(content={"detail": detail}, status_code=code)


@router.post("/check")
async def check(
    request: Request, course: Optional[str] = None, user=Depends(get_optional_user)
):
    """Grade an Explain in Plain English answer; see eipe_grading.py."""
    if user is None:
        return _error(
            "Log in to Runestone to check your explanation.",
            status.HTTP_401_UNAUTHORIZED,
        )
    data = await request.json()
    explanation = data.get("explanation") or ""
    # Explanations that can't be graded are turned back before any LLM call.
    problem_id = data.get("problem_id")
    if not problem_id:
        return _error("problem_id is required")
    problem = check_explanation(explanation)
    if problem:
        # Kept for research: which explanations students write that can't be
        # graded (pasted code, too long).
        try:
            await _log_rejected(user, course, problem_id, data, explanation)
        except Exception as e:
            rslogger.error(f"EiPE: couldn't log a rejected explanation: {e}")
        return {"status": "rejected", "message": problem}

    course_row = None
    if course:
        try:
            course_row = await fetch_course(course)
        except AttributeError:
            course_row = None
    basecourse = getattr(course_row, "base_course", None)
    question = await find_question(problem_id, basecourse)
    if not question:
        return _error(f"Question '{problem_id}' not found")
    if uses_dev_api_key(course):
        api_token = DEV_API_KEY
    else:
        api_token = await fetch_openai_token(course_row) if course_row else None
    if not api_token:
        return _error("This course has no OpenAI API token.")

    # The code and tests come from the database, never the client. Browsers
    # drop the newline right after <textarea>, so drop it here too or every
    # line number the student is shown would be off by one.
    reference = starter_code_from_question(question).removeprefix("\n")
    test_code = question_test_code(question)
    if test_code:
        test_code = clean_python_testcase(test_code)
    check_inputs = (question.question_json or {}).get("check_inputs") or []
    data_files = await fetch_data_files(
        data_file_candidates(question.htmlsrc, reference, test_code),
        list(
            dict.fromkeys(
                [(basecourse, course), (question.base_course, question.base_course)]
            )
        ),
    )

    # While a timed assessment that uses this question may still be taken,
    # students get no feedback at all: not the generated code, not the hints,
    # not even whether it passed. It's still graded and scored. Decided here,
    # not by the page, so calling this endpoint directly gets nothing more.
    exam = bool(course_row) and await is_on_open_timed_assessment(
        question.id, question.name, user.username, course_row.id
    )
    try:
        result = await asyncio.to_thread(
            grade_explanation,
            api_token,
            explanation,
            reference,
            test_code,
            check_inputs,
            data_files,
            hints=not exam,
        )
    except Exception as e:
        rslogger.error(f"EiPE: grading failed for '{question.name}': {e}")
        return {
            "status": "error",
            "message": "Sorry, your explanation couldn't be checked right now. "
            "Try again in a minute.",
        }
    await _record_grade(user, course, data, explanation, result, exam)
    if exam:
        return {"status": "submitted", "exam": True}
    return result


async def _record_grade(user, course, data, explanation, result, exam):
    """
    Save the graded explanation to eipe_answers, with the code written from it
    that students on an exam never see, and score it all or nothing through
    the usual grading path (which_to_grade, the gradebook, LTI). The page
    can't report a score itself: it never learns one on an exam.
    """
    passed = bool(result.get("passed"))
    div_id = data.get("problem_id")
    submission = LogItemIncoming(
        event="eipe",
        act="passed" if passed else "failed",
        div_id=div_id,
        course_name=course,
        correct=passed,
        percent=1.0 if passed else 0.0,
        selector_id=data.get("selector_id"),
        assignment_id=data.get("assignment_id"),
    )
    try:
        timestamp = canonical_utcnow()
        await create_useinfo_entry(
            UseinfoValidation(
                timestamp=timestamp,
                sid=user.username,
                event="eipe",
                act=submission.act,
                div_id=div_id,
                course_id=course,
            )
        )
        await create_answer_table_entry(
            EiPEAnswersValidation(
                timestamp=timestamp,
                div_id=div_id,
                sid=user.username,
                course_name=course,
                correct=passed,
                percent=submission.percent,
                answer=explanation,
                generated_code=result.get("generated_code"),
                details={
                    "aid": data.get("aid"),
                    "exam": exam,
                    "counterexample": result.get("counterexample"),
                    "missed": result.get("missed"),
                },
            ),
            "eipe",
        )
        await grade_submission(user, submission)
    except Exception as e:
        # A grade that fails to save must not hide the result from the student.
        rslogger.error(f"EiPE: couldn't record the grade for '{div_id}': {e}")


async def _log_rejected(user, course, div_id, data, explanation):
    """A useinfo row for an explanation turned back before grading. It has no
    answer row: it wasn't graded."""
    await create_useinfo_entry(
        UseinfoValidation(
            timestamp=canonical_utcnow(),
            sid=user.username,
            event="eipe_rejected",
            # useinfo keeps 512 characters of an act, and a rejected
            # explanation may be over the limit.
            act=json.dumps({"aid": data.get("aid"), "explanation": explanation[:400]}),
            div_id=div_id,
            course_id=course,
        )
    )
