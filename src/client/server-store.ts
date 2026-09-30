import { parseDoc } from "../core/blocks.ts";
import type {
    Anchor,
    DocSettingKey,
    DocSnapshot,
    DocStore,
    IsoTime,
    Offset,
    ParsedDoc,
    SaveResult,
    ThreadId,
} from "../core/model.ts";
import {
    SNAPSHOT_EVENT,
    TOKEN_PARAM,
    routes,
    type DocId,
    type ErrorBody,
    type MutationName,
    type MutationResponse,
    type Mutations,
    type OpenFileResponse,
    type OpenUrlResponse,
    type WireSnapshot,
} from "../server/protocol.ts";
import { recall, remember } from "./storage.ts";

/** What the page adds to `DocSnapshot`: presence read by the daemon, not folded from the log. */
export type ClientSnapshot = DocSnapshot & { agentWatching?: boolean };

export type Connection = "live" | "reconnecting" | "lost";

export interface StoreStatus {
    connection: Connection;
    /** The last request the daemon refused or never answered, until the next one succeeds. */
    problem?: string;
}

export interface Transport {
    fetchSnapshot(): Promise<WireSnapshot>;
    post<N extends MutationName>(name: N, body: Mutations[N]["req"]): Promise<MutationResponse<N>>;
    listen(
        onSnapshot: (wire: WireSnapshot) => void,
        onConnection: (connection: Connection) => void,
    ): () => void;
    /** The doc itself without `link`, else a relative link from it; the daemon resolves it. */
    openFile(link?: string): Promise<OpenFileResponse>;
    openUrl(url: string): Promise<OpenUrlResponse>;
}

export class RequestError extends Error {
    constructor(
        readonly status: number,
        readonly body: ErrorBody | null,
    ) {
        super(body?.detail ?? body?.error ?? `request failed (${status})`);
        this.name = "RequestError";
    }
}

/** A lost stream (403 after a daemon restart, or no daemon) is retried at this pace. */
const LOST_RETRY_MS = 3_000;

export function httpTransport(docId: DocId, token: string): Transport {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
        const response = await fetch(path, { ...init, headers });
        if (!response.ok) {
            const body = (await response.json().catch(() => null)) as ErrorBody | null;
            throw new RequestError(response.status, body);
        }
        return (await response.json()) as T;
    };
    return {
        fetchSnapshot: async () => await request<WireSnapshot>(routes.snapshot(docId)),
        post: async (name, body) =>
            await request(routes.mutate(docId, name), {
                method: "POST",
                body: JSON.stringify(body),
            }),
        openFile: async (link) =>
            await request<OpenFileResponse>(routes.openFile(docId), {
                method: "POST",
                body: JSON.stringify(link === undefined ? {} : { link }),
            }),
        openUrl: async (url) =>
            await request<OpenUrlResponse>(routes.openUrl(docId), {
                method: "POST",
                body: JSON.stringify({ url }),
            }),
        listen(onSnapshot, onConnection) {
            let source: EventSource | undefined;
            let retry: ReturnType<typeof setTimeout> | undefined;
            let closed = false;
            const open = () => {
                // EventSource cannot send headers; the daemon accepts the token in the query.
                source = new EventSource(`${routes.events(docId)}?${TOKEN_PARAM}=${token}`);
                source.onopen = () => onConnection("live");
                source.addEventListener(SNAPSHOT_EVENT, (event) => {
                    onSnapshot(JSON.parse((event as MessageEvent<string>).data) as WireSnapshot);
                });
                source.onerror = () => {
                    if (source?.readyState !== EventSource.CLOSED) {
                        onConnection("reconnecting");
                        return;
                    }
                    // Closed for good by the browser (an HTTP error): keep trying ourselves.
                    onConnection("lost");
                    source.close();
                    if (!closed) {
                        retry = setTimeout(open, LOST_RETRY_MS);
                    }
                };
            };
            open();
            return () => {
                closed = true;
                clearTimeout(retry);
                source?.close();
            };
        },
    };
}

