import { createAnchor, rebaseAnchor, resolveAnchor } from "./anchor.ts";
import { hashText } from "./blocks.ts";
import { transact, type LogTxn } from "./log.ts";
import type {
    AppliedEdit,
    Anchor,
    DocSettings,
    EditEvent,
    Event,
    EventInput,
    IsoTime,
    SourceSplice,
    Thread,
    ThreadId,
} from "./model.ts";

/** A working thread with no activity for this long shows as "stalled". */
export const STALL_MS = 10 * 60 * 1000;

export interface DocState {
    threads: Map<ThreadId, Thread>;
    settings: DocSettings;
    /** Highest `upTo` seen per agent stream; 0 when the agent has never read. */
    cursors: { watch: number; pending: number };
    edits: EditEvent[];
    /** Time of the last claim or cursor event. */
    agentSeenAt?: IsoTime;
    /** Time of the last outside change. */
    changedOnDisk?: IsoTime;
    /** Seq of the last event folded in. */
    version: number;
}

export function emptyState(): DocState {
    return {
        threads: new Map(),
        settings: { hold: false, suggestionsOnly: false, autoApply: false },
        cursors: { watch: 0, pending: 0 },
        edits: [],
        version: 0,
    };
}

export function foldLog(events: readonly Event[]): DocState {
    const state = emptyState();
    for (const event of events) {
        applyEvent(state, event);
    }
    return state;
}

/**
 * `rebaseAnchor` reads `hint` as a position in the pre-splice source, so splices must be replayed
 * in log order. When the quote is gone the old anchor stays and `resolveAnchor` decides detached.
 * `owner` is the thread the splice was made on; its quote is re-pinned from the splice itself.
 */
function rebaseAll(state: DocState, splice: SourceSplice, owner?: ThreadId): void {
    for (const thread of state.threads.values()) {
        const own = thread.id === owner;
        thread.anchor = rebaseAnchor(thread.anchor, splice, { own }) ?? thread.anchor;
    }
}

/** Folds one event into `state` in place. Events must arrive in log order. */
export function applyEvent(state: DocState, event: Event): DocState {
    state.version = event.seq;
    switch (event.type) {
        case "comment": {
            const thread = newThread(event.id, event.anchor, event.by, event.at);
            thread.state = event.draft ? "draft" : event.by === "agent" ? "replied" : "open";
            thread.followsEdit = event.followsEdit;
            thread.messages.push(message(event, event.text));
            state.threads.set(event.id, thread);
            break;
        }
        case "suggest": {
            let thread = state.threads.get(event.id);
            if (!thread && event.anchor) {
                thread = newThread(event.id, event.anchor, event.by, event.at);
                state.threads.set(event.id, thread);
                // `suggest --find --apply` may log its edit first, before the thread exists.
                const edit = state.edits.findLast(
                    (logged) => logged.id === event.id && logged.cause === "apply",
                );
                if (edit) {
                    thread.applied = appliedFrom(edit);
                }
            }
            if (!thread) {
                break;
            }
            thread.lastActivity = event.at;
            if (event.note) {
                thread.messages.push(message(event, event.note));
            }
            thread.suggestion = {
                seq: event.seq,
                by: event.by,
                replace: event.replace,
                status: event.apply ? "accepted" : "pending",
            };
            if (event.by === "agent") {
                thread.state = "replied";
            } else if (thread.state !== "draft") {
                thread.state = "open";
            }
            break;
        }
        case "reply": {
            const thread = state.threads.get(event.id);
            if (!thread) {
                break;
            }
            thread.lastActivity = event.at;
            thread.messages.push(message(event, event.text));
            if (event.by === "agent") {
                thread.state = "replied";
            } else if (thread.state !== "draft") {
                thread.state = "open";
            }
            break;
        }
        case "claim":
            state.agentSeenAt = event.at;
            for (const id of event.ids) {
                const thread = state.threads.get(id);
                if (!thread) {
                    continue;
                }
                thread.lastActivity = event.at;
                thread.claimed = true;
                if (thread.state === "open") {
                    thread.state = "working";
                }
            }
            break;
        case "cursor":
            state.agentSeenAt = event.at;
            state.cursors[event.stream] = Math.max(state.cursors[event.stream], event.upTo);
            break;
        case "accept": {
            const thread = state.threads.get(event.id);
            if (!thread) {
                break;
            }
            thread.lastActivity = event.at;
            if (thread.suggestion) {
                thread.suggestion.status = "accepted";
            }
            thread.state = "resolved";
            break;
        }
        case "reject": {
            const thread = state.threads.get(event.id);
            if (!thread) {
                break;
            }
            thread.lastActivity = event.at;
            if (thread.suggestion) {
                thread.suggestion.status = "rejected";
            }
            if (event.note) {
                thread.messages.push(message(event, event.note));
                thread.state = "open";
            } else {
                thread.state = "resolved";
            }
            break;
        }
        case "resolve":
        case "reopen": {
            const thread = state.threads.get(event.id);
            if (!thread) {
                break;
            }
            thread.lastActivity = event.at;
            thread.state = event.type === "resolve" ? "resolved" : "open";
            break;
        }
        case "send":
            for (const id of event.ids) {
                const thread = state.threads.get(id);
                if (thread?.state === "draft") {
                    thread.lastActivity = event.at;
                    thread.state = "open";
                }
            }
            break;
        case "hold":
            state.settings.hold = event.on;
            break;
        case "setting": {
            if (event.id === undefined) {
                state.settings[event.key] = event.value;
                break;
            }
            const thread = state.threads.get(event.id);
            if (thread && event.key === "autoApply") {
                thread.autoApply = event.value;
            }
            break;
        }
        case "edit": {
            state.edits.push(event);
            rebaseAll(state, event, event.id);
            const thread = event.id === undefined ? undefined : state.threads.get(event.id);
            if (!thread) {
                break;
            }
            thread.lastActivity = event.at;
            if (event.cause === "apply") {
                thread.applied = appliedFrom(event);
            } else if (event.cause === "revert" && thread.applied) {
                thread.applied.reverted = true;
            }
            break;
        }
        case "outside":
            state.changedOnDisk = event.at;
            // Without a logged splice the anchor stays; a reanchor event follows it.
            if (event.edit) {
                rebaseAll(state, event.edit);
            }
            break;
        case "reanchor":
            for (const [id, anchor] of Object.entries(event.anchors)) {
                const thread = state.threads.get(id as ThreadId);
                if (thread && anchor) {
                    thread.anchor = anchor;
                }
            }
            break;
    }
    return state;
}

