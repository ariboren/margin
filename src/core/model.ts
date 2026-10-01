// Shared types for every module. Frozen after W0: changes go through the foreman.

/**
 * An index into the document source, counted in UTF-16 code units of the string produced by
 * `decodeSource` (fatal UTF-8, BOM kept), so a BOM sits at index 0. Ranges are half-open.
 */
export type Offset = number;

export type IsoTime = string;

export type Author = "user" | "agent";

export type AgentClient = "claude-code" | "codex" | "cursor" | "unknown";

/** Who an agent-side command said it was. Absent in logs written before it existed. */
export interface AgentIdentity {
    name: string;
    client: AgentClient;
}

/** Allocated under the log lock, never reused. */
export type ThreadId = `c${number}`;

// Blocks

/** mdast node types that can be an editable unit. */
export type UnitKind =
    | "yaml"
    | "toml"
    | "heading"
    | "paragraph"
    | "list"
    | "listItem"
    | "table"
    | "tableCell"
    | "code"
    | "blockquote"
    | "html"
    | "thematicBreak"
    | "definition"
    | "footnoteDefinition";

/**
 * A span of source the UI can edit on its own. Units nest: a root child holds its list items,
 * table cells or blockquote children. Units are not persisted; `hash` lets the UI keep stable
 * keys across reparses.
 */
export interface Unit {
    kind: UnitKind;
    start: Offset;
    end: Offset;
    /** 1-based line of `start`. */
    line: number;
    /** Enclosing heading texts, outermost first. A heading unit includes itself. */
    headingPath: string[];
    /** Hash of `source.slice(start, end)`. */
    hash: string;
    /** Set on table cells; row 0 is the header row. */
    cell?: { row: number; column: number };
    children: Unit[];
}

export interface ParsedDoc {
    source: string;
    units: Unit[];
    bom: boolean;
    /** Dominant line ending, used when new lines are inserted. */
    eol: "\n" | "\r\n";
    finalNewline: boolean;
}

// Anchors

/** W3C text-quote style anchor in source space. `exact` is what `suggest` replaces. */
export interface Anchor {
    exact: string;
    /** Up to 32 source characters before `exact`. */
    prefix: string;
    /** Up to 32 source characters after `exact`. */
    suffix: string;
    /** Last known start offset; a tiebreak, not the truth. */
    hint: Offset;
}

export interface Range {
    start: Offset;
    end: Offset;
}

// Log events. The JSONL log is the only persisted state; everything below it is a fold.

export type EditCause = "user" | "accept" | "apply" | "revert" | "undo";

export type DocSettingKey = "autoApply";

interface EventBase {
    /** Position in the log, 1-based, allocated under the lock. */
    seq: number;
    at: IsoTime;
    by: Author;
    /** Set when `by` is `agent` and the writer knew its identity. */
    agent?: AgentIdentity;
}

export interface CommentEvent extends EventBase {
    type: "comment";
    id: ThreadId;
    /** Absent for a doc note: a thread on the whole doc, never anchored to text. */
    anchor?: Anchor;
    text: string;
    /** True while hold mode is on; `send` opens it. */
    draft: boolean;
    /** Seq of the edit event this asks the agent to follow through on. */
    followsEdit?: number;
}

export interface ReplyEvent extends EventBase {
    type: "reply";
    id: ThreadId;
    text: string;
}

export interface SuggestEvent extends EventBase {
    type: "suggest";
    id: ThreadId;
    replace: string;
    note?: string;
    /** Set when the suggestion creates its thread (`suggest --find`). */
    anchor?: Anchor;
    /** Applied directly (`--apply` or auto-apply). */
    apply: boolean;
}

export interface AcceptEvent extends EventBase {
    type: "accept";
    id: ThreadId;
}

export interface RejectEvent extends EventBase {
    type: "reject";
    id: ThreadId;
    /** With a note the thread reopens and wakes the agent; without, it resolves. */
    note?: string;
}

export interface ResolveEvent extends EventBase {
    type: "resolve";
    id: ThreadId;
}

export interface ReopenEvent extends EventBase {
    type: "reopen";
    id: ThreadId;
}

/** User only. The thread stays in the fold but every view hides it; agent commands are refused. */
export interface DeleteEvent extends EventBase {
    type: "delete";
    id: ThreadId;
}

/** User only. Brings a deleted thread back as it was; its anchor re-resolves as usual. */
export interface UndeleteEvent extends EventBase {
    type: "undelete";
    id: ThreadId;
}

/**
 * User only. Takes back the user's own reply, accept, reject, resolve or reopen `seq` on thread
 * `id` before the agent read it: the fold drops its message and puts the state back.
 */