const PROBLEM_MS = 5_000;

/** How long a mutation waits for its own change to arrive over the stream before fetching it. */
const SETTLE_MS = 1_500;

interface Waiter {
    version: number;
    done: () => void;
}

/**
 * `DocStore` over the daemon's protocol. Every push is a whole snapshot, so a reconnect needs no
 * replay. A mutation resolves only once a snapshot at or past the version it answered with is in
 * place, so the UI, like the in-memory mockup store, sees its own change when the promise settles
 * and a conflict's "keep mine" or "take theirs" acts on current offsets.
 */
export class ServerStore implements DocStore {
    private wire: WireSnapshot;
    private current: ClientSnapshot;
    private parsed: { hash: string; doc: ParsedDoc };
    private readonly listeners = new Set<(snapshot: DocSnapshot) => void>();
    private readonly statusListeners = new Set<(status: StoreStatus) => void>();
    private waiters: Waiter[] = [];
    private statusValue: StoreStatus = { connection: "live" };
    private dismissed: IsoTime | null;
    private readonly stop: () => void;

    constructor(
        private readonly transport: Transport,
        initial: WireSnapshot,
        private readonly settleMs = SETTLE_MS,
    ) {
        this.wire = initial;
        this.parsed = { hash: initial.hash, doc: parseDoc(initial.source) };
        this.dismissed = recall(dismissKey(initial.docId));
        this.current = this.build();
        this.stop = transport.listen(
            (wire) => this.apply(wire),
            (connection) => this.setStatus({ ...this.statusValue, connection }),
        );
    }

    static async connect(transport: Transport): Promise<ServerStore> {
        return new ServerStore(transport, await transport.fetchSnapshot());
    }

    close(): void {
        this.stop();
    }

    snapshot(): ClientSnapshot {
        return this.current;
    }

