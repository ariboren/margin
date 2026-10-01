import type { DocStore, EditEvent, Offset, SaveResult, ThreadId } from "../core/model.ts";
import type { Ok, RetractResult, Seq } from "../server/protocol.ts";

/** Entries kept per tab; older ones fall off. */
const UNDO_LIMIT = 100;

/** How long "Thread deleted · Undo" stays up. */
export const DELETE_NOTICE_MS = 8_000;

/** How long a refusal ("Can't undo: …") stays up. */
export const REFUSAL_NOTICE_MS = 5_000;

/** A logged text change; the inverse of the last one is what undo or redo sends. */
export interface Splice {
    seq: number;
    start: Offset;
    before: string;
    after: string;
}

export type ThreadAction =
    | { type: "reply"; text: string }
    | { type: "resolve" }
    | { type: "reopen" }
    | { type: "reject"; note?: string }
    | { type: "accept" };

export type Entry =
    | { kind: "edit"; last: Splice }
    | { kind: "create"; id: ThreadId; what: "comment" | "suggestion" }
    | { kind: "delete"; id: ThreadId }
    /** The user's own event `seq` on a thread, taken back with `retract`, done again with `action`. */
    | { kind: "thread"; id: ThreadId; seq: number; action: ThreadAction }
    /** Actions done as one (a bulk resolve), in order; undone and redone together. */
    | { kind: "batch"; label: string; entries: Entry[] };

/** `DocStore`'s void thread actions, answering with their event's seq. */
export interface ThreadActions {
    reply(id: ThreadId, text: string): Promise<Ok & Seq>;
    reject(id: ThreadId, note?: string): Promise<Ok & Seq>;
    resolve(id: ThreadId): Promise<Ok & Seq>;
    reopen(id: ThreadId): Promise<Ok & Seq>;
}

/** What thread entries need beyond `DocStore`; the daemon's store has it, the mockup's does not. */
export interface Retracting {
    retract(id: ThreadId, seq: number): Promise<RetractResult>;
    actions: ThreadActions;
}

function canRetract(store: DocStore): store is DocStore & Retracting {
    const candidate = store as Partial<Retracting>;
    return typeof candidate.retract === "function" && typeof candidate.actions === "object";
}

export type Notice = { kind: "deleted"; id: ThreadId } | { kind: "refused"; text: string } | null;

/** What an entry undoes or redoes, for "Undo reply", "Redo edit" and the like. */
export function describeEntry(entry: Entry): string {
    switch (entry.kind) {
        case "edit":
            return "edit";
        case "create":
            return entry.what;
        case "delete":
            return "delete";
        case "thread":
            return entry.action.type;
        case "batch":
            return entry.label;
    }
}