export interface RetractEvent extends EventBase {
    type: "retract";
    id: ThreadId;
    /** Seq of the event taken back. */
    of: number;
}

/** `before` at `start` became `after`. Anchors are rebased over these in log order. */
export interface SourceSplice {
    start: Offset;
    before: string;
    after: string;
}

/** Every byte change made through `applyEdit`. */
export interface EditEvent extends EventBase, SourceSplice {
    type: "edit";
    cause: EditCause;
    /** With cause `undo`: seq of the edit this one inverts (an undo, or the undo a redo inverts). */
    of?: number;
    line: number;
    headingPath: string[];
    /** Thread the edit came from (accept, apply, revert). */
    id?: ThreadId;
    /** Hash of the doc right after this edit; absent in logs written before it existed. */
    hashAfter?: string;
}

/** The agent took these threads (`pending` returned them or `watch` inlined them). */
export interface ClaimEvent extends EventBase {
    type: "claim";
    ids: ThreadId[];
}

/** The agent has seen every event up to `upTo` on this stream. */
export interface CursorEvent extends EventBase {
    type: "cursor";
    stream: "watch" | "pending";
    upTo: number;
    /**
     * The threads this read named to the agent; empty when it moved the cursor past a batch that
     * printed nothing. Absent in older logs, which are read as having named every thread.
     */
    ids?: ThreadId[];
}

export interface HoldEvent extends EventBase {
    type: "hold";
    on: boolean;
}

/** "Send all": held drafts open. */
export interface SendEvent extends EventBase {
    type: "send";
    ids: ThreadId[];
}

export interface SettingEvent extends EventBase {
    type: "setting";
    key: DocSettingKey;
    value: boolean;
}

/** The file changed on disk outside margin (editor, git). Never in the agent's feed. */
export interface OutsideEvent extends EventBase {
    type: "outside";
    hashBefore: string;
    hashAfter: string;
    /** The change as one splice; absent when over `MAX_OUTSIDE_SPLICE`. */
    edit?: SourceSplice;
}

/**
 * Cap on `before.length + after.length` for a logged outside splice: a checkout or a reformat
 * would bloat the log.
 */
export const MAX_OUTSIDE_SPLICE = 16 * 1024;

/**
 * Anchors re-pinned by quote against the doc whose hash is `hash`, logged by whoever finds the
 * doc changed with no splice to say how (an editor save with no daemon). Anchor hints are
 * positions, so the fold can only move them through splices; this puts them back in step.
 */
export interface ReanchorEvent extends EventBase {
    type: "reanchor";
    hash: string;
    /** Only the threads whose anchor changed. */
    anchors: Partial<Record<ThreadId, Anchor>>;
}

export type Event =
    | CommentEvent
    | ReplyEvent
    | SuggestEvent
    | AcceptEvent
    | RejectEvent
    | ResolveEvent
    | ReopenEvent
    | DeleteEvent
    | UndeleteEvent
    | RetractEvent
    | EditEvent
    | ClaimEvent
    | CursorEvent
    | HoldEvent
    | SendEvent
    | SettingEvent
    | OutsideEvent
    | ReanchorEvent;

export type EventType = Event["type"];

/** An event before the log assigns `seq` and `at`. */
export type EventInput = Event extends infer E
    ? E extends Event
        ? Omit<E, "seq" | "at">
        : never
    : never;

// Threads (a fold of the log)

export type ThreadState = "draft" | "open" | "working" | "replied" | "resolved";

export interface Message {
    seq: number;
    at: IsoTime;
    by: Author;
    agent?: AgentIdentity;
    text: string;
}

export interface Suggestion {
    seq: number;
    by: Author;
    agent?: AgentIdentity;
    replace: string;
    status: "pending" | "accepted" | "rejected";
}

/** An agent edit applied without review; the UI shows "changed by agent" with revert. */
export interface AppliedEdit {
    seq: number;
    start: Offset;
    before: string;
    after: string;
    reverted: boolean;
}

export interface Thread {
    id: ThreadId;
    state: ThreadState;
    /** Absent for a doc note (see `isDocNote`), which no anchor machinery ever sees. */
    anchor?: Anchor;
    /** True only when `anchor.exact` is gone from the source; never for a doc note. */
    detached: boolean;
    createdBy: Author;
    messages: Message[];
    /** Latest suggestion. */
    suggestion?: Suggestion;
    applied?: AppliedEdit;
    claimed: boolean;
    followsEdit?: number;
    /** Time of the last event on this thread; "stalled" is working with none for 10 min. */
    lastActivity: IsoTime;
    /** Time of the last agent cursor that named this thread (an older cursor names every one). */
    notifiedAt?: IsoTime;
}

