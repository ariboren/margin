// `margin watch` and `pending --wait`: tail the log without the lock, and once a batch of wakes
// settles, decide and record what was emitted under the lock. The cursor in the log, not this
// process, remembers what the agent has seen, so a re-armed or second watcher neither repeats
// nor loses a batch.
import { statSync } from "node:fs";
import { UNKNOWN_AGENT, signed } from "../core/agent.ts";
import {
    isDocNote,
    isVerdictState,
    type AgentIdentity,
    type Event,
    type ThreadId,
    type WakeReason,
} from "../core/model.ts";
import { LockTimeoutError, type LockOptions } from "../core/lock.ts";
import { readLog, sidecar, transact } from "../core/log.ts";
import { holdPresence, withPresence, type PresenceHold } from "../server/presence.ts";
import {
    applyEvent,
    emptyState,
    finishRemaining,
    needsAgent,
    type DocState,
} from "../core/threads.ts";
import { locate, viewOf, type DocView } from "./doc.ts";
import { formatWatch, type CompactLine } from "./format.ts";

/** Quiet time after the last wake before a batch is emitted. */
export const DEBOUNCE_MS = 200;
/** A steady trickle of wakes still flushes this long after the first one in a batch. */
export const MAX_WAIT_MS = 10_000;
const POLL_MS = 150;

export type AgentStream = "watch" | "pending";

export interface WaitOptions {
    debounceMs?: number;
    maxWaitMs?: number;
    signal?: AbortSignal;
}

/**
 * Only these wake the agent; accept, resolve, edits and the agent's own events never do. A
 * retract wakes when it leaves its thread waiting on the agent in `state` (the fold at or after
 * the event): a resolve taken back after a watch cursor passed the thread without printing it
 * would otherwise strand it. It reads as new while the user's last message is the thread's first.
 * A finish request wakes for the threads it hands over, held drafts included: no `send` is logged
 * for those, so `finish` is the only word they wake under.
 */
export function wakeReason(event: Event, state: DocState): WakeReason | undefined {
    switch (event.type) {
        case "retract": {
            const thread = state.threads.get(event.id);
            if (!thread || !needsAgent(thread)) return undefined;
            const last = thread.messages.findLast((message) => message.by === "user");
            return last && last !== thread.messages[0] ? "reply" : "new";
        }
        case "comment":
            return event.by === "user" && !event.draft ? "new" : undefined;
        case "send":
        case "undelete":
            return "new";
        case "suggest":
            return event.by === "user" && event.anchor ? "new" : undefined;
        case "reply":
            return event.by === "user" ? "reply" : undefined;
        case "reject":
            return event.note ? "rejected" : undefined;
        case "finish":
            return event.by === "user" ? "finish" : undefined;
        default:
            return undefined;
    }
}

/**
 * The doc-level wake of `event`: a verdict, or the user's event that put an approved or declined
 * doc back to open, which the fold records by giving the open verdict that event's seq. In a
 * `state` folded past the event only the one that set the standing status still reads as a reopen.
 */
export function docWake(event: Event, state: DocState): WakeReason | undefined {
    if (event.type === "verdict") {
        // The fold ignores one the user did not sign or in an unknown state, so it changed
        // nothing to wake for.
        if (event.by !== "user" || !isVerdictState(event.state)) return undefined;
        return event.state === "open" ? "reopened" : event.state;
    }
    const { verdict } = state;
    return verdict?.state === "open" && verdict.seq === event.seq ? "reopened" : undefined;
}

function wakes(event: Event, state: DocState): boolean {
    return wakeReason(event, state) !== undefined || docWake(event, state) !== undefined;
}

/**
 * The threads of the finish request still waiting on the agent. One it answered without
 * resolving waits on the user, so the request stops being announced once none is left.
 */
export function finishWaiting(state: DocState): ThreadId[] {
    return finishRemaining(state).filter((id) => {
        const thread = state.threads.get(id);
        return thread !== undefined && needsAgent(thread);
    });
}

