// The agent's writes (reply, resolve, suggest) and `show`. Each write is one transaction: check
// the thread, append, and answer with an ack of at most 24 B.
import { signed } from "../core/agent.ts";
import { createAnchor, resolveAnchor } from "../core/anchor.ts";
import { applyEditIn, type ApplyResult } from "../core/apply.ts";
import { unitChain } from "../core/context.ts";
import { transact, type LogTxn } from "../core/log.ts";
import type {
    Ack,
    AckError,
    AgentIdentity,
    Anchor,
    EventInput,
    ShowOutput,
    Thread,
    ThreadId,
} from "../core/model.ts";
import { catchUpInputs, foldLog, nextThreadId, type DocState } from "../core/threads.ts";
import { loadView, locate, readSource, type DocView } from "./doc.ts";

function fail(error: AckError, id?: ThreadId, detail?: string): Ack {
    return {
        ok: false,
        ...(id === undefined ? {} : { id }),
        error,
        ...(detail ? { detail } : {}),
    };
}

/** The thread an agent command acts on, or the ack refusing it. */
function lookup(state: DocState, id: ThreadId): Thread | Ack {
    if (state.deleted.has(id)) return fail("deleted", id);
    return state.threads.get(id) ?? fail("not-found", id);
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
    const thread = lookup(view.state, id);
    if ("ok" in thread) return thread;
    const { range, detached, context } = locate(view, thread);
    return {
        id,
        path: context.path,
        line: context.line,
        unit: range ? unitText(view, range.start) : "",
        thread: { ...thread, detached },
    };
}

export interface ReplyOptions {
    resolve?: boolean;
    agent?: AgentIdentity;
}

export async function reply(
    docPath: string,
    id: ThreadId,
    text: string,
    options: ReplyOptions = {},
): Promise<Ack> {
    const resolve = options.resolve ?? false;
    const by = { by: "agent" as const, ...signed(options.agent) };
    return await transact(docPath, (txn) => {
        const thread = lookup(foldLog(txn.events), id);
        if ("ok" in thread) return thread;
        if (thread.state === "resolved") return fail("resolved", id);
        const inputs: EventInput[] = [{ type: "reply", ...by, id, text }];
        if (resolve) inputs.push({ type: "resolve", ...by, id });
        txn.append(inputs);
        return { ok: true, id, state: resolve ? "resolved" : "replied" };
    });
}

export async function resolveThread(
    docPath: string,
    id: ThreadId,
    agent?: AgentIdentity,
): Promise<Ack> {
    return await transact(docPath, (txn) => {
        const thread = lookup(foldLog(txn.events), id);
        if ("ok" in thread) return thread;
        if (thread.state !== "resolved") {
            txn.append([{ type: "resolve", by: "agent", ...signed(agent), id }]);
        }
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
    agent?: AgentIdentity;
}

function applyFailure(result: Extract<ApplyResult, { ok: false }>, id?: ThreadId): Ack {
    if (result.reason === "not-unique") return fail("not-unique", id);
    return fail("before-missing", id, result.reason === "missing" ? "doc missing" : undefined);
}

/**
 * Suggests by default. Applies through `applyEditIn` when `--apply` is given (the user's comment
 * asked for the change) or the doc's auto-apply is on. Only the CLI applies suggestions; the
 * server applies only the user's accept.
 */
export async function suggest(docPath: string, input: SuggestInput): Promise<Ack> {
    return await transact(docPath, (txn) => {
        const state = foldLog(txn.events);
        const source = readSource(txn.sidecar.doc);
        const thread = input.id === undefined ? undefined : lookup(state, input.id);
        if (thread && "ok" in thread) return thread;
        if (thread?.state === "resolved") return fail("resolved", thread.id);
        const apply = input.apply || state.settings.autoApply;
        const event = (id: ThreadId, anchor?: Anchor): EventInput => ({
            type: "suggest",
            by: "agent",
            ...signed(input.agent),
            id,
            replace: input.replace,
            apply,
            ...(input.note ? { note: input.note } : {}),
            ...(anchor ? { anchor } : {}),
        });

        if (thread) {
            if (!thread.anchor) return fail("no-anchor", thread.id);
            const range = source === null ? null : resolveAnchor(source, thread.anchor);
            if (!range) return fail("detached", thread.id);
            if (apply) {
                const result = edit(
                    txn,
                    thread.id,
                    range.start,
                    thread.anchor.exact,
                    input.replace,
                    input.agent,
                );
                if (!result.ok) return applyFailure(result, thread.id);
            }
            txn.append([event(thread.id)]);
            return { ok: true, id: thread.id, state: "replied" };
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
            const result = edit(txn, id, start, find, input.replace, input.agent);
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
        return { ok: true, id, state: "replied" };
    });
}

function edit(
    txn: LogTxn,
    id: ThreadId,
    start: number,
    before: string,
    after: string,
    agent: AgentIdentity | undefined,
): ApplyResult {
    return applyEditIn(txn, {
        start,
        before,
        after,
        cause: "apply",
        by: "agent",
        ...signed(agent),
        id,
    });
}