interface Timers {
    set: (done: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
}

const realTimers: Timers = {
    set: (done, ms) => setTimeout(done, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A mutation's answer may carry the log version (and seq) past `DocStore`'s types. */
function versionOf(result: unknown): number | undefined {
    const version = (result as { version?: unknown } | null)?.version;
    return typeof version === "number" ? version : undefined;
}

function seqOf(result: unknown): number | undefined {
    const seq = (result as { seq?: unknown } | null)?.seq;
    return typeof seq === "number" ? seq : undefined;
}

/** The edit event a save logged, by the version its answer named (the edit's own seq). */
function loggedSplice(edits: readonly EditEvent[], seq: number): Splice | null {
    const edit = edits.find((candidate) => candidate.seq === seq);
    return edit ? { seq, start: edit.start, before: edit.before, after: edit.after } : null;
}

function inverse(splice: Splice) {
    return {
        start: splice.start,
        before: splice.after,
        after: splice.before,
        version: splice.seq,
        strict: true as const,
        undoes: splice.seq,
    };
}

type Outcome =
    /** The entry moves to the other stack, as `entry`; `notice` says what part of it did not. */
    | { done: Entry; notice?: string }
    /** Nothing changed and nothing can: the entry goes. */
    | { drop: string | null }
    /** Nothing changed for now (file missing, request failed): the entry stays. */
    | { keep: true };

/**
 * The user's own actions in this tab, undone and redone in order. Every step appends to the log:
 * text goes back through a strict save from the version of the change it reverses, so text anyone
 * changed since is never overwritten; a thread event is taken back with `retract`, which the daemon
 * refuses once the agent has read it. A refusal shows a notice and drops the entry.
 */
export class UndoStack {
    private past: Entry[] = [];
    private future: Entry[] = [];
    private busy = false;
    /** Entries pushed while a `group` runs, folded into one when it ends. */
    private grouping: Entry[] | null = null;
    private notice: Notice = null;
    private timer: unknown;
    private readonly listeners = new Set<(notice: Notice) => void>();
    private readonly changeListeners = new Set<() => void>();

    constructor(
        private readonly host: DocStore,
        private readonly timers: Timers = realTimers,
        private readonly limit = UNDO_LIMIT,
    ) {}

    get canUndo(): boolean {
        return this.past.length > 0;
    }

    get canRedo(): boolean {
        return this.future.length > 0;
    }

    /** What undo would act on. */
    get top(): Entry | null {
        return this.past[this.past.length - 1] ?? null;
    }

    /** What redo would act on. */
    get next(): Entry | null {
        return this.future[this.future.length - 1] ?? null;
    }

    get current(): Notice {
        return this.notice;
    }

    subscribe(listener: (notice: Notice) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Called after the stacks change: a push, or an undo or redo that finished. */
    onChange(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => {
            this.changeListeners.delete(listener);
        };
    }

    /** A new action: redo is gone, and the notice with it, so "Undo" on it is always the top. */
    push(entry: Entry): void {
        if (this.grouping) {
            this.grouping.push(entry);
            return;
        }
        this.past.push(entry);
        if (this.past.length > this.limit) {
            this.past.shift();
        }
        this.future = [];
        this.show(entry.kind === "delete" ? { kind: "deleted", id: entry.id } : null);
        this.changed();
    }

    /**
     * Everything `run` records becomes one entry named `label` ("Undo resolve of 3 detached
     * threads"); a lone action stays itself. What landed before `run` failed is still recorded.
     * Any other action of the user landing meanwhile joins the group.
     */
    async group(label: string, run: () => Promise<void>): Promise<void> {
        if (this.grouping) {
            await run();
            return;
        }
        const entries: Entry[] = [];
        this.grouping = entries;
        try {
            await run();
        } finally {
            this.grouping = null;
            if (entries.length === 1) {
                this.push(entries[0]!);
            } else if (entries.length > 1) {
                this.push({ kind: "batch", label, entries });
            }
        }
    }

    async undo(): Promise<void> {
        await this.step(this.past, this.future, "undo");
    }

    async redo(): Promise<void> {
        await this.step(this.future, this.past, "redo");
    }

    private async step(from: Entry[], to: Entry[], direction: "undo" | "redo"): Promise<void> {
        const entry = from[from.length - 1];
        if (!entry || this.busy) {
            return;
        }
        this.busy = true;
        this.show(null);
        try {
            const outcome = await this.apply(entry, direction);
            if ("keep" in outcome) {
                return;
            }
            // A push meanwhile owns the stacks: the entry still goes (its effect landed), but an
            // undone one is not offered for redo over the newer action.
            const index = from.lastIndexOf(entry);
            const undisturbed = index === from.length - 1;
            if (index >= 0) {
                from.splice(index, 1);
            }
            if ("drop" in outcome) {
                if (outcome.drop !== null) {
                    this.show({ kind: "refused", text: outcome.drop });
                }
                return;
            }
            if (!undisturbed && direction === "undo") {
                return;
            }
            to.push(outcome.done);
            if (outcome.done.kind === "delete" && direction === "redo") {
                this.show({ kind: "deleted", id: outcome.done.id });
            } else if (outcome.notice !== undefined) {
                this.show({ kind: "refused", text: outcome.notice });
            }
        } finally {
            this.busy = false;
            this.changed();
        }
    }

    private changed(): void {
        for (const listener of this.changeListeners) {
            listener();
        }
    }

    private async apply(entry: Entry, direction: "undo" | "redo"): Promise<Outcome> {
        try {
            switch (entry.kind) {
                case "edit":
                    return await this.applyEdit(entry, direction);
                case "create":
                    await (direction === "undo"
                        ? this.host.deleteThread(entry.id)
                        : this.host.undeleteThread(entry.id));
                    return { done: entry };
                case "delete":
                    await (direction === "undo"
                        ? this.host.undeleteThread(entry.id)
                        : this.host.deleteThread(entry.id));
                    return { done: entry };
                case "thread":
                    return direction === "undo"
                        ? await this.retract(entry)
                        : await this.redoThread(entry);
                case "batch":
                    return await this.applyBatch(entry, direction);
            }
        } catch {
            // The store reports the failure; nothing was logged.
            return { keep: true };
        }
    }

    /**
     * Each part on its own, undo in reverse: a part the agent has read is refused and dropped,
     * the rest go through and stay as the batch to redo. A part that changed nothing for now
     * (file missing, request failed) is tried again only when the whole batch is kept.
     */
    private async applyBatch(
        entry: Extract<Entry, { kind: "batch" }>,
        direction: "undo" | "redo",
    ): Promise<Outcome> {
        const ordered = direction === "undo" ? [...entry.entries].reverse() : entry.entries;
        const done: Entry[] = [];
        let refused: string | null = null;
        let refusals = 0;
        let kept = 0;
        for (const part of ordered) {
            const outcome = await this.apply(part, direction);
            if ("done" in outcome) {
                done.push(outcome.done);
            } else if ("keep" in outcome) {
                kept++;
            } else {
                refusals++;
                refused ??= outcome.drop;
            }
        }
        if (done.length === 0) {
            if (refusals === 0) {
                return kept > 0 ? { keep: true } : { drop: null };
            }
            return {
                drop:
                    refusals === 1
                        ? refused
                        : `Can't ${direction}: the agent has already read these ${refusals} threads.`,
            };
        }
        const entries = direction === "undo" ? done.reverse() : done;
        const result: Outcome = { done: { ...entry, entries } };
        if (refusals > 0) {
            result.notice = `${direction === "undo" ? "Undid" : "Redid"} ${done.length} of ${ordered.length}: the agent has already read the rest.`;
        }
        return result;
    }

    private async applyEdit(
        entry: Extract<Entry, { kind: "edit" }>,
        direction: "undo" | "redo",
    ): Promise<Outcome> {
        const request = inverse(entry.last);
        const result: SaveResult = await this.host.saveUnit(request);
        if (!result.ok) {
            return result.reason === "missing"
                ? { keep: true }
                : { drop: `Can't ${direction}: this text changed since.` };
        }
        const snapshot = this.host.snapshot();
        const seq = versionOf(result) ?? snapshot.version;
        const last = loggedSplice(snapshot.edits, seq) ?? {
            seq,
            start: request.start,
            before: request.before,
            after: request.after,
        };
        return { done: { kind: "edit", last } };
    }

    private async retract(entry: Extract<Entry, { kind: "thread" }>): Promise<Outcome> {
        if (!canRetract(this.host)) {
            return { drop: null };
        }
        const result = await this.host.retract(entry.id, entry.seq);
        if (result.ok) {
            return { done: entry };
        }
        switch (result.reason) {
            case "missing":
                return { keep: true };
            case "seen":
                return { drop: `Can't undo: the agent has already read ${entry.id}.` };
            case "conflict":
                return { drop: "Can't undo: the text changed since the suggestion was accepted." };
        }
    }

    private async redoThread(entry: Extract<Entry, { kind: "thread" }>): Promise<Outcome> {
        const { id, action } = entry;
        if (!canRetract(this.host)) {
            return { drop: null };
        }
        let result: Seq | SaveResult;
        switch (action.type) {
            case "reply":
                result = await this.host.actions.reply(id, action.text);
                break;
            case "resolve":
                result = await this.host.actions.resolve(id);
                break;
            case "reopen":
                result = await this.host.actions.reopen(id);
                break;
            case "reject":
                result = await this.host.actions.reject(id, action.note);
                break;
            case "accept": {
                const accepted = await this.host.accept(id);
                if (!accepted.ok) {
                    return accepted.reason === "missing"
                        ? { keep: true }
                        : { drop: "Can't redo: the quoted text changed since." };
                }
                result = accepted;
                break;
            }
        }
        const seq = seqOf(result);
        return seq === undefined ? { drop: null } : { done: { ...entry, seq } };
    }

    private show(notice: Notice): void {
        this.timers.clear(this.timer);
        this.notice = notice;
        for (const listener of this.listeners) {
            listener(notice);
        }
        if (notice !== null) {
            const ms = notice.kind === "deleted" ? DELETE_NOTICE_MS : REFUSAL_NOTICE_MS;
            this.timer = this.timers.set(() => this.show(null), ms);
        }
    }
}

/**
 * The store the page uses: every action goes to `host` and, once it has landed, onto `stack`.
 * Undo and redo call `host` directly, so they are never recorded themselves. Agent actions never
 * come through here. Thread events are recorded only when the host can take them back.
 */
export function recording(host: DocStore, stack: UndoStack): DocStore {
    const record = (id: ThreadId, result: unknown, action: ThreadAction) => {
        const seq = seqOf(result);
        if (seq !== undefined) {
            stack.push({ kind: "thread", id, seq, action });
        }
    };
    // Through `actions` when the host has them, so the answer carries the seq to record.
    const act = async <A extends ThreadAction>(
        id: ThreadId,
        action: A,
        run: (actions: ThreadActions) => Promise<Seq>,
        plain: () => Promise<void>,
    ) => {
        if (canRetract(host)) {
            record(id, await run(host.actions), action);
        } else {
            await plain();
        }
    };
    return {
        snapshot: () => host.snapshot(),
        subscribe: (listener) => host.subscribe(listener),
        async comment(input) {
            const id = await host.comment(input);
            stack.push({ kind: "create", id, what: "comment" });
            return id;
        },
        async suggest(input) {
            const id = await host.suggest(input);
            stack.push({ kind: "create", id, what: "suggestion" });
            return id;
        },
        reply: (id, text) =>
            act(
                id,
                { type: "reply", text },
                (actions) => actions.reply(id, text),
                () => host.reply(id, text),
            ),
        async accept(id) {
            const result = await host.accept(id);
            if (result.ok && canRetract(host)) {
                record(id, result, { type: "accept" });
            }
            return result;
        },
        reject: (id, note) =>
            act(
                id,
                note === undefined ? { type: "reject" } : { type: "reject", note },
                (actions) => actions.reject(id, note),
                () => host.reject(id, note),
            ),
        resolve: (id) =>
            act(
                id,
                { type: "resolve" },
                (actions) => actions.resolve(id),
                () => host.resolve(id),
            ),
        reopen: (id) =>
            act(
                id,
                { type: "reopen" },
                (actions) => actions.reopen(id),
                () => host.reopen(id),
            ),
        async deleteThread(id) {
            await host.deleteThread(id);
            stack.push({ kind: "delete", id });
        },
        undeleteThread: (id) => host.undeleteThread(id),
        revert: (id) => host.revert(id),
        async saveUnit(edit) {
            const result = await host.saveUnit(edit);
            if (result.ok) {
                const snapshot = host.snapshot();
                const last = loggedSplice(snapshot.edits, versionOf(result) ?? snapshot.version);
                if (last) {
                    stack.push({ kind: "edit", last });
                }
            }
            return result;
        },
        async followThrough(editSeq, text) {
            const id = await host.followThrough(editSeq, text);
            stack.push({ kind: "create", id, what: "comment" });
            return id;
        },
        setHold: (on) => host.setHold(on),
        sendAll: () => host.sendAll(),
        setSetting: (key, value) => host.setSetting(key, value),
        setVerdict: (input) => host.setVerdict(input),
        requestFinish: () => host.requestFinish(),
        dismissChangedOnDisk: () => host.dismissChangedOnDisk(),
        ...statusOf(host),
    };
}

/** The host's connection link, when it has one, so the page's chip still sees the daemon. */
function statusOf(host: DocStore): Pick<DocStore, "status" | "subscribeStatus"> {
    const { status, subscribeStatus } = host;
    if (!status || !subscribeStatus) {
        return {};
    }
    return {
        status: () => status.call(host),
        subscribeStatus: (listener) => subscribeStatus.call(host, listener),
    };
}
