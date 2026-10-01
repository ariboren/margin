import { parseDoc } from "../core/blocks.ts";
import type {
    AgentIdentity,
    Anchor,
    Connection,
    DocSettingKey,
    DocSnapshot,
    DocStore,
    IsoTime,
    Offset,
    ParsedDoc,
    SaveResult,
    StoreStatus,
    ThreadId,
} from "../core/model.ts";
import {
    DEV_EVENT,
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
    type RetractResult,
    type Seq,
    type WireSnapshot,
} from "../server/protocol.ts";
import { recall, remember } from "./storage.ts";
import type { ThreadActions } from "./undo.ts";

/** What the page adds to `DocSnapshot`: presence read by the daemon, not folded from the log. */
/** The daemon's snapshot plus its presence reading; absent in a store with no daemon. */
export type ClientSnapshot = DocSnapshot & { agents?: AgentIdentity[] };

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

/** Fired on `window` just before a dev reload, so the page can keep its place. */
export const DEV_RELOAD_EVENT = "margin:dev-reload";

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
            let devStamp: string | undefined;
            const open = () => {
                // EventSource cannot send headers; the daemon accepts the token in the query.
                source = new EventSource(`${routes.events(docId)}?${TOKEN_PARAM}=${token}`);
                source.onopen = () => onConnection("live");
                source.addEventListener(SNAPSHOT_EVENT, (event) => {
                    onSnapshot(JSON.parse((event as MessageEvent<string>).data) as WireSnapshot);
                });
                source.addEventListener(DEV_EVENT, (event) => {
                    const stamp = (event as MessageEvent<string>).data;
                    if (devStamp !== undefined && stamp !== devStamp) {
                        window.dispatchEvent(new Event(DEV_RELOAD_EVENT));
                        location.reload();
                    }
                    devStamp = stamp;
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

    /** The thread actions with the seq of the event each appended, which the undo stack records. */
    readonly actions: ThreadActions = {
        reply: async (id, text) => unversioned(await this.call("reply", { id, text })),
        reject: async (id, note) =>
            unversioned(await this.call("reject", note === undefined ? { id } : { id, note })),
        resolve: async (id) => unversioned(await this.call("resolve", { id })),
        reopen: async (id) => unversioned(await this.call("reopen", { id })),
    };

    async reply(id: ThreadId, text: string): Promise<void> {
        await this.actions.reply(id, text);
    }

    async accept(id: ThreadId): Promise<SaveResult & Partial<Seq>> {
        return unversioned(await this.call("accept", { id }));
    }

    async reject(id: ThreadId, note?: string): Promise<void> {
        await this.actions.reject(id, note);
    }

    async resolve(id: ThreadId): Promise<void> {
        await this.actions.resolve(id);
    }

    async reopen(id: ThreadId): Promise<void> {
        await this.actions.reopen(id);
    }

    /** Takes back the user's own event `seq` on `id`; refused once the agent has read it. */
    async retract(id: ThreadId, seq: number): Promise<RetractResult> {
        return unversioned(await this.call("retract", { id, seq }));
    }

    async deleteThread(id: ThreadId): Promise<void> {
        await this.call("delete", { id });
    }

    async undeleteThread(id: ThreadId): Promise<void> {
        await this.call("undelete", { id });
    }

    async revert(id: ThreadId): Promise<SaveResult> {
        return unversioned(await this.call("revert", { id }));
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

    async setSetting(key: DocSettingKey, value: boolean): Promise<void> {
        await this.call("setting", { key, value });
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
            agents: wire.agents,
        };
    }

    private setStatus(status: StoreStatus): void {
        this.statusValue = status;
        for (const listener of this.statusListeners) {
            listener(status);
        }
    }
}

function unversioned<T extends object>(response: T & { version: number }): T {
    const { version: _, ...result } = response;
    return result as T;
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
