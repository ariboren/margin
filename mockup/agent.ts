import type { Thread } from "../src/core/model.ts";
import type { Clock, MemoryStore, Wake } from "./memory-store.ts";

const fillers = /\b(very|really|actually|currently|basically|simply|just|also|quite|clearly) /i;

/**
 * A plausible tightening of `text`, computed rather than written, so the mockup never ships sample
 * prose: drop a parenthetical, else a filler word, else the last comma clause. Null when none apply.
 */
export function proposeEdit(text: string): string | null {
    const withoutAside = text.replace(/ \([^()`]{3,80}\)/, "");
    if (withoutAside !== text) {
        return withoutAside;
    }
    const withoutFiller = text.replace(fillers, "");
    if (withoutFiller !== text) {
        return withoutFiller;
    }
    const comma = text.lastIndexOf(", ");
    if (comma > text.length / 3) {
        const tail = /[.;:!?]$/.exec(text)?.[0] ?? "";
        return text.slice(0, comma) + tail;
    }
    return null;
}

const wantsEdit =
    /\b(shorter|tighten|trim|reword|rephrase|simplify|clearer|cut|fix|typo|edit|go ahead)\b/i;
const wantsApply = /\b(go ahead|just fix|apply)\b/i;

const replies = {
    question: "Checked this against the rest of the doc and it holds. I'd leave it as is.",
    userSuggestion: "That reads better. Accept it when you're ready.",
    reply: "Makes sense. I'll keep that in mind for the rest of the section.",
    noEdit: "I couldn't find a tighter version without losing meaning. Want me to try a rewrite?",
    suggestion: "Here's a tighter version.",
    retry: "Understood. Here's another take.",
    applied: "Applied directly. Revert if it reads worse.",
};

/**
 * Plays the agent for the mockup: batches wakes the way `margin watch` debounces them, claims the
 * batch (the live indicator), then answers each thread a moment later.
 */
export function attachScriptedAgent(
    store: MemoryStore,
    clock: Clock,
    timing = { claim: 900, answer: 2200 },
): void {
    let queue: Wake[] = [];
    store.onWake = (batch) => {
        const idle = queue.length === 0;
        queue.push(...batch);
        if (!idle) {
            return;
        }
        clock.schedule(() => {
            const claimed = queue;
            queue = [];
            store.agentClaim(claimed.map((wake) => wake.id));
            claimed.forEach((wake, index) => {
                clock.schedule(() => answer(store, wake), timing.answer + index * 700);
            });
        }, timing.claim);
    };
}

function answer(store: MemoryStore, wake: Wake): void {
    const thread = store.snapshot().threads.find((candidate) => candidate.id === wake.id);
    if (!thread || thread.state === "resolved" || thread.state === "draft") {
        return;
    }
    const lastUser =
        [...thread.messages].reverse().find((message) => message.by === "user")?.text ?? "";
    if (wake.reason === "new" && thread.suggestion?.by === "user") {
        store.agentReply(thread.id, replies.userSuggestion);
        return;
    }
    if (wake.reason === "reply" && !wantsEdit.test(lastUser)) {
        store.agentReply(thread.id, replies.reply);
        return;
    }
    if (wake.reason === "new" && !wantsEdit.test(lastUser)) {
        store.agentReply(thread.id, replies.question);
        return;
    }
    suggestFor(store, thread, wake.reason === "rejected", wantsApply.test(lastUser));
}

function suggestFor(store: MemoryStore, thread: Thread, retry: boolean, apply: boolean): void {
    // A doc note has nothing to edit in place; the scripted agent just answers it.
    const quote = retry && thread.suggestion ? thread.suggestion.replace : thread.anchor?.exact;
    const replace = quote === undefined ? null : proposeEdit(quote);
    if (replace === null) {
        store.agentReply(thread.id, replies.noEdit);
        return;
    }
    const snapshot = store.snapshot();
    const willApply = apply || snapshot.settings.autoApply;
    const note = !willApply ? (retry ? replies.retry : replies.suggestion) : undefined;
    store.agentSuggest(thread.id, replace, { apply, note });
    if (willApply) {
        store.agentReply(thread.id, replies.applied);
    }
}
