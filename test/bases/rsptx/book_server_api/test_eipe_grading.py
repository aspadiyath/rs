"""
Tests for the Explain in Plain English helpers that run before and after the
LLM call: which explanations get turned back, the function header the
generated code must match, comparing call results, cleaning up the
model's answer, and the hint that points at lines an explanation missed.
"""

import subprocess
import sys

import pytest

from rsptx.book_server_api.routers import eipe_grading
from rsptx.book_server_api.routers.eipe_grading import (
    MAX_EXPLANATION_CHARS,
    check_explanation,
    compare,
    counterexample_test,
    example_call,
    focus_question,
    function_header,
    inputs_from_tests,
    numbered_lines,
    same_outcome,
    strip_code_fences,
)


@pytest.mark.parametrize(
    "explanation",
    [
        "returns the largest number in the list",
        "returns the letter that the most words start with, ignoring case",
        "counts how many words are longer than five letters",
        "gives back True if the list is sorted from smallest to largest",
    ],
)
def test_plain_english_is_accepted(explanation):
    assert check_explanation(explanation) is None


@pytest.mark.parametrize(
    "explanation",
    [
        "def foo(nums): return max(nums)",
        "for n in nums: if n > result: result = n",
        "if n > result: result = n",
        "result += n for every n",
        "returns nums[0] when the list is sorted",
        "returns `max(nums)`",
        "loops:\n    result = n",
    ],
)
def test_code_is_turned_back(explanation):
    assert "looks like code" in check_explanation(explanation)


def test_empty_explanation_is_turned_back():
    assert check_explanation("   ") == "Write an explanation first."


def test_long_explanation_is_turned_back():
    message = check_explanation("a" * (MAX_EXPLANATION_CHARS + 1))
    assert str(MAX_EXPLANATION_CHARS) in message


def test_function_header_takes_the_first_top_level_def():
    code = "import csv\n\ndef foo(nums, n=3):\n    def helper(x):\n        pass\n"
    assert function_header(code) == ("foo", "nums, n=3")


def test_function_header_is_none_without_a_function():
    assert function_header("print('hi')\n") is None


def test_code_fences_are_stripped():
    answer = "```python\ndef foo(nums):\n    return max(nums)\n```"
    assert strip_code_fences(answer) == "def foo(nums):\n    return max(nums)"


def test_unfenced_code_is_left_alone():
    assert strip_code_fences("def foo():\n    pass\n") == "def foo():\n    pass"


def test_equal_values_agree():
    assert same_outcome({"value": "3", "printed": ""}, {"value": "3", "printed": ""})


def test_different_values_disagree():
    assert not same_outcome(
        {"value": "'c'", "printed": ""}, {"value": "'a'", "printed": ""}
    )


def test_any_two_exceptions_agree():
    assert same_outcome(
        {"error": "IndexError: list index out of range", "printed": ""},
        {"error": "ValueError: max() arg is an empty sequence", "printed": ""},
    )


def test_an_exception_and_a_value_disagree():
    assert not same_outcome(
        {"value": "None", "printed": ""},
        {"error": "IndexError: list index out of range", "printed": ""},
    )


def test_different_printed_output_disagrees():
    assert not same_outcome(
        {"value": "None", "printed": "hi\n"}, {"value": "None", "printed": ""}
    )


# Pointing at missed lines
# ------------------------
LETTER = """def mystery(words):
    d = {}
    for w in words:
        k = w[0].lower()
        d[k] = d.get(k, 0) + 1
    best = None
    for k in d:
        if best is None or d[k] > d[best]:
            best = k
    return best
"""


def _run_locally(program, time_limit=6, data_files=None):
    """Stand-in for JOBE: run the program in a local Python."""
    done = subprocess.run(
        [sys.executable, "-I", "-c", program],
        capture_output=True,
        text=True,
        timeout=time_limit,
    )
    return done.stdout, done.stderr


@pytest.fixture
def local_python(monkeypatch):
    monkeypatch.setattr(eipe_grading, "run_python_program", _run_locally)


def test_inputs_come_from_the_tests_literal_calls():
    tests = """
class myTests(unittest.TestCase):
    def testOne(self):
        self.assertEqual(mystery(["cat", "Car"]), "c")
        self.assertEqual(mystery([]), None)
        self.assertEqual(mystery(make_words()), "a")
        self.assertEqual(len(mystery(["cat", "Car"])), 1)
"""
    assert inputs_from_tests(tests, "mystery") == ['["cat", "Car"]', "[]"]


def test_no_inputs_from_unparseable_tests():
    assert inputs_from_tests("def broken(:", "mystery") == []


def test_numbered_lines_skip_the_header_and_blank_lines():
    lines = numbered_lines("def foo(x):\n\n    # note\n    return x\n")
    assert lines == {4: "    return x"}


def test_focus_question_traces_an_assignment(local_python):
    question = focus_question(LETTER, 4, '["banana", "cherry", "cat"]')
    assert question == {
        "line": 4,
        "call": 'mystery(["banana", "cherry", "cat"])',
        "variable": "k",
        "values": ["'b'", "'c'", "'c'"],
    }


def test_focus_question_traces_a_return(local_python):
    question = focus_question(LETTER, 10, '["banana", "cherry", "cat"]')
    assert question["variable"] is None
    assert question["values"] == ["'c'"]


def test_no_focus_question_for_a_line_that_assigns_nothing(local_python):
    assert focus_question(LETTER, 3, '["banana"]') is None


def test_compare_finds_the_input_where_the_functions_differ(local_python):
    every_letter = LETTER.replace("k = w[0].lower()", "k = w.lower()")
    # the whole word, not its first letter
    counterexample = compare(LETTER, every_letter, ['["cat", "car"]', '["ab", "b"]'])
    assert counterexample["input"] == '["cat", "car"]'
    assert counterexample["expected"]["value"] == "'c'"
    assert compare(LETTER, LETTER, ['["cat", "car"]']) is None


def test_counterexample_becomes_a_test():
    counterexample = {
        "input": '["banana", "cherry", "cat"]',
        "expected": {"value": "'c'", "printed": ""},
        "got": {"value": "'a'", "printed": ""},
    }
    assert counterexample_test("mystery", counterexample) == (
        'self.assertEqual(mystery(["banana", "cherry", "cat"]), \'c\', '
        '\'mystery(["banana", "cherry", "cat"])\')'
    )


@pytest.mark.parametrize(
    "expected, got",
    [
        # not a literal
        ({"value": "<Foo object>", "printed": ""}, {"value": "1", "printed": ""}),
        # the function raised
        ({"error": "IndexError: x", "printed": ""}, {"value": "1", "printed": ""}),
        # only the printed output differs
        ({"value": "None", "printed": "hi"}, {"value": "None", "printed": ""}),
    ],
)
def test_no_test_from_a_counterexample_that_cant_be_asserted(expected, got):
    counterexample = {"input": "[1]", "expected": expected, "got": got}
    assert counterexample_test("foo", counterexample) is None


def test_example_call_prefers_the_counterexample():
    counterexample = {"input": "[7]"}
    assert example_call("foo", counterexample, ["[1, 2]"]) == "foo([7])"
    assert example_call("foo", None, ["[1, 2]"]) == "foo([1, 2])"
    assert example_call("foo", None, []) is None
