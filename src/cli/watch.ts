// `margin watch` and `pending --wait`: tail the log without the lock, and once a batch of wakes
// settles, decide and record what was emitted under the lock. The cursor in the log, not this
// process, remembers what the agent has seen, so a re-armed or second watcher neither repeats
// nor loses a batch.
import { statSync } from "node:fs";
import type { Event, ThreadId, WakeReason } from "../core/model.ts";
import { LockTimeoutError } from "../core/lock.ts";
import { readLog, sidecar, transact } from "../core/log.ts";
import { withPresence } from "../server/presence.ts";
import { applyEvent, emptyState, needsAgent } from "../core/threads.ts";
import { locate, viewOf, type DocView } from "./doc.ts";
import { formatWatch, type CompactLine } from "./format.ts";

/** Quiet time after the last wake before a batch is emitted. */
export const DEBOUNCE_MS = 3_000;
/** A steady trickle of wakes still flushes this long after the first one in a batch. */
export const MAX_WAIT_MS = 10_000;
const POLL_MS = 150;

export type AgentStream = "watch" | "pending";

export interface WaitOptions {
    debounceMs?: number;
    maxWaitMs?: number;
    signal?: AbortSignal;
}

/** Only these wake the agent; accept, resolve, edits and the agent's own events never do. */
export function wakeReason(event: Event): WakeReason | undefined {
    switch (event.type) {
        case "comment":
            return event.by === "user" && !event.draft ? "new" : undefined;
        case "send":
            return "new";
        case "suggest":
            return event.by === "user" && event.anchor ? "new" : undefined;
        case "reply":
            return event.by === "user" ? "reply" : undefined;
        case "reject":
            return event.note ? "rejected" : undefined;
        default:
            return undefined;
    }
}

function wakeIds(event: Event): ThreadId[] {
    if (event.type === "send") return event.ids;
    return "id" in event && event.id !== undefined ? [event.id] : [];
}

/**
 * The batch woken after `afterSeq`: each thread that still waits on the agent, grouped by the
 * reason it first woke, with the heading path when a group shares one. Undefined when none do.
 */
export function watchLine(
    view: DocView,
    events: readonly Event[],
    afterSeq: number,
): CompactLine | undefined {
    const reasons = new Map<ThreadId, WakeReason>();
    for (const event of events) {
        if (event.seq <= afterSeq) continue;
        const reason = wakeReason(event);
        if (!reason) continue;
        for (const id of wakeIds(event)) if (!reasons.has(id)) reasons.set(id, reason);
    }
    const groups: CompactLine["groups"] = [];
    for (const [id, reason] of reasons) {
        const thread = view.state.threads.get(id);
        if (!thread || !needsAgent(thread)) continue;
        const { path } = locate(view, thread).context;
        const group = groups.find((candidate) => candidate.reason === reason);
        if (!group) {
            groups.push({ reason, ids: [id], path });
            continue;
        }
        group.ids.push(id);
        if (group.path !== path) delete group.path;
    }
    return groups.length > 0 ? { form: "compact", groups } : undefined;
}

function hasWakeAfter(events: readonly Event[], seq: number): boolean {
    return events.some((event) => event.seq > seq && wakeReason(event) !== undefined);
}

/**
 * Emits the batch past the watch cursor, if any, under the lock: moves the cursor, then prints
 * one compact line. It claims nothing; `pending` does. Returns whether anything was printed.
 */
export async function emitWatch(docPath: string, write: (text: string) => void): Promise<boolean> {
    return await transact(docPath, (txn) => {
        const view = viewOf(docPath, txn.events);
        const cursor = view.state.cursors.watch;
        if (!hasWakeAfter(txn.events, cursor)) return false;
        const line = watchLine(view, txn.events, cursor);
        txn.append([{ type: "cursor", by: "agent", stream: "watch", upTo: view.state.version }]);
        if (!line) return false;
        write(`${formatWatch(line)}\n`);
        return true;
    });
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
    private readonly state = emptyState();
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
        const debounce = this.options.debounceMs ?? DEBOUNCE_MS;
        const maxWait = this.options.maxWaitMs ?? MAX_WAIT_MS;
        const { signal } = this.options;
        const log = sidecar(this.docPath).log;
        while (!signal?.aborted) {
            if (!this.started || fileSize(log) !== this.offset) await this.read();
            const now = Date.now();
            if (this.lastWakeSeq <= this.state.cursors[this.stream]) {
                this.first = this.last = undefined;
            } else if (this.first !== undefined && this.last !== undefined) {
                if (now - this.last >= debounce || now - this.first >= maxWait) {
                    this.first = this.last = undefined;
                    return true;
                }
            }
            await sleep(POLL_MS, signal);
        }
        return false;
    }

    private async read(): Promise<void> {
        const { events, offset } = await readLog(this.docPath, this.offset);
        this.offset = offset;
        const now = Date.now();
        for (const event of events) {
            applyEvent(this.state, event);
            if (wakeReason(event) === undefined) continue;
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
): Promise<boolean> {
    while (!signal?.aborted) {
        try {
            return await emitWatch(docPath, write);
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
    options: WaitOptions & { once?: boolean } = {},
): Promise<void> {
    await withPresence(docPath, async () => {
        const tail = new WakeTail(docPath, "watch", options);
        while (await tail.next()) {
            if ((await emitRetrying(docPath, write, options.signal)) && options.once) return;
        }
    });
}
