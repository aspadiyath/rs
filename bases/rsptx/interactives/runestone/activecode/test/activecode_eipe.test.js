// Tests for Explain in Plain English activecodes (data-eipe="true").
// No jquery-globals import -- this component must work without jQuery.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import ACFactory from "../js/acfactory.js";
import { ActiveCode } from "../js/activecode.js";
import EiPEActiveCode, {
    TimedEiPEActiveCode,
    testsForBrowser,
} from "../js/activecode_eipe.js";

function makeFixture(id) {
    document.body.innerHTML = `
      <div class="runestone">
        <div data-component="activecode" id="${id}" class="ac_section">
          <textarea data-lang="python" data-eipe="true">def foo(nums):
    return max(nums)
====
import unittest
</textarea>
        </div>
      </div>`;
    return document.getElementById(id);
}

function respondWith(body, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({
        ok: ok,
        status: ok ? 200 : 400,
        json: () => Promise.resolve(body),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

beforeEach(() => {
    document.body.innerHTML = "";
    window.componentMap = {};
    window.allComponents = [];
    localStorage.clear();
    eBookConfig.new_server_prefix = "/ns";
    eBookConfig.course = "testcourse";
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EiPEActiveCode", () => {
    it("is what the factory builds for a data-eipe activecode", () => {
        const ac = ACFactory.createActiveCode(makeFixture("eipe_1"), "python", {
            useRunestoneServices: false,
        });
        expect(ac).toBeInstanceOf(EiPEActiveCode);
    });

    it("shows the code read-only with no run controls", () => {
        const ac = new EiPEActiveCode({ orig: makeFixture("eipe_2") });
        expect(ac.editor.getOption("readOnly")).toBe(true);
        expect(ac.controlDiv.style.display).toBe("none");
        // the hidden tests stay out of the shown code
        expect(ac.editor.getValue()).not.toContain("unittest");
        expect(ac.explanationBox.maxLength).toBe(250);
    });

    it("doesn't call the server for an empty explanation", async () => {
        const fetchMock = respondWith({});
        const ac = new EiPEActiveCode({ orig: makeFixture("eipe_3") });
        await ac.checkExplanation();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ac.resultDiv.querySelector(".alert-warning")).not.toBeNull();
    });

    it("sends the explanation and shows the code it produced", async () => {
        const fetchMock = respondWith({
            status: "graded",
            passed: true,
            generated_code: "def foo(nums):\n    return max(nums)",
            counterexample: null,
            test_output: "",
        });
        const ac = new EiPEActiveCode({ orig: makeFixture("eipe_4") });
        ac.logBookEvent = vi.fn();
        ac.explanationBox.value = "returns the largest number in the list";
        await ac.checkExplanation();

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("/ns/eipe/check?course=testcourse");
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({
            problem_id: "eipe_4",
            explanation: "returns the largest number in the list",
        });
        // the server records the full grading record under the same id
        expect(body.aid).toBe(ac.lastAid);
        expect(ac.resultDiv.querySelector(".alert-success")).not.toBeNull();
        expect(ac.resultDiv.querySelector(".eipe-counterexample")).toBeNull();
        expect(ac.generatedCode.editor.getValue()).toContain(
            "return max(nums)",
        );
        // the server records the check; the page logs nothing of its own
        expect(ac.logBookEvent).not.toHaveBeenCalled();
    });

    it("shows an input where the generated code differs", async () => {
        respondWith({
            status: "graded",
            passed: false,
            generated_code: "def foo(nums):\n    return min(nums)",
            counterexample: {
                input: "[3, 9, 2]",
                expected: { value: "9", printed: "" },
                got: { error: "ValueError: empty", printed: "" },
            },
            test_output: "AssertionError: 2 != 9",
        });
        const ac = new EiPEActiveCode({ orig: makeFixture("eipe_5") });
        ac.logBookEvent = vi.fn();
        ac.explanationBox.value = "returns the smallest number";
        await ac.checkExplanation();
        expect(ac.resultDiv.querySelector(".alert-danger")).not.toBeNull();
        const box = ac.resultDiv.querySelector(".eipe-counterexample");
        expect(box.textContent).toContain("foo([3, 9, 2])");
        expect(box.textContent).toContain("9");
        expect(box.textContent).toContain("raises ValueError: empty");
    });

    it("says so when the generated code timed out", async () => {
        respondWith({
            status: "graded",
            passed: false,
            generated_code: "def foo(nums):\n    while True: pass",
            counterexample: { input: null, expected: null, got: {} },
        });
        const ac = new EiPEActiveCode({ orig: makeFixture("eipe_6") });
        ac.logBookEvent = vi.fn();
        ac.explanationBox.value = "keeps going forever";
        await ac.checkExplanation();
        expect(
            ac.resultDiv.querySelector(".eipe-counterexample").textContent,
        ).toContain("took too long");
    });

    it("shows the server's reason when it turns an explanation back", async () => {
        respondWith({ status: "rejected", message: "That looks like code." });
        const ac = new EiPEActiveCode({ orig: makeFixture("eipe_7") });
        ac.logBookEvent = vi.fn();
        ac.explanationBox.value = "for n in nums: if n > result: result = n";
        await ac.checkExplanation();
        const warning = ac.resultDiv.querySelector(".alert-warning");
        expect(warning.textContent).toBe("That looks like code.");
        expect(ac.generatedCode).toBeUndefined();
    });

    describe("pointing at missed lines", () => {
        const missedResult = {
            status: "graded",
            passed: false,
            generated_code: "def foo(nums):\n    return min(nums)",
            counterexample: {
                input: "[3, 9, 2]",
                expected: { value: "9", printed: "" },
                got: { value: "2", printed: "" },
            },
            missed: {
                lines: [2],
                question: {
                    line: 2,
                    call: "foo([3, 9, 2])",
                    variable: null,
                    values: ["9"],
                },
            },
        };

        function highlighted(ac) {
            const lines = [];
            for (let i = 0; i < ac.editor.lineCount(); i++) {
                const info = ac.editor.lineInfo(i);
                if ((info.bgClass || "").includes("eipe-missed-line")) {
                    lines.push(i + 1);
                }
            }
            return lines;
        }

        async function explain(ac, result) {
            respondWith(result);
            ac.explanationBox.value = "returns the smallest number";
            await ac.checkExplanation();
        }

        it("highlights the missed line and says which it is", async () => {
            const ac = new EiPEActiveCode({ orig: makeFixture("miss_1") });
            ac.logBookEvent = vi.fn();
            await explain(ac, missedResult);
            expect(highlighted(ac)).toEqual([2]);
            expect(
                ac.resultDiv.querySelector(".eipe-missed").textContent,
            ).toContain("line 2");
            // a first miss gets the highlight alone
            expect(ac.resultDiv.querySelector(".eipe-focus")).toBeNull();
        });

        it("clears the highlight on the next check", async () => {
            const ac = new EiPEActiveCode({ orig: makeFixture("miss_2") });
            ac.logBookEvent = vi.fn();
            await explain(ac, missedResult);
            await explain(ac, {
                status: "graded",
                passed: true,
                generated_code: "def foo(nums):\n    return max(nums)",
            });
            expect(highlighted(ac)).toEqual([]);
        });

        it("asks for a prediction when the same line is missed again", async () => {
            const ac = new EiPEActiveCode({ orig: makeFixture("miss_3") });
            ac.logBookEvent = vi.fn();
            await explain(ac, missedResult);
            await explain(ac, missedResult);
            const focus = ac.resultDiv.querySelector(".eipe-focus");
            expect(focus.querySelector("label").textContent).toContain(
                "foo([3, 9, 2])",
            );
            const answer = focus.querySelector(".eipe-focus-answer");
            const button = focus.querySelector("button");

            // nothing is revealed until the student commits to a prediction
            button.click();
            expect(answer.textContent).toBe("");

            focus.querySelector("input").value = "3";
            button.click();
            expect(answer.textContent).toContain("9");
            expect(button.disabled).toBe(true);
            const logged = ac.logBookEvent.mock.calls.at(-1)[0];
            expect(logged.event).toBe("eipe_focus");
            expect(JSON.parse(logged.act).prediction).toBe("3");
        });

        it("doesn't ask when the next miss is somewhere else", async () => {
            const ac = new EiPEActiveCode({ orig: makeFixture("miss_4") });
            ac.logBookEvent = vi.fn();
            await explain(ac, missedResult);
            await explain(ac, {
                ...missedResult,
                missed: { lines: [1], question: missedResult.missed.question },
            });
            expect(ac.resultDiv.querySelector(".eipe-focus")).toBeNull();
        });
    });

    describe("the generated code window", () => {
        const failed = {
            status: "graded",
            passed: false,
            generated_code: "def foo(nums):\n    return min(nums)",
            counterexample: {
                input: "[3, 9, 2]",
                expected: { value: "9", printed: "" },
                got: { value: "2", printed: "" },
                test: "self.assertEqual(foo([3, 9, 2]), 9, 'foo([3, 9, 2])')",
            },
            example_call: "foo([3, 9, 2])",
        };

        async function check(ac, result) {
            ac.logBookEvent = vi.fn();
            respondWith(result);
            ac.explanationBox.value = "returns the smallest number";
            await ac.checkExplanation();
            return ac.generatedCode;
        }

        it("is a read-only activecode with CodeLens and the tests", async () => {
            const ac = new EiPEActiveCode({ orig: makeFixture("gen_1") });
            const generated = await check(ac, failed);
            expect(generated).toBeInstanceOf(ActiveCode);
            expect(generated.editor.getOption("readOnly")).toBe(true);
            expect(generated.editor.getValue()).toContain("return min(nums)");
            expect(generated.clButton).toBeDefined();
            // the question's tests, in the form Skulpt shows as a table,
            // plus the counterexample as one more test
            expect(generated.suffix).toContain(
                "from unittest.gui import TestCaseGui",
            );
            expect(generated.suffix).toContain(
                "self.assertEqual(foo([3, 9, 2]), 9",
            );
            expect(window.componentMap[generated.divid]).toBe(generated);
            expect(generated.capDiv.isConnected).toBe(false);
        });

        it("steps through a call in CodeLens", async () => {
            const ac = new EiPEActiveCode({ orig: makeFixture("gen_2") });
            const generated = await check(ac, failed);
            const traced = await generated.buildProg(false);
            expect(traced).toContain("print(foo([3, 9, 2]))");
            expect(await generated.buildProg(true)).not.toContain("print(foo(");
        });

        it("logs runs under the question, not as an answer", async () => {
            const ac = new EiPEActiveCode({ orig: makeFixture("gen_3") });
            const generated = await check(ac, failed);
            generated.errinfo = "success";
            generated.unit_results = "percent:50:passed:1:failed:1";
            await generated.logCurrentAnswer();
            const logged = ac.logBookEvent.mock.calls.at(-1)[0];
            expect(logged.event).toBe("eipe_run");
            expect(logged.div_id).toBe("gen_3");
            expect(JSON.parse(logged.act).aid).toBe(ac.lastAid);
        });

        it("replaces the previous attempt's window", async () => {
            const ac = new EiPEActiveCode({ orig: makeFixture("gen_4") });
            await check(ac, failed);
            await check(ac, failed);
            expect(
                ac.resultDiv.querySelectorAll(".eipe-generated").length,
            ).toBe(1);
        });
    });

    describe("testsForBrowser", () => {
        it("turns plain unittest into a shown results table", () => {
            const tests = [
                "import unittest",
                "",
                "class myTests(unittest.TestCase):",
                "    def testOne(self):",
                "        self.assertEqual(foo([1]), 1)",
                "",
                "unittest.main()",
            ].join("\n");
            const code = testsForBrowser(tests);
            expect(code).toContain("from unittest.gui import TestCaseGui");
            expect(code).toContain("class myTests(TestCaseGui):");
            expect(code).not.toContain("unittest.main()");
            expect(code.match(/myTests\(\)\.main\(\)/g)).toHaveLength(1);
        });

        it("adds the counterexample to the first test class", () => {
            const tests = [
                "from unittest.gui import TestCaseGui",
                "class myTests(TestCaseGui):",
                "    def testOne(self):",
                "        self.assertEqual(foo([1]), 1)",
                "myTests().main()",
            ].join("\n");
            const code = testsForBrowser(
                tests,
                "self.assertEqual(foo([7]), 7)",
            );
            expect(code.match(/^class /gm)).toHaveLength(1);
            expect(code).toContain(
                "class myTests(TestCaseGui):\n    def testWhereTheyDiffer(self):\n" +
                    "        self.assertEqual(foo([7]), 7)",
            );
            expect(code.match(/\.main\(\)/g)).toHaveLength(1);
        });

        it("makes a test class for the counterexample when there is none", () => {
            const code = testsForBrowser("", "self.assertEqual(foo([7]), 7)");
            expect(code).toContain("class myTests(TestCaseGui):");
            expect(code).toContain("myTests().main()");
        });

        it("leaves TestCaseGui tests that already run alone", () => {
            const tests = [
                "from unittest.gui import TestCaseGui",
                "class myTests(TestCaseGui):",
                "    def testOne(self):",
                "        self.assertEqual(foo([1]), 1)",
                "myTests().main()",
            ].join("\n");
            expect(testsForBrowser(tests)).toBe(tests);
        });
    });

    it("keeps the explanation across a reload", () => {
        const first = new EiPEActiveCode({ orig: makeFixture("keep_1") });
        first.explanationBox.value = "returns the largest number";
        first.explanationBox.dispatchEvent(new Event("input"));
        const again = new EiPEActiveCode({ orig: makeFixture("keep_1") });
        expect(again.explanationBox.value).toBe("returns the largest number");
    });

    it("shows only that it was submitted while an exam is open", async () => {
        respondWith({ status: "submitted", exam: true });
        const ac = new EiPEActiveCode({ orig: makeFixture("open_exam_1") });
        ac.logBookEvent = vi.fn();
        ac.explanationBox.value = "returns the smallest number";
        await ac.checkExplanation();
        expect(ac.resultDiv.textContent).toBe(
            "Your explanation was submitted.",
        );
        expect(
            ac.resultDiv.querySelector(".alert-danger, .alert-success"),
        ).toBeNull();
        expect(ac.generatedCode).toBeUndefined();
    });

    describe("in a timed exam", () => {
        function timed(id) {
            const ac = ACFactory.createActiveCode(makeFixture(id), "python", {
                useRunestoneServices: false,
                timed: true,
            });
            ac.logBookEvent = vi.fn();
            return ac;
        }

        it("is what the factory builds, with no Check button", () => {
            const ac = timed("exam_1");
            expect(ac).toBeInstanceOf(TimedEiPEActiveCode);
            expect(ac.checkButton.style.display).toBe("none");
            expect(window.componentMap.exam_1).toBe(ac);
        });

        it("counts as answered once there is an explanation", () => {
            const ac = timed("exam_2");
            expect(ac.isAnswered).toBe(false);
            ac.explanationBox.value = "returns the largest number";
            ac.explanationBox.dispatchEvent(new Event("input"));
            expect(ac.isAnswered).toBe(true);
        });

        it("grades when the student moves on, and shows nothing", async () => {
            const ac = timed("exam_3");
            const fetchMock = respondWith({ status: "submitted", exam: true });
            ac.explanationBox.value = "returns the largest number";
            await ac.checkCurrentAnswer();
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(ac.resultDiv.textContent).toBe("");
            // the page doesn't know the result, so the exam leaves it out of
            // its own tally instead of calling it right, wrong or skipped
            expect(ac.checkCorrectTimed()).toBe("N");

            // unchanged explanation: not graded again
            await ac.checkCurrentAnswer();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("counts an empty explanation as skipped", () => {
            expect(timed("exam_skip").checkCorrectTimed()).toBe("I");
        });

        it("says why an explanation couldn't be graded", async () => {
            const ac = timed("exam_4");
            respondWith({
                status: "rejected",
                message: "That looks like code.",
            });
            ac.explanationBox.value = "for n in nums: if n > r: r = n";
            await ac.checkCurrentAnswer();
            expect(ac.resultDiv.textContent).toContain("looks like code");
            expect(ac.checkCorrectTimed()).toBe("I");
        });

        it("shows nothing after the exam either", async () => {
            const ac = timed("exam_5");
            respondWith({ status: "submitted", exam: true });
            ac.explanationBox.value = "returns the smallest number";
            await ac.checkCurrentAnswer();
            ac.renderFeedback();
            expect(ac.resultDiv.textContent).toBe("");
            ac.disableInteraction();
            expect(ac.explanationBox.readOnly).toBe(true);
        });
    });
});
