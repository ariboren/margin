// `margin pending`: threads waiting on the agent plus user edits since its last read. It claims
// what it returns and moves the pending cursor, so edits ride along exactly once.
import { unitAt } from "../core/blocks.ts";
import { docTitle } from "../core/context.ts";
import { pendingEdit } from "../core/diff.ts";
import type { EditEvent, EventInput, PendingJson, PendingThread, Thread } from "../core/model.ts";
import { transact } from "../core/log.ts";
import { withPresence } from "../server/presence.ts";
import { needsAgent } from "../core/threads.ts";
import { locate, viewOf, type DocView } from "./doc.ts";
import { formatPending } from "./format.ts";
import { WakeTail, type WaitOptions } from "./watch.ts";

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
    const { range, context } = locate(view, thread);
    const out: PendingThread = {
        id: thread.id,
        state: thread.state,
        path: context.path,
        line: context.line,
        detached: range === null,
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

export function buildPending(view: DocView): PendingJson {
    const { state } = view;
    const title = view.doc ? docTitle(view.doc) : undefined;
    const threads = [...state.threads.values()]
        .filter(needsAgent)
        .map((thread) => pendingThread(view, thread));
    const edits = state.edits
        .filter(
            (edit) =>
                edit.seq > state.cursors.pending &&
                (edit.cause === "user" || edit.cause === "revert"),
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
    return { threads, edits };
}

export async function pending(
    docPath: string,
    options: { json?: boolean; write: (text: string) => void },
): Promise<void> {
    await transact(docPath, (txn) => {
        const view = viewOf(docPath, txn.events);
        const result = buildPending(view);
        const inputs: EventInput[] = [];
        const claims = result.threads
            .map((t) => view.state.threads.get(t.id)!)
            .filter((thread) => !thread.claimed || thread.state === "open")
            .map((thread) => thread.id);
        if (claims.length > 0) inputs.push({ type: "claim", by: "agent", ids: claims });
        // The agent's own bookkeeping does not move the cursor, or every read would append one.
        const upTo =
            txn.events.findLast((e) => e.type !== "claim" && e.type !== "cursor")?.seq ?? 0;
        if (upTo > view.state.cursors.pending) {
            inputs.push({
                type: "cursor",
                by: "agent",
                stream: "pending",
                upTo,
            });
        }
        txn.append(inputs);
        options.write(`${options.json ? JSON.stringify(result) : formatPending(result)}\n`);
    });
}

/** Blocks until a wake lands past the pending cursor and settles; a backlog prints at once. */
export async function pendingWait(
    docPath: string,
    options: { json?: boolean; write: (text: string) => void } & WaitOptions,
): Promise<boolean> {
    const woken = await withPresence(docPath, async () =>
        new WakeTail(docPath, "pending", options).next(),
    );
    if (!woken) return false;
    await pending(docPath, options);
    return true;
}
