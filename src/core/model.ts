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

const VERDICT_STATES = ["open", "approved", "declined"] as const;

/** A doc's review status. `open` is the default and what a reopen returns to. */
export type VerdictState = (typeof VERDICT_STATES)[number];

/**
 * User only: the agent CLI has no command that writes one. Sets the doc's status; any state may
 * follow any other. An approval is only logged with no unresolved thread left (see
 * `isUnresolved`), so "approve as is" names the threads it closes in `closed` and the fold
 * resolves them: no per-thread events, nothing to retract, no wake for them. Edits never clear a
 * verdict; `hash` is how a reader tells the doc changed since.
 */
export interface VerdictEvent extends EventBase {
    type: "verdict";
    state: VerdictState;
    /** `hashText` of the doc source when the verdict was given. */
    hash: string;
    /** One line from the user to the agent. */
    note?: string;
    /** Threads closed without action by "approve as is"; a pending suggestion on one is rejected. */
    closed?: ThreadId[];
}

/**
 * User only. A request, not a verdict: the user asks the agent to settle what is left. `ids` are
 * the threads handed over, every one unresolved once margin had accepted the pending agent
 * suggestions and sent the held drafts; the fold sets them to `open` so `pending` returns them.
 * A doc that was approved or declined is open again.
 */
export interface FinishEvent extends EventBase {
    type: "finish";
    ids: ThreadId[];
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
    | ReanchorEvent
    | VerdictEvent
    | FinishEvent;

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

/** Still counts against an approval: every state but `resolved`, detached threads included. */
export function isUnresolved(thread: Pick<Thread, "state">): boolean {
    return thread.state !== "resolved";
}

/**
 * A log or a request may carry a state this version does not know. Readers treat such a verdict
 * as absent rather than store a status nothing can show.
 */
export function isVerdictState(value: unknown): value is VerdictState {
    return (VERDICT_STATES as readonly unknown[]).includes(value);
}

/**
 * The doc's status as folded from the log. Absent until the first verdict, which reads as open.
 * The user's own thread activity after an approval or a decline (a comment, held or not, a reply, a
 * suggestion, a reject with a note, a thread reopened, undeleted or brought back by a retract, a
 * finish request) puts the doc back to `open` with no verdict event; agent events never do.
 */
export interface DocVerdict {
    state: VerdictState;
    /**
     * Seq of the event that set `state`: the verdict event, or the user event that reopened the
     * doc. An `open` verdict whose seq is past an agent cursor is a reopen that agent has not
     * heard of yet.
     */
    seq: number;
    at: IsoTime;
    /**
     * The doc hash at the verdict; the doc changed since when the current hash differs. Absent
     * after an automatic reopen, which no verdict event recorded.
     */
    hash?: string;
    note?: string;
    /** The threads an "approve as is" closed. */
    closed?: ThreadId[];
}

/**
 * The last finish request, kept until the next verdict. It is outstanding while any of `ids` is
 * still unresolved (and not deleted); once none is, the agent is done and the user can approve.
 */
export interface FinishRequest {
    seq: number;
    at: IsoTime;
    ids: ThreadId[];
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
    /** Absent until the first verdict: the doc is open. */
    verdict?: DocVerdict;
    /** The last finish request since the last verdict, outstanding or done. */
    finish?: FinishRequest;
}

/** An approval is refused while threads are unresolved; `ids` are those threads. */
export type VerdictResult = { ok: true } | { ok: false; reason: "unresolved"; ids: ThreadId[] };

export interface FinishResult {
    /** The threads handed to the agent; empty when nothing was left, and then nothing is logged. */
    ids: ThreadId[];
    /** Among `ids`: pending agent suggestions that no longer apply, left pending. */
    unapplied: ThreadId[];
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
    /**
     * `approved` is refused while threads are unresolved, unless `asIs`: then the store closes
     * every one of them with the verdict, applying no suggestion. `declined` leaves threads alone;
     * `open` reopens, and does nothing on a doc that is already open. Never on the undo stack.
     */
    setVerdict(input: {
        state: VerdictState;
        note?: string;
        asIs?: boolean;
    }): Promise<VerdictResult>;
    /**
     * Asks the agent to finish: accepts every pending agent suggestion that still applies, sends
     * held drafts, and hands each thread still unresolved to the agent. The doc stays (or goes
     * back to) open; the user approves after.
     */
    requestFinish(): Promise<FinishResult>;
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

/**
 * `new`, `reply`, `rejected` and `finish` are about threads. `approved`, `declined` and `reopened`
 * are about the doc: the verdict the user gave, or the doc going back to open.
 */
export type WakeReason =
    "new" | "reply" | "rejected" | "approved" | "declined" | "reopened" | "finish";

/** One compact line per batch; the agent then reads the threads through `pending`. */
export interface WatchLine {
    form: "compact";
    /**
     * `doc`: every id is a doc note; printed as `doc` where the path would go. A group for a
     * doc-level reason (`approved`, `declined`, `reopened`) has empty `ids` and neither `path` nor
     * `doc`; `finish` lists the threads handed over.
     */
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

/**
 * The header line of `pending`: what a session starting fresh needs to know about the doc.
 * Every field is left out when it has nothing to say.
 */
export interface PendingReview {
    /** The standing verdict; absent while the doc is open. */
    verdict?: "approved" | "declined";
    /** With `verdict`: the doc hash differs from the one the verdict recorded. */
    changed?: true;
    /** With `verdict`: the user's note. */
    note?: string;
    /** A finish request is outstanding: settle every thread, ask nothing, then stop. */
    finish?: true;
    /** The doc went back to open past the pending cursor; reported once. */
    reopened?: true;
}

export interface PendingJson {
    threads: PendingThread[];
    edits: PendingEdit[];
    /** Absent when the doc is open with no finish request and no reopen to report. */
    review?: PendingReview;
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