function newThread(id: ThreadId, anchor: Anchor, by: Thread["createdBy"], at: IsoTime): Thread {
    return {
        id,
        state: "open",
        anchor,
        detached: false,
        createdBy: by,
        messages: [],
        claimed: false,
        autoApply: false,
        lastActivity: at,
    };
}

function appliedFrom(edit: EditEvent): AppliedEdit {
    return {
        seq: edit.seq,
        start: edit.start,
        before: edit.before,
        after: edit.after,
        reverted: false,
    };
}

function message(event: Event, text: string): Thread["messages"][number] {
    return { seq: event.seq, at: event.at, by: event.by, text };
}

/** Threads `pending` returns: sent and waiting on the agent, claimed or not. */
export function needsAgent(thread: Thread): boolean {
    return thread.state === "open" || thread.state === "working";
}

export function isStalled(thread: Thread, now: Date | number = Date.now()): boolean {
    const time = typeof now === "number" ? now : now.getTime();
    return thread.state === "working" && time - Date.parse(thread.lastActivity) >= STALL_MS;
}

/** Next free thread id. Only meaningful inside a transaction, where the log cannot grow. */
export function nextThreadId(events: readonly Event[]): ThreadId {
    let max = 0;
    for (const event of events) {
        if ("id" in event && event.id !== undefined) {
            max = Math.max(max, Number(event.id.slice(1)));
        }
    }
    return `c${max + 1}`;
}

/**
 * The doc hash the log last vouched for: an edit's `hashAfter`, an outside change's, or a
 * reanchor's. Undefined when none is recorded, or an older edit without one comes later.
 */
export function lastKnownHash(events: readonly Event[]): string | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!;
        if (event.type === "edit" || event.type === "outside") {
            return event.hashAfter;
        }
        if (event.type === "reanchor") {
            return event.hash;
        }
    }
    return undefined;
}

/**
 * Re-pins every thread by quote against `source`; null when none moved. A quote that is gone
 * keeps its anchor (detached until the text returns).
 */
export function reanchorInput(state: DocState, source: string): EventInput | null {
    const anchors: Partial<Record<ThreadId, Anchor>> = {};
    let moved = false;
    for (const thread of state.threads.values()) {
        const range = resolveAnchor(source, thread.anchor);
        if (!range) {
            continue;
        }
        const fresh = createAnchor(source, range);
        const old = thread.anchor;
        if (fresh.hint !== old.hint || fresh.prefix !== old.prefix || fresh.suffix !== old.suffix) {
            anchors[thread.id] = fresh;
            moved = true;
        }
    }
    return moved ? { type: "reanchor", by: "user", hash: hashText(source), anchors } : null;
}

/**
 * What to log before touching a doc or anchoring in it, when the doc may have changed with no
 * event to say so: if its hash is not the one the log last vouched for, an outside change (when
 * a hash was known) and a reanchor, so later splices rebase anchors from where quotes really are.
 * `anchoring`: a new anchor is about to be logged in this source's offsets, so the hash is
 * recorded even when nothing else needs logging (an edit records it in its own `hashAfter`).
 */
export function catchUpInputs(
    events: readonly Event[],
    source: string,
    options: { anchoring?: boolean } = {},
): EventInput[] {
    const hash = hashText(source);
    const known = lastKnownHash(events);
    if (known === hash) {
        return [];
    }
    const inputs: EventInput[] = [];
    if (known !== undefined) {
        inputs.push({ type: "outside", by: "user", hashBefore: known, hashAfter: hash });
    }
    const reanchor = reanchorInput(foldLog(events), source);
    if (reanchor) {
        inputs.push(reanchor);
    } else if (known === undefined && options.anchoring) {
        // Record the hash anyway: a daemon that has not synced yet then takes the log's word
        // for this source instead of shifting the new anchor by the same change again.
        inputs.push({ type: "reanchor", by: "user", hash, anchors: {} });
    }
    return inputs;
}

/**
 * Allocates the next id and appends the events that create the thread, under one lock.
 * `build` gets the new id; its events are appended in order.
 */
export async function createThread(
    docPath: string,
    build: (id: ThreadId, txn: LogTxn) => EventInput[],
): Promise<{ id: ThreadId; events: Event[] }> {
    return await transact(docPath, (txn) => {
        const id = nextThreadId(txn.events);
        return { id, events: txn.append(build(id, txn)) };
    });
}
