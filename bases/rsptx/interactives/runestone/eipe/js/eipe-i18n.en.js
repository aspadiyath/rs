import { load } from "../../common/js/rsi18n.js";

load({
    en: {
        msg_eipe_caption: "Explain in Plain English",
        msg_eipe_prompt:
            "In plain English, explain what this code does. Describe its purpose, not each line.",
        msg_eipe_check: "Check my explanation",
        msg_eipe_char_count: "$1 / $2",
        msg_eipe_empty: "Write an explanation first.",
        msg_eipe_checking: "Writing code from your explanation and testing it…",
        msg_eipe_passed:
            "Your explanation works: code written from it passed all the tests.",
        msg_eipe_failed:
            "Code written from your explanation does something different from the function. Compare them and revise your explanation.",
        msg_eipe_generated_code: "Code written from your explanation:",
        msg_eipe_generated_hint:
            "Run it to see how it does on the tests, or step through it with CodeLens.",
        msg_eipe_no_server: "Couldn't reach the server. Try again.",
        msg_eipe_error: "Something went wrong. Try again.",
        msg_eipe_on_input: "They behave differently on",
        msg_eipe_function_gives: "The function gives",
        msg_eipe_yours_gives: "Code from your explanation gives",
        msg_eipe_timeout:
            "Code from your explanation took too long or crashed, so it couldn't be compared with the function.",
        msg_eipe_raised: "raises $1",
        msg_eipe_exam_note:
            "Your explanation is graded when you move to another question or finish the exam.",
        msg_eipe_submitted: "Your explanation was submitted.",
        msg_eipe_missed_one:
            "Your explanation doesn't seem to account for line $1 (highlighted above).",
        msg_eipe_missed_two:
            "Your explanation doesn't seem to account for lines $1 and $2 (highlighted above).",
        msg_eipe_focus_assign: "When $1 runs, what is $2 each time line $3 runs?",
        msg_eipe_focus_return: "When $1 runs, what does line $2 return?",
        msg_eipe_focus_check: "Check my prediction",
        msg_eipe_focus_actual: "Line $1 actually gives: $2",
    },
});