function wakeIds(event: Event): ThreadId[] {
    if (event.type === "send") return event.ids;
    return "id" in event && event.id !== undefined ? [event.id] : [];
}

/**
 * The batch woken after `afterSeq`. First the doc's status if it changed since, as it stands now:
 * of several verdicts and reopens only the last matters. Then a finish request made since, with
 * the threads it still leaves to the agent; it implies the doc is open, so `reopened` is left out
 * beside it. Then each other thread that still waits on the agent, grouped by the reason it first
 * woke, with the heading path when a group shares one (`doc` when the group is all doc notes).
 * Undefined when there is nothing to say.
 */
export function watchLine(
    view: DocView,
    events: readonly Event[],
    afterSeq: number,
): CompactLine | undefined {
    const { verdict, finish } = view.state;
    const handed = finish && finish.seq > afterSeq ? finishWaiting(view.state) : [];
    const groups: CompactLine["groups"] = [];
    if (verdict && verdict.seq > afterSeq && (verdict.state !== "open" || handed.length === 0)) {
        groups.push({ reason: verdict.state === "open" ? "reopened" : verdict.state, ids: [] });
    }
    if (handed.length > 0) groups.push({ reason: "finish", ids: handed });

    const reasons = new Map<ThreadId, WakeReason>();
    for (const event of events) {
        if (event.seq <= afterSeq) continue;
        const reason = wakeReason(event, view.state);
        if (!reason) continue;
        for (const id of wakeIds(event)) {
            if (!reasons.has(id) && !handed.includes(id)) reasons.set(id, reason);
        }
    }
    for (const [id, reason] of reasons) {
        const thread = view.state.threads.get(id);
        if (!thread || !needsAgent(thread)) continue;
        const doc = isDocNote(thread);
        const { path } = locate(view, thread).context;
        const group = groups.find((candidate) => candidate.reason === reason);
        if (!group) {
            groups.push({ reason, ids: [id], ...(doc ? { doc: true as const } : { path }) });
            continue;
        }
        group.ids.push(id);
        if (group.path !== path) delete group.path;
        if (!doc) delete group.doc;
    }
    return groups.length > 0 ? { form: "compact", groups } : undefined;
}

function hasWakeAfter(events: readonly Event[], state: DocState, seq: number): boolean {
    return events.some((event) => event.seq > seq && wakes(event, state));
}

/**
 * Emits the batch past the watch cursor, if any, under the lock: moves the cursor, then prints
 * one compact line. It claims nothing; `pending` does. Returns whether anything was printed.
 * The cursor moves even when nothing prints (a wake whose thread no longer waits), or the batch
 * would be reconsidered forever; it names the threads it printed so a retract can tell the two
 * apart.
 */
export async function emitWatch(
    docPath: string,
    write: (text: string) => void,
    agent?: AgentIdentity,
    lock?: LockOptions,
): Promise<boolean> {
    return await transact(
        docPath,
        (txn) => {
            const view = viewOf(docPath, txn.events);
            const cursor = view.state.cursors.watch;
            if (!hasWakeAfter(txn.events, view.state, cursor)) return false;
            const line = watchLine(view, txn.events, cursor);
            txn.append([
                {
                    type: "cursor",
                    by: "agent",
                    ...signed(agent),
                    stream: "watch",
                    upTo: view.state.version,
                    ids: line?.groups.flatMap((group) => group.ids) ?? [],
                },
            ]);
            if (!line) return false;
            write(`${formatWatch(line)}\n`);
            return true;
        },
        lock,
    );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((done) => {
        const timer = setTimeout(done, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                done();
            },
            { once: true },
        );
    });
}

/**
 * Follows the log and resolves once wakes past `stream`'s cursor have settled: `debounceMs`
 * after the last, or `maxWaitMs` after the first. A backlog found on the first read is due at
 * once. Resolves false when aborted.
 */
