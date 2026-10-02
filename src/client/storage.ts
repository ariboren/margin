import {
    BOOT_ELEMENT,
    TOKEN_META,
    routes,
    type PageBoot,
    type StoredChange,
} from "../server/protocol.ts";

/** Resolves true once the daemon has the change or refused it for good, false to try it again. */
export type SendChange = (change: StoredChange) => Promise<boolean>;

const SEND_DELAY_MS = 300;
/** Browsers refuse a keepalive request once the bodies in flight pass 64 KiB. */
const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * The daemon's store, read from the values that came with the page so `recall` never waits.
 * Writes land in memory at once and go to the daemon a moment later, one request at a time so
 * two writes to a key arrive in order.
 */
export class DaemonStorage {
    private readonly values: Map<string, string>;
    private readonly pending = new Map<string, string | null>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private sending = false;

    constructor(
        stored: Record<string, string>,
        private readonly send: SendChange,
        private readonly delayMs = SEND_DELAY_MS,
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
        this.pending.set(key, value);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.flush(), this.delayMs);
    }

    /**
     * `closing`: the tab is going away, so what is pending goes now even past a request in
     * flight. A change the daemon did not take stays pending and goes with the next one.
     */
    async flush(closing = false): Promise<void> {
        clearTimeout(this.timer);
        if (this.pending.size === 0 || (this.sending && !closing)) {
            return;
        }
        const batch = new Map(this.pending);
        this.pending.clear();
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
            return;
        }
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
        // A refusal will not change on a retry; only a daemon that failed gets the keys again.
        return response.status < 500;
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
    page ??= fromPage();
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
