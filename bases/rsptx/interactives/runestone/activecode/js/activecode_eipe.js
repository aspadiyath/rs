// Explain in Plain English (EiPE): an activecode with data-eipe="true" shows
// its code read-only and asks the student to explain what it does. The server
// grades the explanation by having an LLM write code from it, then running
// the question's tests on that code and comparing it with the shown function
// (code generation based grading, Smith & Zilles 2024); see
// book_server_api/routers/eipe_grading.py. The student sees the code their
// explanation produced and, when it differs, an input where it does.
//
// A failed explanation also gets a hint built from it, the way CodeTailor
// builds help from a student's own code: the lines it doesn't account for
// are highlighted. When it misses the same lines again, the student is
// asked to predict what one of those lines does on the input where the two
// functions differ, then shown what it really does.
//
// The generated code is shown in its own read-only activecode, so the
// student can run it against the question's tests (plus the input where it
// differed) and step through it in CodeLens.
import { ActiveCode } from "./activecode.js";
import LiveCode from "./livecode.js";
import { t } from "../../common/js/rsi18n.js";

// Keep in step with MAX_EXPLANATION_CHARS in eipe_grading.py.
export const MAX_EXPLANATION_CHARS = 250;

// The book server keeps only the first 512 characters of a logged act
// (rslogging.py), so a check is logged as several small acts, each under
// this length, joined by a shared attempt id.
export const MAX_ACT_CHARS = 500;
// Room for one returned value in a logged counterexample.
const MAX_LOGGED_VALUE_CHARS = 120;

function clip(text, length) {
    if (typeof text !== "string" || text.length <= length) {
        return text;
    }
    return text.slice(0, length - 1) + "…";
}

// A call result ({value|error, printed}) small enough to log.
function clipResult(result) {
    const clipped = {};
    for (const [key, value] of Object.entries(result || {})) {
        clipped[key] = clip(value, MAX_LOGGED_VALUE_CHARS);
    }
    return clipped;
}

// Split ``text`` into acts no longer than MAX_ACT_CHARS once ``makeAct``
// (part, of, piece) is serialized. Escaping (newlines, quotes) makes the
// serialized act longer than the piece, so pieces are sized by measuring.
export function splitIntoActs(text, makeAct) {
    const pieces = [];
    let rest = text || "";
    while (rest.length) {
        let size = rest.length;
        while (
            size > 1 &&
            JSON.stringify(makeAct(0, 0, rest.slice(0, size))).length >
                MAX_ACT_CHARS
        ) {
            size = Math.floor(size * 0.8);
        }
        pieces.push(rest.slice(0, size));
        rest = rest.slice(size);
    }
    return pieces.map((piece, i) =>
        JSON.stringify(makeAct(i + 1, pieces.length, piece)),
    );
}