export class WakeTail {
    private offset = 0;
    private state = emptyState();
    private lastWakeSeq = 0;
    private first: number | undefined;
    private last: number | undefined;
    private started = false;

    constructor(
        private readonly docPath: string,
        private readonly stream: AgentStream,
        private readonly options: WaitOptions = {},
    ) {}

    async next(): Promise<boolean> {
        const { signal } = this.options;
        while (!signal?.aborted) {
            const wait = await this.poll();
            if (wait === 0) return true;
            await sleep(wait, signal);
        }
        return false;
    }

    /**
     * Reads what the log gained and answers 0 once a batch is due, else how long to sleep before
     * asking again. A watch over several docs polls each tail in turn rather than block on one.
     */
    async poll(): Promise<number> {
        const debounce = this.options.debounceMs ?? DEBOUNCE_MS;
        const maxWait = this.options.maxWaitMs ?? MAX_WAIT_MS;
        const size = fileSize(sidecar(this.docPath).log);
        // A log shorter than what was read is a new one (the sidecar was deleted): its seqs
        // start over, so the fold does too.
        if (size < this.offset) this.reset();
        if (!this.started || size !== this.offset) await this.read();
        if (this.lastWakeSeq <= this.state.cursors[this.stream]) {
            this.first = this.last = undefined;
        } else if (this.first !== undefined && this.last !== undefined) {
            const now = Date.now();
            const due = Math.min(this.last + debounce, this.first + maxWait);
            if (now >= due) {
                this.first = this.last = undefined;
                return 0;
            }
            return Math.min(POLL_MS, due - now);
        }
        return POLL_MS;
    }

    /** Makes the batch `poll` just announced due again: it could not be emitted this time. */
    retry(): void {
        this.first = this.last = -Infinity;
    }

    /** Forgets what was read, so the next poll reads the log whole and a backlog is due at once. */
    reset(): void {
        this.offset = 0;
        this.state = emptyState();
        this.lastWakeSeq = 0;
        this.first = this.last = undefined;
        this.started = false;
    }

    private async read(): Promise<void> {
        const { events, offset } = await readLog(this.docPath, this.offset);
        this.offset = offset;
        const now = Date.now();
        for (const event of events) {
            applyEvent(this.state, event);
            if (!wakes(event, this.state)) continue;
            this.lastWakeSeq = event.seq;
            // A backlog has already waited long enough.
            this.first ??= this.started ? now : -Infinity;
            this.last = this.started ? now : -Infinity;
        }
        this.started = true;
    }
}

function fileSize(path: string): number {
    try {
        return statSync(path).size;
    } catch {
        return 0;
    }
}

/** A long-running watch outlives a busy lock rather than exiting on it; the batch waits. */
async function emitRetrying(
    docPath: string,
    write: (text: string) => void,
    signal?: AbortSignal,
    agent?: AgentIdentity,
): Promise<boolean> {
    while (!signal?.aborted) {
        try {
            return await emitWatch(docPath, write, agent);
        } catch (error) {
            if (!(error instanceof LockTimeoutError)) throw error;
        }
    }
    return false;
}

/**
 * Runs until aborted, or after the first printed batch with `once`. Holds the presence file the
 * whole time, so the page shows "Agent watching" between batches.
 */
export async function watch(
    docPath: string,
    write: (text: string) => void,
    options: WaitOptions & { once?: boolean; agent?: AgentIdentity } = {},
): Promise<void> {
    await withPresence(docPath, options.agent ?? UNKNOWN_AGENT, async () => {
        const tail = new WakeTail(docPath, "watch", options);
        while (await tail.next()) {
            if ((await emitRetrying(docPath, write, options.signal, options.agent)) && options.once)
                return;
        }
    });
}

