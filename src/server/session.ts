import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createAnchor, resolveAnchor } from "../core/anchor.ts";
import { applyEditIn, type ApplyResult } from "../core/apply.ts";
import { decodeSource, hashText, parseDoc, sourceEdit, unitAt } from "../core/blocks.ts";
import { readLog, sidecar, transact, type LogTxn, type Sidecar } from "../core/log.ts";
import {
    MAX_OUTSIDE_SPLICE,
    type Anchor,
    type DocSettingKey,
    type EditEvent,
    type Event,
    type FinishResult,
    type Range,
    type SaveResult,
    type SourceSplice,
    type Thread,
    type ThreadId,
    type VerdictResult,
    type VerdictState,
} from "../core/model.ts";
import {
    applyEvent,
    emptyState,
    nextThreadId,
    reanchorInput,
    unresolvedThreads,
    withoutDeleted,
    type DocState,
} from "../core/threads.ts";
import type {
    DocId,
    Ok,
    RetractResult,
    SaveRequest,
    Seq,
    WireError,
    WireSnapshot,
} from "./protocol.ts";

/** A mutation the client got wrong; the server maps it to a JSON error with this status. */
export class WireFailure extends Error {
    constructor(
        readonly status: number,
        readonly error: WireError,
        detail?: string,
    ) {
        super(detail ?? error);
        this.name = "WireFailure";
    }
}

export type SnapshotListener = (json: string, version: number) => void;

/** A mutation's result with the log version right after it, read inside its own transaction. */
export type Versioned<T> = T & { version: number };

/** The doc's hash as of a log seq, as last seen by a daemon. */
export interface KnownHash {
    seq: number;
    hash: string;
}

/**
 * Where a daemon remembers `KnownHash` between runs (outside the sidecar: the log's events carry
 * no hash of their own until the first outside change).
 */
export interface HashMemory {
    read(): KnownHash | null;
    write(known: KnownHash): void;
}

/** The verdict note is printed to the agent on every `pending`, so its size is bounded. */
export const MAX_VERDICT_NOTE = 200;

const OK: Ok = { ok: true };
const MISSING: SaveResult & RetractResult = { ok: false, reason: "missing" };

/** The answer to a mutation that appended one event: ok, with that event's seq. */
function appended(events: Event[]): Ok & Seq {
    return { ok: true, seq: events[events.length - 1]!.seq };
}

/**
 * The agent read the thread past `seq`: a claim of it, a cursor on either stream past the
 * event that named the thread, or an event of its own on the thread since. A cursor from an
 * older log names no threads and counts for every one: refusing a retract is the safe error.
 */
function seenByAgent(history: readonly Event[], id: ThreadId, seq: number): boolean {
    return eventsAfter(history, seq).some(
        (event) =>
            (event.type === "claim" && event.ids.includes(id)) ||
            (event.type === "cursor" &&
                event.upTo >= seq &&
                (event.ids === undefined || event.ids.includes(id))) ||
            (event.by === "agent" && "id" in event && event.id === id),
    );
}

/**
 * One registered doc: the last source seen, the fold of its log, and the tabs listening. Every
 * read-modify-write runs on one serial queue and under the doc lock, so the daemon never races
 * itself, the CLI, or another daemon.
 */
export class DocSession {
    readonly sidecar: Sidecar;
    private source: string;
    private hash: string;
    private missing = false;
    private state: DocState = emptyState();
    /** Every event folded in, for moving offsets through what happened since a version. */
    private readonly history: Event[] = [];
    private logSize = 0;
    private readonly listeners = new Set<SnapshotListener>();
    private queue: Promise<unknown> = Promise.resolve();
    private syncQueued = false;
    private cached?: { key: string; json: string };
    private emittedKey = "";

    private constructor(
        readonly docId: DocId,
        readonly path: string,
        source: string,
        private readonly memory?: HashMemory,
    ) {
        this.sidecar = sidecar(path);
        this.source = source;
        this.hash = hashText(source);
    }

