// The agent's writes (reply, resolve, suggest) and `show`. Each write is one transaction: check
// the thread, append, and answer with an ack of at most 24 B.
import { createAnchor, resolveAnchor } from "../core/anchor.ts";
import { applyEditIn, type ApplyResult } from "../core/apply.ts";
import { unitChain } from "../core/context.ts";
import { transact, type LogTxn } from "../core/log.ts";
import type { Ack, AckError, Anchor, EventInput, ShowOutput, ThreadId } from "../core/model.ts";
import { catchUpInputs, foldLog, nextThreadId } from "../core/threads.ts";
import { loadView, locate, readSource, type DocView } from "./doc.ts";

function fail(error: AckError, id?: ThreadId, detail?: string): Ack {
    return {
        ok: false,
        ...(id === undefined ? {} : { id }),
        error,
        ...(detail ? { detail } : {}),
    };
}

/** The full unit; for a table cell, its row and the header row rather than the whole table. */
function unitText(view: DocView, start: number): string {
    const doc = view.doc!;
    const chain = unitChain(doc.units, { start, end: start });
    const unit = chain[chain.length - 1];
    if (!unit) return "";
    const table = chain.findLast((candidate) => candidate.kind === "table");
    if (unit.kind !== "tableCell" || !table) return doc.source.slice(unit.start, unit.end);
    const lines = doc.source.slice(table.start, table.end).split(/\r?\n/);
    const row = doc.source.slice(0, start).split(/\r?\n/).length - table.line;
    return row <= 0 ? lines[0]! : `${lines[0]}\n${lines[row]}`;
}

export async function show(docPath: string, id: ThreadId): Promise<ShowOutput | Ack> {
    const view = await loadView(docPath);
    const thread = view.state.threads.get(id);
    if (!thread) return fail("not-found", id);
    const { range, context } = locate(view, thread);
    return {
        id,
        path: context.path,
        line: context.line,
        unit: range ? unitText(view, range.start) : "",
        thread: { ...thread, detached: range === null },
    };
}

export async function reply(
    docPath: string,
    id: ThreadId,
    text: string,
    resolve = false,
): Promise<Ack> {
    return await transact(docPath, (txn) => {
        const thread = foldLog(txn.events).threads.get(id);
        if (!thread) return fail("not-found", id);
        if (thread.state === "resolved") return fail("resolved", id);
        const inputs: EventInput[] = [{ type: "reply", by: "agent", id, text }];
        if (resolve) inputs.push({ type: "resolve", by: "agent", id });
        txn.append(inputs);
        return { ok: true, id, state: resolve ? "resolved" : "replied" };
    });
}

export async function resolveThread(docPath: string, id: ThreadId): Promise<Ack> {
    return await transact(docPath, (txn) => {
        const thread = foldLog(txn.events).threads.get(id);
        if (!thread) return fail("not-found", id);
        if (thread.state !== "resolved") txn.append([{ type: "resolve", by: "agent", id }]);
        return { ok: true, id, state: "resolved" };
    });
}

export interface SuggestInput {
    /** A thread to answer, or `find` to start one (follow-through). */
    id?: ThreadId;
    find?: string;
    replace: string;
    note?: string;
    apply: boolean;
}

function applyFailure(result: Extract<ApplyResult, { ok: false }>, id?: ThreadId): Ack {
    if (result.reason === "not-unique") return fail("not-unique", id);
    return fail("before-missing", id, result.reason === "missing" ? "doc missing" : undefined);
}

/**
 * Suggests by default. Applies through `applyEditIn` when `--apply` is given or auto-apply is on
 * for the thread or doc; "suggestions only" turns an asked-for apply into a suggestion and the
 * ack says so. Only the CLI applies suggestions; the server applies only the user's accept.
 */
export async function suggest(docPath: string, input: SuggestInput): Promise<Ack> {
    return await transact(docPath, (txn) => {
        const state = foldLog(txn.events);
        const source = readSource(txn.sidecar.doc);
        const thread = input.id === undefined ? undefined : state.threads.get(input.id);
        if (input.id !== undefined) {
            if (!thread) return fail("not-found", input.id);
            if (thread.state === "resolved") return fail("resolved", input.id);
        }
        const settings = state.settings;
        const wanted = input.apply || settings.autoApply || (thread?.autoApply ?? false);
        const apply = wanted && !settings.suggestionsOnly;
        const downgraded = input.apply && settings.suggestionsOnly;
        const event = (id: ThreadId, anchor?: Anchor): EventInput => ({
            type: "suggest",
            by: "agent",
            id,
            replace: input.replace,
            apply,
            downgraded,
            ...(input.note ? { note: input.note } : {}),
            ...(anchor ? { anchor } : {}),
        });

        if (thread) {
            const range = source === null ? null : resolveAnchor(source, thread.anchor);
            if (!range) return fail("detached", thread.id);
            if (apply) {
                const result = edit(
                    txn,
                    thread.id,
                    range.start,
                    thread.anchor.exact,
                    input.replace,
                );
                if (!result.ok) return applyFailure(result, thread.id);
            }
            txn.append([event(thread.id)]);
            return { ok: true, id: thread.id, state: "replied", downgraded };
        }

        const find = input.find ?? "";
        if (source === null) return fail("before-missing", undefined, "doc missing");
        const start = source.indexOf(find);
        if (find === "" || start === -1) return fail("before-missing");
        if (source.indexOf(find, start + 1) !== -1) return fail("not-unique");
        // The new anchor is in this source's offsets; a daemon yet to sync must not shift it again.
        txn.append(catchUpInputs(txn.events, source, { anchoring: true }));
        const id = nextThreadId(txn.events);
        let anchor = createAnchor(source, { start, end: start + find.length });
        if (apply) {
            const result = edit(txn, id, start, find, input.replace);
            if (!result.ok) return applyFailure(result, id);
            // The thread points at what the text says now.
            if (result.status === "changed" && result.event.after.length > 0) {
                anchor = createAnchor(result.source, {
                    start,
                    end: start + result.event.after.length,
                });
            }
        }
        txn.append([event(id, anchor)]);
        return { ok: true, id, state: "replied", downgraded };
    });
}

function edit(
    txn: LogTxn,
    id: ThreadId,
    start: number,
    before: string,
    after: string,
): ApplyResult {
    return applyEditIn(txn, { start, before, after, cause: "apply", by: "agent", id });
}