/** A thread on the whole doc: no quote, never detached, never in the margin rail. */
export function isDocNote(thread: Pick<Thread, "anchor">): boolean {
    return thread.anchor === undefined;
}

// In-memory store behind the UI. The mockup and the server implement it; components use only this.

export interface DocSettings {
    hold: boolean;
    autoApply: boolean;
}

export interface DocSnapshot {
    path: string;
    doc: ParsedDoc;
    threads: Thread[];
    /** Edits the UI marks ("changed by agent", user edits available to follow through). */
    edits: EditEvent[];
    settings: DocSettings;
    /** Last claim or cursor event; drives the "agent listening" chip. */
    agentSeenAt?: IsoTime;
    /** Set after an outside change until the user dismisses it. */
    changedOnDisk?: IsoTime;
    missing: boolean;
    /** Seq of the last event folded in. */
    version: number;
}

export type SaveResult =
    | { ok: true }
    | { ok: false; reason: "conflict"; current: string }
    | { ok: false; reason: "missing" };

export interface DocStore {
    snapshot(): DocSnapshot;
    subscribe(listener: (snapshot: DocSnapshot) => void): () => void;
    /** Without an anchor, a doc note. */
    comment(input: { anchor?: Anchor; text: string }): Promise<ThreadId>;
    /** A user suggestion creates a thread carrying a proposed replacement. */
    suggest(input: { anchor: Anchor; replace: string; text?: string }): Promise<ThreadId>;
    reply(id: ThreadId, text: string): Promise<void>;
    accept(id: ThreadId): Promise<SaveResult>;
    reject(id: ThreadId, note?: string): Promise<void>;
    resolve(id: ThreadId): Promise<void>;
    reopen(id: ThreadId): Promise<void>;
    /** Hides the thread everywhere (a held draft is discarded); `undeleteThread` reverses it. */
    deleteThread(id: ThreadId): Promise<void>;
    undeleteThread(id: ThreadId): Promise<void>;
    revert(id: ThreadId): Promise<SaveResult>;
    /** Compare-and-swap on `before` at `start`. */
    saveUnit(edit: { start: Offset; before: string; after: string }): Promise<SaveResult>;
    followThrough(editSeq: number, text: string): Promise<ThreadId>;
    setHold(on: boolean): Promise<void>;
    sendAll(): Promise<void>;
    setSetting(key: DocSettingKey, value: boolean): Promise<void>;
    dismissChangedOnDisk(): void;
    /** The link to the host behind the store; a store without one (in memory) is always live. */
    status?(): StoreStatus;
    subscribeStatus?(listener: (status: StoreStatus) => void): () => void;
}

/** `reconnecting` is the browser's own retry; `lost` is a stream closed for good, retried by us. */
export type Connection = "live" | "reconnecting" | "lost";

export interface StoreStatus {
    connection: Connection;
    /** The last request the host refused or never answered, until the next one succeeds. */
    problem?: string;
}

// CLI output shapes. Text renderings are what the agent reads; these are the renderers' input.

export type WakeReason = "new" | "reply" | "rejected";

/** One compact line per batch; the agent then reads the threads through `pending`. */
export interface WatchLine {
    form: "compact";
    /** `doc`: every id is a doc note; printed as `doc` where the path would go. */
    groups: { reason: WakeReason; ids: ThreadId[]; path?: string; doc?: true }[];
}

export interface PendingThread {
    id: ThreadId;
    state: ThreadState;
    /** A doc note: no quote or context; `path` is "" and `line` 0. */
    doc?: true;
    path: string;
    line: number;
    detached: boolean;
    quote: string;
    /** Context around the quote, capped and clipped to the unit. */
    before: string;
    after: string;
    /** For a table cell: its column header and the row's first cell. */
    cell?: { header: string; row: string };
    /** Full thread when unclaimed, else only messages after the agent's last one. */
    messages: { by: Author; text: string }[];
    suggestion?: { replace: string; status: Suggestion["status"] };
}

export interface PendingEdit {
    path: string;
    line: number;
    /** Word-diff hunks: changed words with 4 words of context. */
    hunks: string[];
}

export interface PendingJson {
    threads: PendingThread[];
    edits: PendingEdit[];
}

export interface ShowOutput {
    id: ThreadId;
    path: string;
    line: number;
    unit: string;
    thread: Thread;
}

export type AckError =
    | "not-found"
    | "resolved"
    | "detached"
    | "before-missing"
    | "not-unique"
    | "bad-args"
    | "locked"
    | "deleted"
    /** `suggest` on a doc note. */
    | "no-anchor";

export type Ack =
    | { ok: true; id: ThreadId; state: ThreadState }
    | { ok: false; id?: ThreadId; error: AckError; detail?: string };
