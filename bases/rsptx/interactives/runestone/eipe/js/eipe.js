// Explain in Plain English (EiPE): shows a function read-only and asks the
// student to explain what it does. The server
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
// The generated code is shown in a read-only activecode, so the student can
// run it against the question's tests (plus the input where it differed) and
// step through it in CodeLens. Like a runnable Parsons problem, EiPE doesn't
// extend activecode: it writes an activecode into the page and has Runestone
// render it.
//
// The source is an optional statement, then the function and its tests as in
// an activecode:
//
//   <div data-component="eipe" id="..." data-question_label="...">
//     <div class="eipe_question">Explain what this function does.</div>
//     <textarea data-lang="python">def f(x): ...
//   ====
//   (tests)</textarea>
//   </div>
//
// The server reads the same textarea from the question's htmlsrc, so it
// grades against what the student was shown.
import RunestoneBase from "../../common/js/runestonebase.js";
import { getDataValue } from "../../common/js/domutil.js";
import { t } from "../../common/js/rsi18n.js";
import CodeMirror from "codemirror";
import "codemirror/mode/python/python.js";
import "codemirror/mode/clike/clike.js";
import "codemirror/lib/codemirror.css";
import "./eipe-i18n.en.js";
import "../css/eipe.less";

// CodeMirror modes for the languages EiPE code can be in.
const MODES = {
    python: "python",
    java: "text/x-java",
    cpp: "text/x-c++src",
    c: "text/x-csrc",
};

// The tests follow a line of four or more "=", as in an activecode.
const SUFFIX_RE = /^={4,}\s*$/m;

// Keep in step with MAX_EXPLANATION_CHARS in eipe_grading.py.
export const MAX_EXPLANATION_CHARS = 250;

// The book server keeps only 512 characters of a logged act (rslogging.py).
function clip(text, length) {
    if (typeof text !== "string" || text.length <= length) {
        return text;
    }
    return text.slice(0, length - 1) + "…";
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

export default class EiPE extends RunestoneBase {
    constructor(opts) {
        super(opts);
        this.containerDiv = opts.orig;
        this.divid = opts.orig.id;
        const source = opts.orig.querySelector("textarea");
        this.language = getDataValue(source, "lang") || "python";
        const text = source.textContent;
        const suffix = SUFFIX_RE.exec(text);
        this.code = (suffix ? text.slice(0, suffix.index) : text).replace(
            /\s+$/,
            "",
        );
        this.suffix = suffix ? text.slice(suffix.index + suffix[0].length) : "";
        source.remove();
        this.containerDiv.classList.add("eipe-rendered");
        this.attempts = 0;
        // Lines the last failed explanation missed, to notice a repeat.
        this.previousMissed = [];
        this.createCodeArea();
        this.createExplanationArea();
        this.caption = t("msg_eipe_caption");
        this.addCaption("runestone");
        this.indicate_component_ready();
    }

    // The function, read-only, in an editor so missed lines can be marked.
    createCodeArea() {
        const codeDiv = document.createElement("div");
        codeDiv.classList.add("eipe-code");
        this.containerDiv.appendChild(codeDiv);
        this.editor = CodeMirror(codeDiv, {
            value: this.code,
            mode: MODES[this.language] || this.language,
            lineNumbers: true,
            readOnly: true,
            indentUnit: 4,
        });
        // A timed exam builds its questions hidden, where CodeMirror can't
        // measure the line-number gutter; refresh once it has a size, as
        // activecode does.
        if (typeof ResizeObserver !== "undefined") {
            new ResizeObserver(() => this.editor.refresh()).observe(
                this.editor.getWrapperElement(),
            );
        }
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

        this.containerDiv.appendChild(area);
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
        await this.showResult(result);
    }

    // Send the explanation to the server to be graded (and scored), and
    // return its result. The server keeps the full record under the attempt
    // id (aid); the page logs only what the server can't see, under the same id.
    async gradeExplanation(explanation) {
        this.attempts += 1;
        this.lastAid = `${this.divid}-${this.attempts}-${Date.now()}`;
        try {
            const response = await fetch(
                `${eBookConfig.new_server_prefix}/eipe/check?course=${eBookConfig.course}`,
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

    showMessage(kind, text) {
        this.resultDiv.replaceChildren();
        const alert = document.createElement("div");
        alert.classList.add("alert", `alert-${kind}`);
        alert.textContent = text;
        this.resultDiv.appendChild(alert);
        return alert;
    }

    async showResult(result) {
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
        await this.showGeneratedCode(result);
    }

    // The generated code in a read-only activecode the student can run
    // against the tests and step through in CodeLens. Its runs and CodeLens
    // views are logged under this question with the check's attempt id,
    // never as an answer of their own.
    async showGeneratedCode(result) {
        const heading = document.createElement("div");
        heading.classList.add("eipe-subheading");
        heading.textContent = t("msg_eipe_generated_code");
        this.resultDiv.appendChild(heading);
        const hint = document.createElement("div");
        hint.classList.add("eipe-generated-hint");
        hint.textContent = t("msg_eipe_generated_hint");
        this.resultDiv.appendChild(hint);

        // An activecode source, rendered by Runestone the way a runnable
        // Parsons problem renders its solution (parsons.js,
        // generateRunableVersion). Rendering registers it in componentMap,
        // where Skulpt's unittest.gui finds it to record results.
        const wrapper = document.createElement("div");
        wrapper.classList.add("runestone", "eipe-generated");
        const root = document.createElement("div");
        root.id = `${this.divid}_eipe_generated_${this.attempts}`;
        root.dataset.component = "activecode";
        root.classList.add("ac_section");
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
        wrapper.appendChild(root);
        this.resultDiv.appendChild(wrapper);

        window.componentMap = window.componentMap || {};
        await window.runestoneComponents.renderOneComponent(wrapper);
        const generated = window.componentMap[root.id];
        if (!generated) {
            return;
        }
        generated.editor.setOption("readOnly", true);
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
