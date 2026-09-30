// Wire protocol between the daemon and the browser tab. Types and constants only, no runtime
// imports, so the client bundle can import it.
//
// Mutations are plain HTTP (POST, JSON in and out). Updates come back over one server-sent
// events stream per tab: push is one-way, SSE resumes on its own, and every message is a full
// snapshot, so a reconnect never has to replay a gap.

import type {
    Anchor,
    DocSettingKey,
    DocSettings,
    EditEvent,
    IsoTime,
    Offset,
    SaveResult,
    Thread,
    ThreadId,
} from "../core/model.ts";

/** Bumped on any incompatible wire change; a CLI refuses a daemon that speaks another. */
export const PROTOCOL_VERSION = 1;

/**
 * The per-daemon token. Pages get it in the tab URL query (`?t=`), then send it as
 * `Authorization: Bearer <token>`; the query form is accepted too, for `<img>` and `EventSource`.
 */
export const TOKEN_PARAM = "t";
export const TOKEN_META = "margin-token";
export const DOC_META = "margin-doc";

/** Short id for a registered doc: stable per real path. */
export type DocId = string;

export const routes = {
    page: (docId: DocId) => `/d/${docId}`,
    /** An image beside the doc: `path` is relative to the doc's directory. */
    asset: (docId: DocId, path: string) =>
        `/d/${docId}/asset/${path.split("/").map(encodeURIComponent).join("/")}`,
    snapshot: (docId: DocId) => `/api/docs/${docId}/snapshot`,
    events: (docId: DocId) => `/api/docs/${docId}/events`,
    mutate: (docId: DocId, action: MutationName) => `/api/docs/${docId}/${action}`,
    /** POST `OpenFileRequest`: the daemon opens the doc, or a file it links to, in a file tab. */
    openFile: (docId: DocId) => `/api/docs/${docId}/open-file`,
    /** POST `OpenUrlRequest`: an http(s) link, for Orca's browser, which blocks popups. */
    openUrl: (docId: DocId) => `/api/docs/${docId}/open-url`,
    register: "/api/register",
    status: "/api/status",
    stop: "/api/stop",
} as const;

/**
 * What a tab renders. `source` is the whole doc; the client parses it (the same `parseDoc`), which
 * is cheaper to ship than units. `detached` is computed against `source`.
 */
export interface WireSnapshot {
    docId: DocId;
    path: string;
    source: string;
    hash: string;
    threads: Thread[];
    edits: EditEvent[];
    settings: DocSettings;
    agentSeenAt?: IsoTime;
    changedOnDisk?: IsoTime;
    /** The file is gone; `source` is the last one seen. */
    missing: boolean;
    /** Seq of the last log event folded in. Send it back with saves. */
    version: number;
    /**
     * A `margin watch` or `pending --wait` is running on this doc now (its presence file names a
     * live pid). Set by the daemon on every push; absent only from a bare session snapshot.
     */
    agentWatching?: boolean;
}

/** Id of the page's `application/json` script element holding `PageBoot`. */
export const BOOT_ELEMENT = "margin-boot";

/** What the page shell hands the client besides the token meta. */
export interface PageBoot {
    docId: DocId;
    /** Absolute path on disk. */
    path: string;
    /** Relative to the doc's git repository root, else just the file name. */
    relativePath: string;
}

/** SSE event name for a `WireSnapshot` payload; the SSE `id` is its `version`. */
export const SNAPSHOT_EVENT = "snapshot";

/**
 * Compare-and-swap save of one unit. With `version` (the snapshot the edit started from), the
 * server moves `start` through every splice logged since then and saves only if `before` is
 * exactly there. Without it, `before` must sit exactly at `start`. It never searches elsewhere:
 * a short cell text could match the wrong cell.
 */
export interface SaveRequest {
    start: Offset;
    before: string;
    after: string;
    version?: number;
    /**
     * Refuse if anything since `version` so much as touched `[start, start + before.length]`: an
     * insertion right at either end counts. Restore uses it, since its text is only valid while
     * nothing has been added next to it.
     */
    strict?: boolean;
}

export interface Mutations {
    comment: { req: { anchor: Anchor; text: string }; res: { id: ThreadId } };
    suggest: { req: { anchor: Anchor; replace: string; text?: string }; res: { id: ThreadId } };
    reply: { req: { id: ThreadId; text: string }; res: Ok };
    accept: { req: { id: ThreadId }; res: SaveResult };
    reject: { req: { id: ThreadId; note?: string }; res: Ok };
    resolve: { req: { id: ThreadId }; res: Ok };
    reopen: { req: { id: ThreadId }; res: Ok };
    revert: { req: { id: ThreadId }; res: SaveResult };
    /** `at`: where the text landed, in the doc as of the response's `version`. */
    save: { req: SaveRequest; res: SaveResult & { at?: Offset } };
    "follow-through": { req: { editSeq: number; text: string }; res: { id: ThreadId } };
    hold: { req: { on: boolean }; res: Ok };
    "send-all": { req: Record<string, never>; res: Ok };
    setting: { req: { key: DocSettingKey; value: boolean; id?: ThreadId }; res: Ok };
}

export type MutationName = keyof Mutations;

/**
 * Every mutation answers with its result plus the log version right after it, so a client can
 * send its next save against that version without waiting for the snapshot push.
 */
export type MutationResponse<N extends MutationName> = Mutations[N]["res"] & { version: number };

export const MUTATIONS: readonly MutationName[] = [
    "comment",
    "suggest",
    "reply",
    "accept",
    "reject",
    "resolve",
    "reopen",
    "revert",
    "save",
    "follow-through",
    "hold",
    "send-all",
    "setting",
];

export interface Ok {
    ok: true;
}

/** Body of any 4xx/5xx JSON response. */
export interface ErrorBody {
    error: WireError;
    detail?: string;
}

export type WireError =
    | "forbidden"
    /** open-file: the link leads outside the repository, to a directory, or to a type not on the allow-list. */
    | "not-openable"
    | "not-found"
    | "bad-request"
    | "bad-anchor"
    | "resolved"
    | "no-suggestion"
    | "locked"
    | "missing"
    | "internal";

/**
 * Without `link`, the doc itself. With it, a relative link from the doc; only a file inside the
 * doc's repository (or directory) opens. The daemon never takes a path from the page.
 */
export interface OpenFileRequest {
    link?: string;
}

export interface OpenFileResponse {
    opened: "orca" | "system" | "none";
}

export interface OpenUrlRequest {
    url: string;
}

export interface OpenUrlResponse {
    opened: "orca" | "browser" | "none";
}

export interface RegisterRequest {
    path: string;
}

export interface RegisterResponse {
    docId: DocId;
    /** Tab URL, token included. */
    url: string;
}

export interface DaemonStatus {
    pid: number;
    port: number;
    protocol: number;
    startedAt: IsoTime;
    docs: { docId: DocId; path: string; clients: number; missing: boolean }[];
}