    /**
     * Loads the doc and its log; logs an outside change if the file moved on while unwatched.
     * With a log, the source is read again under the lock (in `baseline`): an edit landing between
     * the first read and the lock would otherwise look like an outside change, then be logged a
     * second time by the next sync.
     */
    static async open(docId: DocId, docPath: string, memory?: HashMemory): Promise<DocSession> {
        const path = sidecar(docPath).doc;
        const source = readSource(path);
        if (source === null) {
            throw new WireFailure(404, "missing", "doc not found");
        }
        const session = new DocSession(docId, path, source, memory);
        await session.run(async () => {
            const { events } = await readLog(path);
            if (events.length > 0) {
                await transact(path, (txn) => session.baseline(txn));
            }
        });
        session.emittedKey = session.key();
        session.remember();
        return session;
    }

    get clients(): number {
        return this.listeners.size;
    }

    get version(): number {
        return this.state.version;
    }

    get isMissing(): boolean {
        return this.missing;
    }

    subscribe(listener: SnapshotListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    snapshot(): WireSnapshot {
        return JSON.parse(this.snapshotJson()) as WireSnapshot;
    }

    snapshotJson(): string {
        const key = this.key();
        if (this.cached?.key === key) {
            return this.cached.json;
        }
        const threads = [...withoutDeleted(this.state).threads.values()].map((thread): Thread => {
            if (!thread.anchor) return thread;
            const range = resolveAnchor(this.source, thread.anchor);
            return {
                ...thread,
                anchor: range ? { ...thread.anchor, hint: range.start } : thread.anchor,
                detached: range === null,
            };
        });
        const snapshot: WireSnapshot = {
            docId: this.docId,
            path: this.path,
            source: this.source,
            hash: this.hash,
            threads,
            edits: this.state.edits,
            settings: this.state.settings,
            agentSeenAt: this.state.agentSeenAt,
            changedOnDisk: this.state.changedOnDisk,
            missing: this.missing,
            version: this.state.version,
            verdict: this.state.verdict,
            finish: this.state.finish,
        };
        this.cached = { key, json: JSON.stringify(snapshot) };
        return this.cached.json;
    }

    /**
     * Called by the watcher. Cheap when nothing changed (our own writes land here too: their hash
     * is already known). Otherwise reconciles under the lock.
     */
    async sync(): Promise<void> {
        if (this.syncQueued) {
            return;
        }
        this.syncQueued = true;
        await this.run(async () => {
            this.syncQueued = false;
            const actual = readSource(this.path);
            const logSize = sizeOf(this.sidecar.log);
            if (actual === null) {
                // No lock: taking it would recreate `.margin/` inside a deleted directory.
                this.missing = true;
                if (logSize !== this.logSize) {
                    const { events, offset } = await readLog(this.path, this.logSize);
                    this.fold(events.filter((event) => event.seq > this.state.version));
                    this.logSize = offset;
                }
            } else if (this.missing || logSize !== this.logSize || hashText(actual) !== this.hash) {
                await transact(this.path, (txn) => this.reconcile(txn));
            }
            this.emitIfChanged();
        });
    }

    /** Without an anchor, a doc note: it needs no source, so it works while the file is missing. */
    async comment(input: { anchor?: Anchor; text: string }): Promise<Versioned<{ id: ThreadId }>> {
        return await this.mutate((txn) => {
            const anchor = input.anchor ? this.currentAnchor(input.anchor) : undefined;
            const id = nextThreadId(txn.events);
            txn.append([
                {
                    type: "comment",
                    by: "user",
                    id,
                    ...(anchor ? { anchor } : {}),
                    text: input.text,
                    draft: this.state.settings.hold,
                },
            ]);
            return { id };
        });
    }

    /** A user suggestion is a thread carrying a replacement. Held, it starts as a draft comment. */
    async suggest(input: {
        anchor: Anchor;
        replace: string;
        text?: string;
    }): Promise<Versioned<{ id: ThreadId }>> {
        return await this.mutate((txn) => {
            const anchor = this.currentAnchor(input.anchor);
            const id = nextThreadId(txn.events);
            const suggestion = { type: "suggest", by: "user", id, replace: input.replace } as const;
            const flags = { apply: false };
            if (this.state.settings.hold) {
                txn.append([
                    {
                        type: "comment",
                        by: "user",
                        id,
                        anchor,
                        text: input.text ?? "",
                        draft: true,
                    },
                    { ...suggestion, ...flags },
                ]);
            } else {
                txn.append([
                    {
                        ...suggestion,
                        ...flags,
                        anchor,
                        ...(input.text === undefined ? {} : { note: input.text }),
                    },
                ]);
            }
            return { id };
        });
    }

    async reply(id: ThreadId, text: string): Promise<Versioned<Ok & Seq>> {
        return await this.mutate((txn) => {
            this.thread(id);
            return appended(txn.append([{ type: "reply", by: "user", id, text }]));
        });
    }

    /** Applies a pending suggestion at its anchor, then resolves; both under one lock. */
    async accept(id: ThreadId): Promise<Versioned<SaveResult & Partial<Seq>>> {
        return await this.mutate((txn) => this.acceptIn(txn, this.thread(id)), MISSING);
    }

    private acceptIn(txn: LogTxn, thread: Thread): SaveResult & Partial<Seq> {
        const { id, suggestion } = thread;
        // A doc note never carries a suggestion; the guard only narrows the type.
        if (!suggestion || !thread.anchor) {
            throw new WireFailure(409, "no-suggestion");
        }
        if (suggestion.status === "pending") {
            if (this.missing) {
                return { ok: false, reason: "missing" };
            }
            const range = resolveAnchor(this.source, thread.anchor);
            if (!range) {
                return { ok: false, reason: "conflict", current: "" };
            }
            const result = applyEditIn(txn, {
                start: range.start,
                before: thread.anchor.exact,
                after: suggestion.replace,
                cause: "accept",
                by: "user",
                id,
            });
            if (!result.ok) {
                return this.failure(result, range.start, thread.anchor.exact.length);
            }
        }
        return appended(txn.append([{ type: "accept", by: "user", id }]));
    }

    async reject(id: ThreadId, note?: string): Promise<Versioned<Ok & Seq>> {
        return await this.mutate((txn) => {
            this.thread(id);
            return appended(
                txn.append([
                    { type: "reject", by: "user", id, ...(note === undefined ? {} : { note }) },
                ]),
            );
        });
    }

    async resolve(id: ThreadId): Promise<Versioned<Ok & Seq>> {
        return await this.mutate((txn) => {
            this.thread(id);
            return appended(txn.append([{ type: "resolve", by: "user", id }]));
        });
    }

    async reopen(id: ThreadId): Promise<Versioned<Ok & Seq>> {
        return await this.mutate((txn) => {
            this.thread(id);
            return appended(txn.append([{ type: "reopen", by: "user", id }]));
        });
    }

    /**
     * Takes back the user's own reply, accept, reject, resolve or reopen `seq` on `id`, while
     * the agent has not read it: refused once a claim names the thread, a cursor past the event
     * named it, or the agent acted on the thread since (`margin show` leaves no trace and is not
     * counted). An accept's text is put back first, strictly, in the same transaction: anything
     * that touched it since is a conflict and nothing is appended.
     */
    async retract(id: ThreadId, seq: number): Promise<Versioned<RetractResult>> {
        return await this.mutate((txn): RetractResult => {
            this.thread(id);
            if (this.history.some((event) => event.type === "retract" && event.of === seq)) {
                return OK;
            }
            const record = this.state.retractable.get(seq);
            if (!record || record.id !== id) {
                throw new WireFailure(404, "not-found", `no event ${seq} of yours on ${id}`);
            }
            if (seenByAgent(this.history, id, seq)) {
                return { ok: false, reason: "seen" };
            }
            if (record.type === "accept") {
                if (this.missing) {
                    return MISSING;
                }
                const edit = this.state.edits.findLast(
                    (logged) => logged.id === id && logged.cause === "accept" && logged.seq < seq,
                );
                if (edit) {
                    const mapped = this.mapStrict(edit.seq, edit.start, edit.after.length);
                    if (!mapped.exact || !this.source.startsWith(edit.after, mapped.start)) {
                        return { ok: false, reason: "conflict" };
                    }
                    const result = applyEditIn(txn, {
                        start: mapped.start,
                        before: edit.after,
                        after: edit.before,
                        cause: "revert",
                        by: "user",
                        id,
                    });
                    if (!result.ok) {
                        return result.reason === "missing"
                            ? MISSING
                            : { ok: false, reason: "conflict" };
                    }
                }
            }
            txn.append([{ type: "retract", by: "user", id, of: seq }]);
            return OK;
        }, MISSING);
    }

    /** Hides the thread from every view; the agent's commands on it are refused until undeleted. */
    async deleteThread(id: ThreadId): Promise<Versioned<Ok>> {
        return await this.mutate((txn) => {
            if (!this.state.deleted.has(id)) {
                this.thread(id);
                txn.append([{ type: "delete", by: "user", id }]);
            }
            return OK;
        });
    }

    /** Brings a deleted thread back as it was: nothing could touch it while it was deleted. */
    async undeleteThread(id: ThreadId): Promise<Versioned<Ok>> {
        return await this.mutate((txn) => {
            if (this.state.deleted.has(id)) {
                txn.append([{ type: "undelete", by: "user", id }]);
            } else {
                this.thread(id);
            }
            return OK;
        });
    }

    /** Undoes an agent's applied edit, located by moving it through every later splice. */
    async revert(id: ThreadId): Promise<Versioned<SaveResult>> {
        return await this.mutate((txn): SaveResult => {
            const applied = this.thread(id).applied;
            if (!applied || applied.reverted) {
                throw new WireFailure(409, "no-suggestion", "nothing applied to revert");
            }
            if (this.missing) {
                return { ok: false, reason: "missing" };
            }
            const mapped = mapStart(
                this.splicesSince(applied.seq),
                applied.start,
                applied.after.length,
            );
            if (!mapped.exact || !this.source.startsWith(applied.after, mapped.start)) {
                return this.conflict(mapped.start, applied.after.length);
            }
            const result = applyEditIn(txn, {
                start: mapped.start,
                before: applied.after,
                after: applied.before,
                cause: "revert",
                by: "user",
                id,
            });
            return result.ok
                ? { ok: true }
                : this.failure(result, mapped.start, applied.after.length);
        }, MISSING);
    }

    /**
     * Compare-and-swap on one unit. `start` moves through the splices logged since `version`;
     * `before` must then sit exactly there. No search elsewhere: a changed unit is a conflict.
     */
    async save(input: SaveRequest): Promise<Versioned<SaveResult & { at?: number }>> {
        return await this.mutate((txn): SaveResult & { at?: number; version?: number } => {
            if (this.missing) {
                return { ok: false, reason: "missing" };
            }
            const mapped =
                input.version === undefined
                    ? { start: input.start, exact: true }
                    : input.strict
                      ? this.mapStrict(input.version, input.start, input.before.length)
                      : mapStart(
                            this.splicesSince(input.version),
                            input.start,
                            input.before.length,
                        );
            if (!mapped.exact || !this.source.startsWith(input.before, mapped.start)) {
                return this.conflict(mapped.start, input.before.length);
            }
            const result = applyEditIn(txn, {
                start: mapped.start,
                before: input.before,
                after: input.after,
                by: "user",
                ...this.undoCause(input),
            });
            if (!result.ok) {
                return this.failure(result, mapped.start, input.before.length);
            }
            // `at` holds as of this save's own event (or the catch-up logged just before it). An
            // outside write the second reconcile logs after it must not be paired with it.
            return { ok: true, at: mapped.start, version: txn.events.at(-1)?.seq ?? 0 };
        }, MISSING);
    }

    /** A save that says it undoes a logged edit must be that edit's exact inverse. */
    private undoCause(input: SaveRequest): Pick<EditEvent, "cause" | "of"> {
        if (input.undoes === undefined) {
            return { cause: "user" };
        }
        const edit = this.state.edits.find((logged) => logged.seq === input.undoes);
        if (!edit || edit.after !== input.before || edit.before !== input.after) {
            throw new WireFailure(400, "bad-request", `not the inverse of edit ${input.undoes}`);
        }
        return { cause: "undo", of: input.undoes };
    }

    /** "Ask agent to follow through": a thread on the edit's text as it reads now. */
    async followThrough(editSeq: number, text: string): Promise<Versioned<{ id: ThreadId }>> {
        return await this.mutate((txn) => {
            const edit = this.state.edits.find((logged) => logged.seq === editSeq);
            if (!edit) {
                throw new WireFailure(404, "not-found", `no edit ${editSeq}`);
            }
            const mapped = mapStart(this.splicesSince(edit.seq), edit.start, edit.after.length);
            let range: Range | undefined;
            if (
                mapped.exact &&
                edit.after.length > 0 &&
                this.source.startsWith(edit.after, mapped.start)
            ) {
                range = { start: mapped.start, end: mapped.start + edit.after.length };
            } else {
                const at = clamp(mapped.start, this.source.length);
                range = unitAt(parseDoc(this.source).units, { start: at, end: at });
            }
            if (!range || range.end <= range.start) {
                throw new WireFailure(409, "bad-anchor", "the edit's text is gone");
            }
            const id = nextThreadId(txn.events);
            txn.append([
                {
                    type: "comment",
                    by: "user",
                    id,
                    anchor: createAnchor(this.source, range),
                    text,
                    draft: this.state.settings.hold,
                    followsEdit: editSeq,
                },
            ]);
            return { id };
        });
    }

    async setHold(on: boolean): Promise<Versioned<Ok>> {
        return await this.mutate((txn) => {
            txn.append([{ type: "hold", by: "user", on }]);
            return OK;
        });
    }

    async sendAll(): Promise<Versioned<Ok>> {
        return await this.mutate((txn) => {
            const ids = [...withoutDeleted(this.state).threads.values()]
                .filter((thread) => thread.state === "draft")
                .map((thread) => thread.id);
            if (ids.length > 0) {
                txn.append([{ type: "send", by: "user", ids }]);
            }
            return OK;
        });
    }

    async setSetting(key: DocSettingKey, value: boolean): Promise<Versioned<Ok>> {
        return await this.mutate((txn) => {
            txn.append([{ type: "setting", by: "user", key, value }]);
            return OK;
        });
    }

    /**
     * The refusal is decided under the lock, on the log as reconciled there: a thread opened a
     * moment before the request counts. The hash is the file's as read in that same reconcile.
     */
    async setVerdict(input: {
        state: VerdictState;
        note?: string;
        asIs?: boolean;
    }): Promise<Versioned<VerdictResult & Partial<Seq>>> {
        const note = verdictNote(input.note);
        return await this.mutate((txn): VerdictResult & Partial<Seq> => {
            if (this.missing) {
                throw new WireFailure(409, "missing");
            }
            if (input.state === "open" && (this.state.verdict?.state ?? "open") === "open") {
                return OK;
            }
            const ids =
                input.state === "approved"
                    ? unresolvedThreads(this.state).map((thread) => thread.id)
                    : [];
            if (ids.length > 0 && !input.asIs) {
                return { ok: false, reason: "unresolved", ids };
            }
            return appended(
                txn.append([
                    {
                        type: "verdict",
                        by: "user",
                        state: input.state,
                        hash: this.hash,
                        ...(note ? { note } : {}),
                        ...(ids.length > 0 ? { closed: ids } : {}),
                    },
                ]),
            );
        });
    }

    /**
     * Accepts the pending agent suggestions in the order they were made, each against the source
     * the one before it left: after every accept the log and the file are folded back in, so an
     * anchor a previous accept moved or swallowed is seen as it now is. One that no longer applies
     * logs nothing and stays pending. No `send` for the drafts: the finish event names them and
     * its fold opens them, so the agent hears of each thread once.
     */
    async requestFinish(): Promise<Versioned<FinishResult & Partial<Seq>>> {
        return await this.mutate((txn): FinishResult & Partial<Seq> => {
            if (this.missing) {
                throw new WireFailure(409, "missing");
            }
            const suggested = unresolvedThreads(this.state)
                .filter(
                    ({ suggestion }) =>
                        suggestion?.by === "agent" && suggestion.status === "pending",
                )
                .sort((a, b) => a.suggestion!.seq - b.suggestion!.seq)
                .map((thread) => thread.id);
            const unapplied: ThreadId[] = [];
            for (const id of suggested) {
                if (this.acceptIn(txn, this.thread(id)).ok) {
                    this.reconcile(txn);
                } else {
                    unapplied.push(id);
                }
            }
            const ids = unresolvedThreads(this.state).map((thread) => thread.id);
            if (ids.length === 0) {
                return { ids, unapplied };
            }
            const { seq } = appended(txn.append([{ type: "finish", by: "user", ids }]));
            return { ids, unapplied, seq };
        });
    }

    private async run<T>(task: () => Promise<T>): Promise<T> {
        const next = this.queue.then(task, task);
        this.queue = next.catch(() => undefined);
        return await next;
    }

    /**
     * Reconcile, act, reconcile: the second pass folds our own events and learns our own hash.
     * With the doc's directory gone, nothing runs: the lock would recreate it. The version is read
     * here, not by the caller: a mutation queued behind this one can run before the caller resumes.
     * A result carrying its own `version` keeps it.
     */
    private async mutate<T extends object>(
        fn: (txn: LogTxn) => T,
        whenGone?: T,
    ): Promise<Versioned<T>> {
        return await this.run(async () => {
            if (!existsSync(dirname(this.path))) {
                this.missing = true;
                this.emitIfChanged();
                if (whenGone === undefined) {
                    throw new WireFailure(409, "missing");
                }
                return { ...whenGone, version: this.state.version };
            }
            try {
                return await transact(this.path, (txn) => {
                    this.reconcile(txn);
                    const result = fn(txn);
                    this.reconcile(txn);
                    return { version: this.state.version, ...result };
                });
            } finally {
                this.emitIfChanged();
            }
        });
    }

    /**
     * Startup check, under the lock: undo the logged edits back to the last point whose hash is
     * known (an outside event, or what a daemon last saw). If the file does not lead back to that
     * hash, or an edit's text is not where it was put, the file changed while nobody watched: log
     * an outside change with no splice, so anchors re-resolve by quote.
     */
    private baseline(txn: LogTxn): void {
        this.fold(txn.events);
        const current = readSource(this.path);
        if (current === null) {
            this.missing = true;
            this.logSize = sizeOf(this.sidecar.log);
            return;
        }
        this.source = current;
        this.hash = hashText(current);
        const remembered = this.memory?.read() ?? null;
        let source = this.source;
        let known: string | undefined;
        let consistent = true;
        let i = txn.events.length - 1;
        for (; i >= 0; i--) {
            const event = txn.events[i]!;
            if (remembered && event.seq <= remembered.seq) {
                known = remembered.hash;
                break;
            }
            if (event.type === "outside") {
                known = event.hashAfter;
                break;
            }
            if (event.type === "reanchor") {
                known = event.hash;
                break;
            }
            if (event.type === "edit" && event.hashAfter !== undefined) {
                known = event.hashAfter;
                break;
            }
            if (event.type === "edit") {
                if (!source.startsWith(event.after, event.start)) {
                    consistent = false;
                    break;
                }
                source =
                    source.slice(0, event.start) +
                    event.before +
                    source.slice(event.start + event.after.length);
            }
        }
        if (i < 0 && remembered) {
            known = remembered.hash;
        }
        if (consistent && known !== undefined) {
            consistent = hashText(source) === known;
        }
        if (!consistent) {
            this.fold(
                txn.append([
                    { type: "outside", by: "user", hashBefore: known ?? "", hashAfter: this.hash },
                ]),
            );
        }
        if (!consistent || known === undefined) {
            this.reanchor(txn);
        }
        this.logSize = sizeOf(this.sidecar.log);
    }

    /**
     * After a change no splice describes, anchor hints no longer point at their quotes and the
     * fold cannot tell: re-pin them by quote in the log, before any later splice moves them.
     */
    private reanchor(txn: LogTxn): void {
        const input = reanchorInput(this.state, this.source);
        if (input) {
            this.fold(txn.append([input]));
        }
    }

    private remember(): void {
        if (!this.missing) {
            this.memory?.write({ seq: this.state.version, hash: this.hash });
        }
    }

    /**
     * Brings this session up to the log and the file, under the caller's lock. Logged edits are
     * replayed onto the source we last saw; if that lands on the file's bytes, every change was
     * margin's own (ours or the CLI's) and nothing is logged. Otherwise the difference is an
     * outside change: logged with its splice when the replay held and the splice is small, else
     * without one and followed by a reanchor.
     *
     * An edit whose replay breaks was made on a source this session never saw: a change landed
     * before it with no event (an editor save not yet synced). When that edit is the latest
     * change, the file still ends in it, and the unseen change lies wholly before it, the change
     * is logged as a splice after the edit: offsets before the edit are the same on both sides.
     */
    private reconcile(txn: LogTxn): void {
        const fresh = eventsAfter(txn.events, this.state.version);
        let expected: string | null = this.source;
        let expectedHash: string | null = this.hash;
        let unseen: { seen: string; edit: EditEvent } | undefined;
        for (const event of fresh) {
            if (event.type === "edit") {
                const seen: string | null = expected;
                expected =
                    seen !== null && seen.startsWith(event.before, event.start)
                        ? seen.slice(0, event.start) +
                          event.after +
                          seen.slice(event.start + event.before.length)
                        : null;
                expectedHash = expected === null ? (event.hashAfter ?? null) : hashText(expected);
                unseen =
                    seen !== null && expected === null && event.hashAfter !== undefined
                        ? { seen, edit: event }
                        : undefined;
            } else if (event.type === "outside") {
                expected = null;
                expectedHash = event.hashAfter;
                unseen = undefined;
            } else if (event.type === "reanchor") {
                expected = null;
                expectedHash = event.hash;
                unseen = undefined;
            }
        }
        this.fold(fresh);

        const actual = readSource(this.path);
        if (actual === null) {
            this.missing = true;
        } else {
            const actualHash = hashText(actual);
            let changed: boolean;
            let splice: SourceSplice | null = null;
            let hashBefore = expectedHash ?? this.hash;
            if (unseen && actualHash === unseen.edit.hashAfter) {
                changed = true;
                splice = unseenChange(unseen.seen, unseen.edit, actual);
                hashBefore = hashText(unseen.seen);
            } else if (expected === null) {
                changed = unseen !== undefined || expectedHash !== actualHash;
            } else {
                changed = expected !== actual;
                splice = changed ? sourceEdit(expected, actual) : null;
            }
            if (changed) {
                const edit =
                    splice !== null &&
                    splice.before.length + splice.after.length <= MAX_OUTSIDE_SPLICE
                        ? splice
                        : undefined;
                this.fold(
                    txn.append([
                        {
                            type: "outside",
                            by: "user",
                            hashBefore,
                            hashAfter: actualHash,
                            ...(edit ? { edit } : {}),
                        },
                    ]),
                );
                if (!edit) {
                    this.source = actual;
                    this.reanchor(txn);
                }
            }
            this.source = actual;
            this.hash = actualHash;
            this.missing = false;
        }
        this.logSize = sizeOf(this.sidecar.log);
    }

    private fold(events: readonly Event[]): void {
        for (const event of events) {
            applyEvent(this.state, event);
            this.history.push(event);
        }
    }

    private thread(id: ThreadId): Thread {
        const thread = this.state.deleted.has(id) ? undefined : this.state.threads.get(id);
        if (!thread) {
            throw new WireFailure(404, "not-found", `no thread ${id}`);
        }
        return thread;
    }

    /** The client's anchor re-read against the source as it is now, under the lock. */
    private currentAnchor(anchor: Anchor): Anchor {
        if (this.missing) {
            throw new WireFailure(409, "missing");
        }
        const range = resolveAnchor(this.source, anchor);
        if (!range) {
            throw new WireFailure(409, "bad-anchor", "quote not found");
        }
        return createAnchor(this.source, range);
    }

    /**
     * A version this log never reached (its sidecar was recreated) has nothing to map through, and
     * a strict save's compare-and-swap on an empty range checks nothing: a conflict.
     */
    private mapStrict(version: number, start: number, length: number) {
        return version > this.state.version
            ? { start, exact: false }
            : mapStartStrict(this.splicesSince(version), start, length);
    }

    /** Splices logged after `seq`; null for an outside change logged without one. */
    private splicesSince(seq: number): (SourceSplice | null)[] {
        const out: (SourceSplice | null)[] = [];
        for (const event of eventsAfter(this.history, seq)) {
            if (event.type === "edit") {
                out.push(event);
            } else if (event.type === "outside") {
                out.push(event.edit ?? null);
            }
        }
        return out;
    }

    private failure(
        result: Extract<ApplyResult, { ok: false }>,
        start: number,
        length: number,
    ): SaveResult {
        return result.reason === "missing"
            ? { ok: false, reason: "missing" }
            : this.conflict(start, length);
    }

    /** Conflict carrying the text of the unit that now sits where the edit was aimed. */
    private conflict(start: number, length: number): SaveResult {
        const at = clamp(start, this.source.length);
        const end = clamp(start + length, this.source.length);
        const units = parseDoc(this.source).units;
        const unit = unitAt(units, { start: at, end }) ?? unitAt(units, { start: at, end: at });
        return {
            ok: false,
            reason: "conflict",
            current: unit ? this.source.slice(unit.start, unit.end) : "",
        };
    }

    private key(): string {
        return `${this.state.version}|${this.hash}|${this.missing}`;
    }

    private emitIfChanged(): void {
        const key = this.key();
        if (key === this.emittedKey) {
            return;
        }
        this.emittedKey = key;
        this.remember();
        const json = this.snapshotJson();
        for (const listener of this.listeners) {
            listener(json, this.state.version);
        }
    }
}

/**
 * The change between the source this session saw and the one `edit` was made on (the file with
 * the edit undone), as a splice valid after the edit: only when it ends before the edit's text.
 */
function unseenChange(seen: string, edit: EditEvent, actual: string): SourceSplice | null {
    if (!actual.startsWith(edit.after, edit.start)) {
        return null;
    }
    const writerSaw =
        actual.slice(0, edit.start) + edit.before + actual.slice(edit.start + edit.after.length);
    const change = sourceEdit(seen, writerSaw);
    return change && change.start + change.after.length <= edit.start ? change : null;
}

/**
 * Moves a range start through splices in log order. `exact` is false once a splice overlaps the
 * range or cannot be known; `start` is then only a best guess for finding the unit there now.
 */
export function mapStart(
    splices: readonly (SourceSplice | null)[],
    start: number,
    length: number,
): { start: number; exact: boolean } {
    let at = start;
    let exact = true;
    for (const splice of splices) {
        if (splice === null) {
            exact = false;
            continue;
        }
        const span = exact ? length : 0;
        if (splice.start + splice.before.length <= at) {
            at += splice.after.length - splice.before.length;
        } else if (splice.start < at + span) {
            exact = false;
            at = splice.start;
        }
    }
    return { start: at, exact };
}

/**
 * `mapStart` for a strict save: a splice that overlaps the range or only touches it (an insertion
 * exactly at either end, or at the point of an empty range) is a conflict too.
 */
export function mapStartStrict(
    splices: readonly (SourceSplice | null)[],
    start: number,
    length: number,
): { start: number; exact: boolean } {
    let at = start;
    for (const splice of splices) {
        if (splice === null) {
            return { start: at, exact: false };
        }
        if (splice.start + splice.before.length < at) {
            at += splice.after.length - splice.before.length;
        } else if (splice.start <= at + length) {
            return { start: splice.start, exact: false };
        }
    }
    return { start: at, exact: true };
}

/** One line, trimmed; undefined when nothing is left. Longer than the cap is the client's error. */
function verdictNote(note: string | undefined): string | undefined {
    const line = note?.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (!line) {
        return undefined;
    }
    if (line.length > MAX_VERDICT_NOTE) {
        throw new WireFailure(400, "bad-request", `note over ${MAX_VERDICT_NOTE} characters`);
    }
    return line;
}

function eventsAfter(events: readonly Event[], seq: number): Event[] {
    let i = events.length;
    while (i > 0 && events[i - 1]!.seq > seq) {
        i--;
    }
    return events.slice(i);
}

function readSource(path: string): string | null {
    try {
        return decodeSource(readFileSync(path));
    } catch {
        // Gone, or no longer UTF-8: either way there is no source to show or splice.
        return null;
    }
}

function sizeOf(path: string): number {
    try {
        return statSync(path).size;
    } catch {
        return 0;
    }
}

function clamp(value: number, max: number): number {
    return Math.max(0, Math.min(value, max));
}
