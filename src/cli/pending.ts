// `margin pending`: threads waiting on the agent plus user edits since its last read. It claims
// what it returns, except on a declined doc, and moves the pending cursor, so edits ride along
// exactly once.
import { hashText, unitAt } from "../core/blocks.ts";
import { docTitle } from "../core/context.ts";
import { netEdits, pendingEdit } from "../core/diff.ts";
import {
    type AgentIdentity,
    isDocNote,
    type EditEvent,
    type EventInput,
    type PendingJson,
    type PendingReview,
    type PendingThread,
    type Thread,
} from "../core/model.ts";
import { UNKNOWN_AGENT } from "../core/agent.ts";
import { transact } from "../core/log.ts";
import { withPresence } from "../server/presence.ts";
import { needsAgent } from "../core/threads.ts";
import { locate, viewOf, type DocView } from "./doc.ts";
import { formatPending } from "./format.ts";
import { finishWaiting, WakeTail, type WaitOptions } from "./watch.ts";

/**
 * Full thread when unclaimed, else only what came after the agent's last say: its last message
 * or its own suggestion, so a reject with a note shows the note and not the thread again.
 */
function newMessages(thread: Thread): PendingThread["messages"] {
    let since = 0;
    if (thread.claimed) {
        since = thread.messages.findLast((m) => m.by === "agent")?.seq ?? 0;
        if (thread.suggestion?.by === "agent") since = Math.max(since, thread.suggestion.seq);
    }
    return thread.messages.filter((m) => m.seq > since).map(({ by, text }) => ({ by, text }));
}

export function pendingThread(view: DocView, thread: Thread): PendingThread {
    const { detached, context } = locate(view, thread);
    const doc = isDocNote(thread);
    const out: PendingThread = {
        id: thread.id,
        state: thread.state,
        ...(doc ? { doc: true as const } : {}),
        path: context.path,
        line: context.line,
        detached,
        quote: context.quote,
        before: context.before,
        after: context.after,
        messages: newMessages(thread),
    };
    if (context.cell) out.cell = context.cell;
    if (thread.suggestion && thread.suggestion.status !== "accepted") {
        out.suggestion = { replace: thread.suggestion.replace, status: thread.suggestion.status };
    }
    return out;
}

/**
 * The edit widened to its enclosing unit while the new text is still in place, so a narrow
 * splice still gets words of context around the change.
 */
function inUnit(view: DocView, edit: EditEvent): { before: string; after: string } {
    const source = view.doc?.source;
    const end = edit.start + edit.after.length;
    if (!source || source.slice(edit.start, end) !== edit.after) return edit;
    const unit = unitAt(view.doc!.units, { start: edit.start, end });
    if (!unit) return edit;
    const head = source.slice(unit.start, edit.start);
    const tail = source.slice(end, unit.end);
    return { before: head + edit.before + tail, after: head + edit.after + tail };
}

/**
 * What a session starting fresh has to know about the doc, so a standing verdict and an
 * outstanding finish request are said on every read; only the return to open is said once, to
 * the read whose cursor it is past. A finish request implies the doc is open. `changed` compares
 * the verdict's hash with `hashText` of the source as `viewOf` read it; a missing doc says nothing.
 */
function pendingReview(view: DocView): PendingReview | undefined {
    const { verdict, cursors } = view.state;
    if (verdict && verdict.state !== "open") {
        const changed =
            verdict.state === "approved" &&
            view.doc !== null &&
            hashText(view.doc.source) !== verdict.hash;
        return {
            verdict: verdict.state,
            ...(changed ? { changed: true as const } : {}),
            ...(verdict.note ? { note: verdict.note } : {}),
        };
    }
    if (finishWaiting(view.state).length > 0) return { finish: true };
    return verdict && verdict.seq > cursors.pending ? { reopened: true } : undefined;
}

export function buildPending(view: DocView): PendingJson {
    const { state } = view;
    const title = view.doc ? docTitle(view.doc) : undefined;
    const threads = [...state.threads.values()]
        .filter(needsAgent)
        .map((thread) => pendingThread(view, thread));
    const edits = netEdits(
        state.edits.filter((edit) => ["user", "revert", "undo"].includes(edit.cause)),
        state.cursors.pending,
    )
        .map((edit) =>
            pendingEdit({
                ...inUnit(view, edit),
                line: edit.line,
                headingPath: edit.headingPath,
                ...(title === undefined ? {} : { title }),
            }),
        )
        .filter((edit) => edit.hunks.length > 0);
    const review = pendingReview(view);
    return { threads, edits, ...(review ? { review } : {}) };
}

export interface PendingOptions {
    json?: boolean;
    write: (text: string) => void;
    agent?: AgentIdentity;
}

export async function pending(docPath: string, options: PendingOptions): Promise<void> {
    const by = { by: "agent" as const, ...(options.agent ? { agent: options.agent } : {}) };
    await transact(docPath, (txn) => {
        const view = viewOf(docPath, txn.events);
        const result = buildPending(view);
        const inputs: EventInput[] = [];
        // A declined doc tells the agent to stop, so its threads are shown and left unclaimed: the
        // page must not show them as worked on. The cursor still moves, or `--wait` would return
        // at once forever; the edits rode along with this read, and the threads, never claimed,
        // print in full again and are claimed by the first read after a reopen.
        const declined = view.state.verdict?.state === "declined";
        const claims = result.threads
            .map((t) => view.state.threads.get(t.id)!)
            .filter((thread) => !declined && (!thread.claimed || thread.state === "open"))
            .map((thread) => thread.id);
        if (claims.length > 0) inputs.push({ type: "claim", ...by, ids: claims });
        // The agent's own bookkeeping does not move the cursor, or every read would append one.
        const upTo =
            txn.events.findLast((e) => e.type !== "claim" && e.type !== "cursor")?.seq ?? 0;
        if (upTo > view.state.cursors.pending) {
            const ids = result.threads.map((thread) => thread.id);
            inputs.push({ type: "cursor", ...by, stream: "pending", upTo, ids });
        }
        txn.append(inputs);
        options.write(`${options.json ? JSON.stringify(result) : formatPending(result)}\n`);
    });
}

/** Blocks until a wake lands past the pending cursor and settles; a backlog prints at once. */
export async function pendingWait(
    docPath: string,
    options: PendingOptions & WaitOptions,
): Promise<boolean> {
    const woken = await withPresence(docPath, options.agent ?? UNKNOWN_AGENT, async () =>
        new WakeTail(docPath, "pending", options).next(),
    );
    if (!woken) return false;
    await pending(docPath, options);
    return true;
}