/** Printed once when a session's doc list is removed under a running watch. */
export const LIST_LOST =
    "session doc list lost; run margin pending <doc> on each doc to keep it watched\n";

/** How often a session watch marks its list as in use, and looks after its presence entries. */
const REFRESH_MS = 60 * 60 * 1000;
const RENEW_MS = 1_000;
/** A doc whose lock is held is tried again this soon; the other docs are not kept waiting. */
const LOCK_RETRY_MS = 25;

export interface SessionWatchOptions extends WaitOptions {
    once?: boolean;
    agent?: AgentIdentity;
    /** How a line names its doc, in a form the agent can pass back to `margin pending`. */
    name?: (docPath: string) => string;
    /** Called at the start and every `refreshMs` after: keeps the session's list from expiring. */
    refresh?: () => void;
    refreshMs?: number;
}

interface Followed {
    tail: WakeTail;
    presence: PresenceHold;
}

/**
 * One watch over every doc `docs` returns, asked again on each pass, so a doc the session opens
 * later joins and one whose file is gone leaves. Each doc keeps its own tail, cursor and presence
 * entry, as if it had a watch of its own. A line leads with its doc while more than one is
 * followed. Runs until aborted, or after the first printed batch with `once`; with no docs it
 * waits for one.
 *
 * `docs` answers undefined when the session has no list. If that happens to a list the watch has
 * seen, it says so once and keeps the docs it has: going quiet would look like nothing to answer.
 */
export async function watchSession(
    docs: () => string[] | undefined,
    write: (text: string) => void,
    options: SessionWatchOptions = {},
): Promise<void> {
    const { signal, agent } = options;
    const name = options.name ?? ((docPath: string) => docPath);
    const refreshMs = options.refreshMs ?? REFRESH_MS;
    const followed = new Map<string, Followed>();
    let listed = false;
    let refreshed = -Infinity;
    let renewed = Date.now();
    try {
        while (!signal?.aborted) {
            const now = Date.now();
            if (now - refreshed >= refreshMs) {
                options.refresh?.();
                refreshed = now;
            }
            const current = docs();
            if (current === undefined) {
                if (listed) write(LIST_LOST);
                listed = false;
            } else {
                listed = true;
                follow(followed, current, options);
            }
            if (now - renewed >= RENEW_MS) {
                for (const { presence } of followed.values()) presence.renew();
                renewed = now;
            }
            let wait = POLL_MS;
            for (const [doc, { tail }] of followed) {
                try {
                    const due = await tail.poll();
                    if (due > 0) {
                        wait = Math.min(wait, due);
                        continue;
                    }
                    const lead = followed.size > 1 ? `${name(doc)}: ` : "";
                    const print = (text: string) => write(lead + text);
                    if ((await emitWatch(doc, print, agent, { timeoutMs: 0 })) && options.once)
                        return;
                } catch (error) {
                    if (error instanceof LockTimeoutError) {
                        tail.retry();
                        wait = Math.min(wait, LOCK_RETRY_MS);
                        continue;
                    }
                    if (typeof (error as NodeJS.ErrnoException).code !== "string") throw error;
                    // The doc or its sidecar went away mid-read. The other docs carry on, and
                    // this one is read afresh on the next pass: its cursor is in its log.
                    tail.reset();
                }
            }
            await sleep(wait, signal);
        }
    } finally {
        for (const { presence } of followed.values()) presence.release();
    }
}

function follow(
    followed: Map<string, Followed>,
    docs: readonly string[],
    options: SessionWatchOptions,
): void {
    const current = new Set(docs);
    for (const [doc, { presence }] of followed) {
        if (current.has(doc)) continue;
        presence.release();
        followed.delete(doc);
    }
    for (const doc of current) {
        if (followed.has(doc)) continue;
        followed.set(doc, {
            tail: new WakeTail(doc, "watch", options),
            presence: holdPresence(doc, options.agent ?? UNKNOWN_AGENT),
        });
    }
}
