# ***********************************************
# |docname| - Explain in Plain English questions
# ***********************************************
# An activecode question with data-eipe="true" shows its code read-only and
# asks the student to explain it. This endpoint grades the explanation (see
# eipe_grading.py), scores it like an activecode run, and keeps the full
# grading record for instructors.
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
    create_useinfo_entry,
    fetch_api_token,
    fetch_course,
    fetch_question,
    is_on_open_timed_assessment,
)
from rsptx.db.models import UseinfoValidation
from rsptx.logging import rslogger
from rsptx.response_helpers.core import canonical_utcnow
from rsptx.validation.schemas import LogItemIncoming

# The question-reading helpers CodeTailor already uses for activecode
# questions (their code, tests and data files).
from .coach import (
    DEV_API_KEY,
    _data_file_candidates,
    _extract_suffix_code_from_htmlsrc,
    _fetch_data_files,
    _starter_code_from_question,
    clean_python_testcase,
)
from .eipe_grading import check_explanation, grade_explanation
from .rslogging import log_book_event

# Routing
# =======
# See `APIRouter config` for an explanation of this approach.
router = APIRouter(
    prefix="/eipe",
    tags=["eipe"],
)


def _error(detail, code=status.HTTP_400_BAD_REQUEST):
    return JSONResponse(content={"detail": detail}, status_code=code)


async def _find_question(name, course_row):
    """The course's base course first, then a global name match (a cloned
    course or a question from another book), as CodeTailor does."""
    basecourse = getattr(course_row, "base_course", None)
    question = await fetch_question(name, basecourse=basecourse) if basecourse else None
    return question or await fetch_question(name)


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
            await _log(user, course, problem_id, "eipe_rejected", data, explanation)
        except Exception as e:
            rslogger.error(f"EiPE: couldn't log a rejected explanation: {e}")
        return {"status": "rejected", "message": problem}

    course_row = None
    if course:
        try:
            course_row = await fetch_course(course)
        except AttributeError:
            course_row = None
    question = await _find_question(problem_id, course_row)
    if not question:
        return _error(f"Question '{problem_id}' not found")
    if course is None or course == "personalized_parsons":
        api_token = DEV_API_KEY
    else:
        token_record = (
            await fetch_api_token(course_id=course_row.id, provider="openai")
            if course_row
            else None
        )
        api_token = token_record.token if token_record else None
    if not api_token:
        return _error("This course has no OpenAI API token.")

    # The code and tests come from the database, never the client. Browsers
    # drop the newline right after <textarea>, so drop it here too or every
    # line number the student is shown would be off by one.
    reference = _starter_code_from_question(question).removeprefix("\n")
    test_code = (question.question_json or {}).get(
        "suffix_code"
    ) or _extract_suffix_code_from_htmlsrc(question.htmlsrc)
    if test_code:
        test_code = clean_python_testcase(test_code)
    check_inputs = (question.question_json or {}).get("check_inputs") or []
    basecourse = getattr(course_row, "base_course", None)
    data_files = await _fetch_data_files(
        _data_file_candidates(question.htmlsrc, reference, test_code),
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
    await _record_grade(request, user, course, data, explanation, result, exam)
    if exam:
        return {"status": "submitted", "exam": True}
    return result


async def _record_grade(request, user, course, data, explanation, result, exam):
    """
    Score the explanation the way an activecode run is scored, with a
    ``unittest`` event (all or nothing), so it reaches the gradebook through
    the usual which_to_grade rules. Also keep the full grading record, with
    the generated code students may not see, for instructors reviewing
    grades.
    """
    passed = bool(result.get("passed"))
    div_id = data.get("problem_id")
    try:
        await log_book_event(
            LogItemIncoming(
                event="unittest",
                act=f"percent:{100.0 if passed else 0.0}:passed:"
                f"{int(passed)}:failed:{int(not passed)}",
                div_id=div_id,
                course_name=course,
                selector_id=data.get("selector_id"),
                assignment_id=data.get("assignment_id"),
            ),
            request,
            user,
        )
        await _log(
            user,
            course,
            div_id,
            "eipe_graded",
            data,
            explanation,
            exam=exam,
            passed=passed,
            generated_code=result.get("generated_code"),
            counterexample=result.get("counterexample"),
            missed=result.get("missed"),
        )
    except Exception as e:
        # A grade that fails to save must not hide the result from the student.
        rslogger.error(f"EiPE: couldn't record the grade for '{div_id}': {e}")


async def _log(user, course, div_id, event, data, explanation, **fields):
    """A useinfo row with the whole record: written directly because the
    logging endpoint keeps only 512 characters of an act."""
    await create_useinfo_entry(
        UseinfoValidation(
            timestamp=canonical_utcnow(),
            sid=user.username,
            event=event,
            act=json.dumps(
                {"aid": data.get("aid"), "explanation": explanation, **fields}
            ),
            div_id=div_id,
            course_id=course,
        )
    )
