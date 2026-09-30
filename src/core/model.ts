// Shared types for every module. Frozen after W0: changes go through the foreman.

/**
 * An index into the document source, counted in UTF-16 code units of the string produced by
 * `decodeSource` (fatal UTF-8, BOM kept), so a BOM sits at index 0. Ranges are half-open.
 */
export type Offset = number;

export type IsoTime = string;

export type Author = "user" | "agent";

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

export type EditCause = "user" | "accept" | "apply" | "revert";

export type DocSettingKey = "suggestionsOnly" | "autoApply";

interface EventBase {
    /** Position in the log, 1-based, allocated under the lock. */
    seq: number;
    at: IsoTime;
    by: Author;
}

export interface CommentEvent extends EventBase {
    type: "comment";
    id: ThreadId;
    anchor: Anchor;
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
    /** `--apply` was asked for but the doc is suggestions only. */
    downgraded: boolean;
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
    /** Per-thread auto-apply; absent means the whole doc. */
    id?: ThreadId;
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
    text: string;
}

export interface Suggestion {
    seq: number;
    by: Author;
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
    anchor: Anchor;
    /** True only when `anchor.exact` is gone from the source. */
    detached: boolean;
    createdBy: Author;
    messages: Message[];
    /** Latest suggestion. */
    suggestion?: Suggestion;
    applied?: AppliedEdit;
    claimed: boolean;
    autoApply: boolean;
    followsEdit?: number;
    /** Time of the last event on this thread; "stalled" is working with none for 10 min. */
    lastActivity: IsoTime;
}

// In-memory store behind the UI. The mockup and the server implement it; components use only this.

export interface DocSettings {
    hold: boolean;
    suggestionsOnly: boolean;
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
    comment(input: { anchor: Anchor; text: string }): Promise<ThreadId>;
    /** A user suggestion creates a thread carrying a proposed replacement. */
    suggest(input: { anchor: Anchor; replace: string; text?: string }): Promise<ThreadId>;
    reply(id: ThreadId, text: string): Promise<void>;
    accept(id: ThreadId): Promise<SaveResult>;
    reject(id: ThreadId, note?: string): Promise<void>;
    resolve(id: ThreadId): Promise<void>;
    reopen(id: ThreadId): Promise<void>;
    revert(id: ThreadId): Promise<SaveResult>;
    /** Compare-and-swap on `before` at `start`. */
    saveUnit(edit: { start: Offset; before: string; after: string }): Promise<SaveResult>;
    followThrough(editSeq: number, text: string): Promise<ThreadId>;
    setHold(on: boolean): Promise<void>;
    sendAll(): Promise<void>;
    setSetting(key: DocSettingKey, value: boolean, id?: ThreadId): Promise<void>;
    dismissChangedOnDisk(): void;
}

// CLI output shapes. Text renderings are what the agent reads; these are the renderers' input.

export type WakeReason = "new" | "reply" | "rejected";

/** One compact line per batch; the agent then reads the threads through `pending`. */
export interface WatchLine {
    form: "compact";
    groups: { reason: WakeReason; ids: ThreadId[]; path?: string }[];
}

export interface PendingThread {
    id: ThreadId;
    state: ThreadState;
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
    "not-found" | "resolved" | "detached" | "before-missing" | "not-unique" | "bad-args" | "locked";

export type Ack =
    | { ok: true; id: ThreadId; state: ThreadState; downgraded?: boolean }
    | { ok: false; id?: ThreadId; error: AckError; detail?: string };
