import {
    BOOT_ELEMENT,
    STORED_CHANGE_MAX,
    STORED_KEY_MAX,
    STORED_VALUE_MAX,
    TOKEN_META,
    routes,
    type PageBoot,
    type StoredChange,
} from "../server/protocol.ts";

/** Resolves true once the daemon has the change, false (or rejects) to have it sent again. */
export type SendChange = (change: StoredChange) => Promise<boolean>;

const SEND_DELAY_MS = 300;
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Failed sends in a row before the keys wait for the next write or the tab closing. */
const RETRY_LIMIT = 8;
/** Browsers refuse a keepalive request once the bodies in flight pass 64 KiB. */
const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * The daemon's store, read from the values that came with the page so `recall` never waits.
 * Writes land in memory at once and go to the daemon a moment later, one request at a time so
 * two writes to a key arrive in order. A change the daemon did not take stays pending and is
 * sent again, a little later each time.
 */
export class DaemonStorage {
    private readonly values: Map<string, string>;
    private readonly pending = new Map<string, string | null>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private sending = false;
    private failures = 0;

    constructor(
        stored: Record<string, string>,
        private readonly send: SendChange,
        private readonly delayMs = SEND_DELAY_MS,
        private readonly retryMs = RETRY_MS,
    ) {
        this.values = new Map(Object.entries(stored));
    }

    recall(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    remember(key: string, value: string | null): void {
        if (this.recall(key) === value) {
            return;
        }
        if (value === null) {
            this.values.delete(key);
        } else {
            this.values.set(key, value);
        }
        // The daemon would refuse it, so it is never sent: it lasts as long as the tab, and the
        // daemon keeps what it last had for the key (a shorter draft beats none).
        if (key.length > STORED_KEY_MAX || (value?.length ?? 0) > STORED_VALUE_MAX) {
            return;
        }
        this.pending.set(key, value);
        this.arm(this.delayMs);
    }

    private arm(ms: number): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.flush(), ms);
    }

    /**
     * `closing`: the tab is going away, so what is pending goes now even past a request in
     * flight.
     */
    async flush(closing = false): Promise<void> {
        clearTimeout(this.timer);
        if (this.pending.size === 0 || (this.sending && !closing)) {
            return;
        }
        const batch = new Map([...this.pending].slice(0, STORED_CHANGE_MAX));
        for (const key of batch.keys()) {
            this.pending.delete(key);
        }
        const change: Required<StoredChange> = { set: {}, delete: [] };
        for (const [key, value] of batch) {
            if (value === null) {
                change.delete.push(key);
            } else {
                change.set[key] = value;
            }
        }
        this.sending = true;
        let taken = false;
        try {
            taken = await this.send(change);
        } catch {
            // The daemon is out of reach; the keys wait.
        }
        this.sending = false;
        if (!taken) {
            for (const [key, value] of batch) {
                if (!this.pending.has(key)) {
                    this.pending.set(key, value);
                }
            }
            this.failures += 1;
            if (this.failures <= RETRY_LIMIT) {
                this.arm(Math.min(this.retryMs * 2 ** (this.failures - 1), RETRY_MAX_MS));
            }
            return;
        }
        this.failures = 0;
        await this.flush();
    }
}

export function httpSend(docId: string, token: string): SendChange {
    return async (change) => {
        const body = JSON.stringify(change);
        const response = await fetch(routes.stored(docId), {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body,
            // So a write still in flight when the tab closes reaches the daemon.
            keepalive: new Blob([body]).size <= KEEPALIVE_MAX_BYTES,
        });
        // Anything else leaves the keys pending: no answer here means the daemon has them.
        return response.ok;
    };
}

/** Null without `stored`: an older daemon, or one with nowhere to keep it. */
export function daemonStorage(boot: PageBoot | null, send: SendChange): DaemonStorage | null {
    return boot?.stored ? new DaemonStorage(boot.stored, send) : null;
}

function fromPage(): DaemonStorage | null {
    // The mockup has no boot element, and tests no document.
    const element = typeof document === "undefined" ? null : document.getElementById(BOOT_ELEMENT);
    if (!element) {
        return null;
    }
    try {
        const boot = JSON.parse(element.textContent ?? "null") as PageBoot | null;
        const token =
            document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content ?? "";
        const storage = daemonStorage(boot, httpSend(boot?.docId ?? "", token));
        if (storage) {
            window.addEventListener("pagehide", () => void storage.flush(true));
        }
        return storage;
    } catch {
        return null;
    }
}

let page: DaemonStorage | null | undefined;

/** Looked up on first use, which main.tsx makes before the first paint. */
function daemon(): DaemonStorage | null {
    if (page === undefined) {
        page = fromPage();
    }
    return page;
}

/**
 * What the page stored before: with the daemon when it sent the values along with the page,
 * else in localStorage, which can be blocked (private windows, some file:// contexts) and then
 * holds nothing.
 */
export function recall(key: string): string | null {
    const storage = daemon();
    if (storage) {
        return storage.recall(key);
    }
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function remember(key: string, value: string | null): void {
    const storage = daemon();
    if (storage) {
        storage.remember(key, value);
        return;
    }
    try {
        if (value === null) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, value);
        }
    } catch {
        // Nothing to do: the value lasts until reload.
    }
}