    subscribe(listener: (snapshot: DocSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    status(): StoreStatus {
        return this.statusValue;
    }

    /** A host action (opening a file or link) that failed; shown for a few seconds. */
    reportProblem(problem: string): void {
        this.setStatus({ ...this.statusValue, problem });
        setTimeout(() => {
            if (this.statusValue.problem === problem) {
                this.setStatus({ connection: this.statusValue.connection });
            }
        }, PROBLEM_MS);
    }

    subscribeStatus(listener: (status: StoreStatus) => void): () => void {
        this.statusListeners.add(listener);
        return () => {
            this.statusListeners.delete(listener);
        };
    }

    async comment(input: { anchor: Anchor; text: string }): Promise<ThreadId> {
        return (await this.call("comment", input)).id;
    }

    async suggest(input: { anchor: Anchor; replace: string; text?: string }): Promise<ThreadId> {
        return (await this.call("suggest", input)).id;
    }

    async reply(id: ThreadId, text: string): Promise<void> {
        await this.call("reply", { id, text });
    }

    async accept(id: ThreadId): Promise<SaveResult> {
        return saveResult(await this.call("accept", { id }));
    }

    async reject(id: ThreadId, note?: string): Promise<void> {
        await this.call("reject", note === undefined ? { id } : { id, note });
    }

    async resolve(id: ThreadId): Promise<void> {
        await this.call("resolve", { id });
    }

    async reopen(id: ThreadId): Promise<void> {
        await this.call("reopen", { id });
    }

    async revert(id: ThreadId): Promise<SaveResult> {
        return saveResult(await this.call("revert", { id }));
    }

    /**
     * Sends the version of the snapshot the offsets came from, so the daemon moves `start` through
     * anything logged since. The editor passes it along (`DocStore` has no field for it); without
     * one, the newest snapshot's is the best guess.
     */
    async saveUnit(edit: {
        start: Offset;
        before: string;
        after: string;
        version?: number;
        strict?: boolean;
    }): Promise<SaveResult & { version?: number; at?: Offset }> {
        const { version = this.current.version, ...splice } = edit;
        // Keeps `version` and `at`: a Keep mine record needs both to Restore later.
        return await this.call("save", { ...splice, version });
    }

    async followThrough(editSeq: number, text: string): Promise<ThreadId> {
        return (await this.call("follow-through", { editSeq, text })).id;
    }

    async setHold(on: boolean): Promise<void> {
        await this.call("hold", { on });
    }

    async sendAll(): Promise<void> {
        await this.call("send-all", {});
    }

    async setSetting(key: DocSettingKey, value: boolean, id?: ThreadId): Promise<void> {
        await this.call("setting", id === undefined ? { key, value } : { key, value, id });
    }

    /** Per viewer: the banner stays dismissed for this outside change, across reloads. */
    dismissChangedOnDisk(): void {
        this.dismissed = this.wire.changedOnDisk ?? null;
        remember(dismissKey(this.wire.docId), this.dismissed);
        this.publish();
    }

    private async call<N extends MutationName>(
        name: N,
        body: Mutations[N]["req"],
    ): Promise<MutationResponse<N>> {
        let response: MutationResponse<N>;
        try {
            response = await this.transport.post(name, body);
        } catch (caught) {
            this.setStatus({ ...this.statusValue, problem: describe(caught) });
            throw caught;
        }
        if (this.statusValue.problem) {
            this.setStatus({ connection: this.statusValue.connection });
        }
        await this.settle(response.version);
        return response;
    }

    private async settle(version: number): Promise<void> {
        if (this.wire.version >= version) {
            return;
        }
        const reached = new Promise<void>((done) => this.waiters.push({ version, done }));
        const timer = setTimeout(() => void this.refetch(), this.settleMs);
        await reached;
        clearTimeout(timer);
    }

    private async refetch(): Promise<void> {
        try {
            this.apply(await this.transport.fetchSnapshot());
        } catch (caught) {
            this.setStatus({ ...this.statusValue, problem: describe(caught) });
            // Never strand a waiting mutation: it already succeeded on the daemon.
            this.release(Infinity);
        }
    }

    private apply(wire: WireSnapshot): void {
        // A fallback fetch can race the stream; an older snapshot never replaces a newer one.
        if (wire.version < this.wire.version) {
            return;
        }
        this.wire = wire;
        if (wire.hash !== this.parsed.hash) {
            this.parsed = { hash: wire.hash, doc: parseDoc(wire.source) };
        }
        this.publish();
        this.release(wire.version);
    }

    private release(version: number): void {
        const ready = this.waiters.filter((waiter) => waiter.version <= version);
        this.waiters = this.waiters.filter((waiter) => waiter.version > version);
        for (const waiter of ready) {
            waiter.done();
        }
    }

    private publish(): void {
        this.current = this.build();
        for (const listener of this.listeners) {
            listener(this.current);
        }
    }

    private build(): ClientSnapshot {
        const { wire } = this;
        return {
            path: wire.path,
            doc: this.parsed.doc,
            threads: wire.threads,
            edits: wire.edits,
            settings: wire.settings,
            agentSeenAt: wire.agentSeenAt,
            changedOnDisk:
                wire.changedOnDisk && wire.changedOnDisk !== this.dismissed
                    ? wire.changedOnDisk
                    : undefined,
            missing: wire.missing,
            version: wire.version,
            agentWatching: wire.agentWatching,
        };
    }

    private setStatus(status: StoreStatus): void {
        this.statusValue = status;
        for (const listener of this.statusListeners) {
            listener(status);
        }
    }
}

function saveResult(response: SaveResult & { version: number }): SaveResult {
    const { version: _, ...result } = response;
    return result as SaveResult;
}

function describe(caught: unknown): string {
    if (caught instanceof RequestError) {
        return caught.status === 403
            ? "The margin daemon no longer accepts this page. Run margin on the file again."
            : `The change was not saved (${caught.message}).`;
    }
    return "Could not reach the margin daemon. The change was not saved.";
}

function dismissKey(docId: DocId): string {
    return `margin:disk-dismissed:${docId}`;
}