// The name of the first top-level function in ``code``.
function functionName(code) {
    const match = /^def\s+(\w+)\s*\(/m.exec(code || "");
    return match ? match[1] : "f";
}

// What a call returned, printed or raised ({value|error, printed}).
function describeResult(result) {
    const out = document.createElement("div");
    if (result.printed) {
        const printed = document.createElement("pre");
        printed.textContent = result.printed;
        out.appendChild(printed);
    }
    const value = document.createElement("code");
    value.textContent = result.error
        ? t("msg_eipe_raised", result.error)
        : result.value;
    out.appendChild(value);
    return out;
}

// The question's tests in the form the in-browser Python (Skulpt) shows as
// a results table, with ``extraAssertion`` (the counterexample) added to the
// first test class: each class draws its table in the same place, so a
// second class would replace the first one's table. Questions graded on
// JOBE often use plain unittest, which Skulpt would run without showing
// anything.
export function testsForBrowser(tests, extraAssertion) {
    let code = (tests || "")
        .replace(
            /^import unittest\s*$/m,
            "from unittest.gui import TestCaseGui",
        )
        .replace(/\(unittest\.TestCase\)/g, "(TestCaseGui)")
        .replace(/^\s*unittest\.main\(.*\)\s*$/gm, "");
    if (!/from unittest\.gui import TestCaseGui/.test(code)) {
        code = "from unittest.gui import TestCaseGui\n" + code;
    }
    if (extraAssertion) {
        const method =
            "    def testWhereTheyDiffer(self):\n" +
            `        ${extraAssertion}\n\n`;
        const header = /^class \w+\(TestCaseGui\):[^\n]*\n/m.exec(code);
        code = header
            ? code.slice(0, header.index + header[0].length) +
              method +
              code.slice(header.index + header[0].length)
            : `${code}\n\nclass myTests(TestCaseGui):\n${method}`;
    }
    // Run every test class that isn't already run.
    for (const [, name] of code.matchAll(/^class (\w+)\(TestCaseGui\)/gm)) {
        if (!new RegExp(`^\\s*${name}\\(\\)\\.main\\(`, "m").test(code)) {
            code += `\n${name}().main()\n`;
        }
    }
    return code;
}

export default class EiPEActiveCode extends ActiveCode {
    constructor(opts) {
        super(opts);
        this.editor.setOption("readOnly", true);
        // The student explains the code; they don't run or edit it. PreTeXt
        // books have no "hide" class, so hide the controls directly.
        this.controlDiv.style.display = "none";
        this.attempts = 0;
        // Lines the last failed explanation missed, to notice a repeat.
        this.previousMissed = [];
        this.createExplanationArea();
    }

    createExplanationArea() {
        const area = document.createElement("div");
        area.classList.add("eipe");

        const label = document.createElement("label");
        label.htmlFor = `${this.divid}_eipe_explanation`;
        label.textContent = t("msg_eipe_prompt");
        area.appendChild(label);

        this.explanationBox = document.createElement("textarea");
        this.explanationBox.id = `${this.divid}_eipe_explanation`;
        this.explanationBox.classList.add("form-control", "eipe-explanation");
        this.explanationBox.rows = 3;
        this.explanationBox.maxLength = MAX_EXPLANATION_CHARS;
        area.appendChild(this.explanationBox);

        const row = document.createElement("div");
        row.classList.add("eipe-actions");
        this.checkButton = document.createElement("button");
        this.checkButton.type = "button";
        this.checkButton.classList.add("btn", "btn-success");
        this.checkButton.textContent = t("msg_eipe_check");
        this.checkButton.onclick = () => this.checkExplanation();
        row.appendChild(this.checkButton);
        this.charCount = document.createElement("span");
        this.charCount.classList.add("eipe-count");
        row.appendChild(this.charCount);
        area.appendChild(row);
        this.explanationBox.addEventListener("input", () => {
            this.updateCharCount();
            this.saveExplanation();
        });
        this.restoreExplanation();
        this.updateCharCount();

        this.resultDiv = document.createElement("div");
        this.resultDiv.classList.add("eipe-result");
        this.resultDiv.setAttribute("aria-live", "polite");
        area.appendChild(this.resultDiv);

        this.outerDiv.appendChild(area);
    }

    updateCharCount() {
        this.charCount.textContent = t(
            "msg_eipe_char_count",
            this.explanationBox.value.length,
            MAX_EXPLANATION_CHARS,
        );
    }

    async checkExplanation() {
        const explanation = this.explanationBox.value.trim();
        if (!explanation) {
            this.showMessage("warning", t("msg_eipe_empty"));
            return;
        }
        this.checkButton.disabled = true;
        this.showMessage("info", t("msg_eipe_checking"));
        const result = await this.gradeExplanation(explanation);
        this.checkButton.disabled = false;
        this.clearMissedLines();
        this.showResult(result);
        await this.logCheck(explanation, result);
    }

    // Send the explanation to the server to be graded (and scored), and
    // return its result. Sets the attempt id the logs share.
    async gradeExplanation(explanation) {
        this.attempts += 1;
        this.lastAid = `${this.divid}-${this.attempts}-${Date.now()}`;
        try {
            const response = await fetch(
                `${eBookConfig.new_server_prefix}/coach/eipe_check?course=${eBookConfig.course}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        problem_id: this.divid,
                        explanation: explanation,
                        aid: this.lastAid,
                        selector_id: this.selector_id ?? null,
                        assignment_id: window.assignmentId ?? null,
                    }),
                },
            );
            const result = await response.json();
            if (!response.ok) {
                return {
                    status: "error",
                    message: result.detail || `HTTP ${response.status}`,
                };
            }
            return result;
        } catch (e) {
            return { status: "error", message: t("msg_eipe_no_server") };
        }
    }

    // The explanation is kept in this browser so a reload, which in a timed
    // exam can easily happen mid-question, doesn't lose it.
    get storageKey() {
        return `eipe:${eBookConfig.course}:${this.divid}`;
    }

    saveExplanation() {
        try {
            localStorage.setItem(this.storageKey, this.explanationBox.value);
        } catch (e) {
            // storage can be full or disabled; the explanation still works
        }
    }

    restoreExplanation() {
        try {
            const saved = localStorage.getItem(this.storageKey);
            if (saved) {
                this.explanationBox.value = saved;
            }
        } catch (e) {
            // nothing saved, or storage is unavailable
        }
    }

    // Log one check as several acts sharing an attempt id (aid): the
    // outcome, the counterexample, and the generated code in parts.
    async logCheck(explanation, result) {
        const aid = this.lastAid;
        const counterexample = result.counterexample;
        await this.logBookEvent({
            event: "eipe",
            div_id: this.divid,
            act: JSON.stringify({
                aid: aid,
                attempt: this.attempts,
                status: result.status,
                passed: result.passed ?? null,
                missed_lines: result.missed?.lines ?? null,
                has_counterexample: Boolean(counterexample),
                explanation: explanation,
            }),
            // An exam submission comes back without a verdict; don't log one.
            ...(result.status === "graded"
                ? { correct: result.passed ? "T" : "F" }
                : {}),
        });
        if (counterexample) {
            await this.logBookEvent({
                event: "eipe_counterexample",
                div_id: this.divid,
                act: JSON.stringify({
                    aid: aid,
                    input: clip(counterexample.input, MAX_LOGGED_VALUE_CHARS),
                    expected: clipResult(counterexample.expected),
                    got: clipResult(counterexample.got),
                }),
            });
        }
        const acts = splitIntoActs(result.generated_code, (part, of, code) => ({
            aid: aid,
            part: part,
            of: of,
            code: code,
        }));
        for (const act of acts) {
            await this.logBookEvent({
                event: "eipe_code",
                div_id: this.divid,
                act: act,
            });
        }
    }

    showMessage(kind, text) {
        this.resultDiv.replaceChildren();
        const alert = document.createElement("div");
        alert.classList.add("alert", `alert-${kind}`);
        alert.textContent = text;
        this.resultDiv.appendChild(alert);
        return alert;
    }

    showResult(result) {
        if (result.status === "rejected") {
            this.showMessage("warning", result.message);
            return;
        }
        if (result.status === "submitted") {
            // The question is on a timed assessment that's still open: it was
            // graded, but students get no feedback on it until then.
            this.showMessage("info", t("msg_eipe_submitted"));
            return;
        }
        if (result.status !== "graded") {
            this.showMessage("danger", result.message || t("msg_eipe_error"));
            return;
        }
        const alert = this.showMessage(
            result.passed ? "success" : "danger",
            t(result.passed ? "msg_eipe_passed" : "msg_eipe_failed"),
        );
        if (result.counterexample) {
            this.showCounterexample(alert, result.counterexample);
        }
        const missedLines = result.missed?.lines ?? [];
        if (missedLines.length) {
            const repeated = missedLines.some((line) =>
                this.previousMissed.includes(line),
            );
            this.showMissedLines(alert, result.missed, repeated);
        }
        this.previousMissed = missedLines;
        this.showGeneratedCode(result);
    }

    // The generated code in a read-only activecode the student can run
    // against the tests and step through in CodeLens. Its runs and CodeLens
    // views are logged under this question with the check's attempt id,
    // never as an answer of their own.
    showGeneratedCode(result) {
        const heading = document.createElement("div");
        heading.classList.add("eipe-subheading");
        heading.textContent = t("msg_eipe_generated_code");
        this.resultDiv.appendChild(heading);
        const hint = document.createElement("div");
        hint.classList.add("eipe-generated-hint");
        hint.textContent = t("msg_eipe_generated_hint");
        this.resultDiv.appendChild(hint);

        const root = document.createElement("div");
        root.id = `${this.divid}_eipe_generated_${this.attempts}`;
        root.dataset.component = "activecode";
        root.classList.add("ac_section", "eipe-generated");
        const textarea = document.createElement("textarea");
        textarea.dataset.lang = this.language;
        textarea.dataset.codelens = "true";
        textarea.dataset.hidehistory = "true";
        const tests =
            this.language === "python"
                ? testsForBrowser(this.suffix, result.counterexample?.test)
                : this.suffix || "";
        textarea.textContent = tests
            ? `${result.generated_code}\n====\n${tests}`
            : result.generated_code;
        root.appendChild(textarea);
        this.resultDiv.appendChild(root);

        const Runner = this.language === "python" ? ActiveCode : LiveCode;
        const generated = new Runner({
            orig: root,
            useRunestoneServices: eBookConfig.useRunestoneServices,
            python3: eBookConfig.python3,
        });
        generated.editor.setOption("readOnly", true);
        // Skulpt's unittest.gui finds the component to record results on here.
        window.componentMap = window.componentMap || {};
        window.componentMap[root.id] = generated;
        generated.capDiv?.remove();
        // Runs aren't saved, so there's no history to fetch or scrub.
        generated.addHistoryScrubber = async () => {};
        const aid = this.lastAid;
        generated.logCurrentAnswer = async () => {
            await this.logBookEvent({
                event: "eipe_run",
                div_id: this.divid,
                act: JSON.stringify({
                    aid: aid,
                    errinfo: clip(String(generated.errinfo ?? ""), 150),
                    unit_results: clip(generated.unit_results ?? null, 150),
                }),
            });
        };
        generated.logBookEvent = async (info) => {
            await this.logBookEvent({
                event: `eipe_${info.event}`,
                div_id: this.divid,
                act: JSON.stringify({ aid: aid, act: clip(info.act, 150) }),
            });
        };
        // CodeLens traces the code without its tests; add a call so there
        // is something to step through.
        if (result.example_call) {
            const buildProg = generated.buildProg.bind(generated);
            generated.buildProg = async (useSuffix) => {
                const prog = await buildProg(useSuffix);
                return useSuffix
                    ? prog
                    : `${prog}\nprint(${result.example_call})\n`;
            };
        }
        this.generatedCode = generated;
    }

    clearMissedLines() {
        for (let i = 0; i < this.editor.lineCount(); i++) {
            this.editor.removeLineClass(i, "background", "eipe-missed-line");
        }
    }

    // Highlight the lines the explanation missed and say so. On a repeat,
    // add a predict-then-check question about the first of them.
    showMissedLines(alert, missed, repeated) {
        for (const line of missed.lines) {
            this.editor.addLineClass(
                line - 1,
                "background",
                "eipe-missed-line",
            );
        }
        const hint = document.createElement("div");
        hint.classList.add("eipe-missed");
        hint.textContent =
            missed.lines.length === 1
                ? t("msg_eipe_missed_one", missed.lines[0])
                : t("msg_eipe_missed_two", missed.lines[0], missed.lines[1]);
        alert.appendChild(hint);
        if (repeated && missed.question) {
            alert.appendChild(this.createFocusQuestion(missed.question));
        }
    }

    // "When mystery([...]) runs, what is k each time line 4 runs?" The
    // student commits to a prediction before seeing the traced answer.
    createFocusQuestion(question) {
        const box = document.createElement("div");
        box.classList.add("eipe-focus");
        const id = `${this.divid}_eipe_focus_${this.attempts}`;
        const label = document.createElement("label");
        label.htmlFor = id;
        label.textContent = question.variable
            ? t(
                  "msg_eipe_focus_assign",
                  question.call,
                  question.variable,
                  question.line,
              )
            : t("msg_eipe_focus_return", question.call, question.line);
        box.appendChild(label);
        const input = document.createElement("input");
        input.type = "text";
        input.id = id;
        input.classList.add("eipe-focus-prediction");
        box.appendChild(input);
        const button = document.createElement("button");
        button.type = "button";
        button.classList.add("btn", "btn-default");
        button.textContent = t("msg_eipe_focus_check");
        box.appendChild(button);
        const answer = document.createElement("div");
        answer.classList.add("eipe-focus-answer");
        box.appendChild(answer);
        button.onclick = () => {
            if (!input.value.trim()) {
                input.focus();
                return;
            }
            answer.textContent = t(
                "msg_eipe_focus_actual",
                question.line,
                question.values.join(", "),
            );
            input.readOnly = true;
            button.disabled = true;
            this.logBookEvent({
                event: "eipe_focus",
                div_id: this.divid,
                act: JSON.stringify({
                    aid: this.lastAid,
                    line: question.line,
                    prediction: clip(input.value.trim(), 150),
                    values: question.values.map((value) => clip(value, 40)),
                }),
            });
        };
        return box;
    }

    // An input where code from the explanation and the shown function
    // differ, with what each one gives.
    showCounterexample(alert, counterexample) {
        const box = document.createElement("div");
        box.classList.add("eipe-counterexample");
        if (counterexample.input === null) {
            box.textContent = t("msg_eipe_timeout");
            alert.appendChild(box);
            return;
        }
        const call = document.createElement("code");
        call.textContent = `${functionName(this.code)}(${counterexample.input})`;
        box.append(t("msg_eipe_on_input"), " ", call);
        const table = document.createElement("table");
        for (const [label, outcome] of [
            [t("msg_eipe_function_gives"), counterexample.expected],
            [t("msg_eipe_yours_gives"), counterexample.got],
        ]) {
            const row = table.insertRow();
            row.insertCell().textContent = label;
            row.insertCell().appendChild(describeResult(outcome));
        }
        box.appendChild(table);
        alert.appendChild(box);
    }
}

// EiPE in a timed exam. Students get no feedback on an exam: no Check
// button, no generated code, no hints, and not whether the explanation
// passed, during the exam or after it. The explanation is graded and scored
// on the server when the student moves to another question or finishes; the
// server sends back only that it was submitted, so the page never learns the
// result either. The grade appears where the instructor releases grades.
export class TimedEiPEActiveCode extends EiPEActiveCode {
    constructor(opts) {
        super(opts);
        this.isTimed = true;
        this.containerDiv.classList.add("timedComponent");
        window.componentMap = window.componentMap || {};
        window.componentMap[this.divid] = this;
        this.checkButton.style.display = "none";
        const note = document.createElement("span");
        note.classList.add("eipe-exam-note");
        note.textContent = t("msg_eipe_exam_note");
        this.checkButton.after(note);
        // The explanation last graded, and what the server said about it.
        this.gradedExplanation = null;
        this.lastResult = null;
        this.loggedAid = null;
        this.updateAnswered();
        this.explanationBox.addEventListener("input", () =>
            this.updateAnswered(),
        );
    }

    // The exam marks a question answered, and counts skipped ones, by this.
    updateAnswered() {
        this.isAnswered = this.explanationBox.value.trim() !== "";
    }

    // Called by the exam when the student leaves this question or finishes.
    async checkCurrentAnswer() {
        const explanation = this.explanationBox.value.trim();
        if (!explanation || explanation === this.gradedExplanation) {
            return;
        }
        const result = await this.gradeExplanation(explanation);
        this.lastResult = result;
        if (result.status === "submitted" || result.status === "graded") {
            this.gradedExplanation = explanation;
            this.resultDiv.replaceChildren();
        } else if (result.status === "rejected") {
            // Not a verdict: the explanation couldn't be graded (empty, too
            // long, or code), so say why and let them fix it.
            this.showMessage("warning", result.message);
        }
    }

    async logCurrentAnswer() {
        if (this.lastResult && this.loggedAid !== this.lastAid) {
            this.loggedAid = this.lastAid;
            await this.logCheck(
                this.explanationBox.value.trim(),
                this.lastResult,
            );
        }
    }

    // "I" (skipped) when nothing was graded. Otherwise the result isn't
    // known on the page, so the exam leaves this question out of its own
    // tally ("N" falls through to its "ignored question" case); the grade is
    // recorded on the server.
    checkCorrectTimed() {
        const status = this.lastResult?.status;
        if (status !== "submitted" && status !== "graded") {
            return "I";
        }
        return "N";
    }

    // No feedback on an exam, even after it ends.
    renderFeedback() {}

    hideFeedback() {
        this.resultDiv.style.visibility = "hidden";
    }

    disableInteraction() {
        this.explanationBox.readOnly = true;
    }

    reinitializeListeners(taken) {
        this.explanationBox.readOnly = Boolean(taken);
        this.editor.refresh();
    }
}
