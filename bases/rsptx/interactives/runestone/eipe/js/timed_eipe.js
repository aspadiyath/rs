import EiPE from "./eipe.js";
import { t } from "../../common/js/rsi18n.js";

// EiPE in a timed exam. Students get no feedback on an exam: no Check
// button, no generated code, no hints, and not whether the explanation
// passed, during the exam or after it. The explanation is graded and scored
// on the server when the student moves to another question or finishes; the
// server sends back only that it was submitted, so the page never learns the
// result either. The grade appears where the instructor releases grades.
export default class TimedEiPE extends EiPE {
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

    // The server records each graded explanation itself.
    async logCurrentAnswer() {}

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

if (typeof window.component_factory === "undefined") {
    window.component_factory = {};
}

window.component_factory.eipe = function (opts) {
    if (opts.timed) {
        return new TimedEiPE(opts);
    }
    return new EiPE(opts);
};

document.addEventListener("runestone:login-complete", function () {
    for (const el of document.querySelectorAll("[data-component=eipe]")) {
        // Skip one already rendered, e.g. by an assignment page.
        if (
            el.closest("[data-component=timedAssessment]") === null &&
            !el.classList.contains("eipe-rendered")
        ) {
            try {
                window.componentMap[el.id] = new EiPE({
                    orig: el,
                    useRunestoneServices: eBookConfig.useRunestoneServices,
                });
            } catch (err) {
                console.log(`Error rendering EiPE ${el.id}
                             Details: ${err}`);
            }
        }
    }
});
