// What the page keeps on the device: view settings and theme once, drafts and markers per doc.
// Browser storage cannot hold it, since every daemon start is a new port and so a new origin.
import { closeSync, fchmodSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { DEVICE_KEYS, type DocId, type StoredChange } from "./protocol.ts";

export const KEY_MAX = 1024;
/** In UTF-16 units, like every other length here. */
export const VALUE_MAX = 60 * 1024;
export const CHANGE_MAX = 200;
export const TOTAL_MAX = 4 * 1024 * 1024;
/** A doc nothing was stored for in this long loses its entries: drafts nobody came back to. */
export const DOC_KEEP_MS = 60 * 24 * 60 * 60 * 1000;

const KEY_PREFIX = "margin:";
const DEVICE: ReadonlySet<string> = new Set(Object.values(DEVICE_KEYS));

interface Entry {
    v: string;
    /** When it was set, in ms; what eviction orders by. */
    at: number;
}

type Bucket = Record<string, Entry>;

interface StoreFile {
    device: Bucket;
    docs: Record<DocId, Bucket>;
}

export interface PageStore {
    /** The device's values plus this doc's. */
    read(docId: DocId): Record<string, string>;
    apply(docId: DocId, change: StoredChange): void;
}

export interface PageStoreOptions {
    now?: () => number;
    totalMax?: number;
    /** Told about a file that exists and cannot be used; the store carries on as if empty. */
    onCorrupt?: (caught: unknown) => void;
}

function validKey(key: string): boolean {
    return (
        key.startsWith(KEY_PREFIX) &&
        key.length <= KEY_MAX &&
        // Keys carry file paths, so anything printable goes; a control character never does.
        !/[\u0000-\u001f\u007f]/.test(key)
    );
}

/** The change a request body asks for, or null when any part of it is off. */
export function parseChange(body: unknown): StoredChange | null {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return null;
    }
    const { set = {}, delete: remove = [] } = body as { set?: unknown; delete?: unknown };
    if (typeof set !== "object" || set === null || Array.isArray(set) || !Array.isArray(remove)) {
        return null;
    }
    const entries = Object.entries(set as Record<string, unknown>);
    if (entries.length + remove.length > CHANGE_MAX) {
        return null;
    }
    const values: Record<string, string> = {};
    for (const [key, value] of entries) {
        if (!validKey(key) || typeof value !== "string" || value.length > VALUE_MAX) {
            return null;
        }
        values[key] = value;
    }
    const keys: string[] = [];
    for (const key of remove) {
        if (typeof key !== "string" || !validKey(key)) {
            return null;
        }
        keys.push(key);
    }
    return { set: values, delete: keys };
}

function readBucket(raw: unknown): Bucket {
    const bucket: Bucket = {};
    if (typeof raw !== "object" || raw === null) {
        return bucket;
    }
    for (const [key, entry] of Object.entries(raw as Record<string, Partial<Entry> | null>)) {
        if (typeof entry?.v === "string" && typeof entry.at === "number") {
            bucket[key] = { v: entry.v, at: entry.at };
        }
    }
    return bucket;
}

function load(path: string, onCorrupt?: (caught: unknown) => void): StoreFile {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code !== "ENOENT") {
            onCorrupt?.(caught);
        }
        return { device: {}, docs: {} };
    }
    try {
        const raw = JSON.parse(text) as { device?: unknown; docs?: unknown } | null;
        const docs: Record<DocId, Bucket> = {};
        if (typeof raw?.docs === "object" && raw.docs !== null) {
            for (const [docId, bucket] of Object.entries(raw.docs)) {
                docs[docId] = readBucket(bucket);
            }
        }
        return { device: readBucket(raw?.device), docs };
    } catch (caught) {
        onCorrupt?.(caught);
        return { device: {}, docs: {} };
    }
}

/** Drops docs gone quiet, then the oldest doc entries until the file fits. Settings always stay. */
function prune(file: StoreFile, now: number, totalMax: number): void {
    for (const [docId, bucket] of Object.entries(file.docs)) {
        const ages = Object.values(bucket).map((entry) => entry.at);
        if (ages.length === 0 || Math.max(...ages) < now - DOC_KEEP_MS) {
            delete file.docs[docId];
        }
    }
    let size = JSON.stringify(file).length;
    if (size <= totalMax) {
        return;
    }
    const oldest = Object.entries(file.docs)
        .flatMap(([docId, bucket]) =>
            Object.entries(bucket).map(([key, entry]) => ({ docId, key, entry })),
        )
        .sort((a, b) => a.entry.at - b.entry.at);
    for (const { docId, key, entry } of oldest) {
        if (size <= totalMax) {
            break;
        }
        const bucket = file.docs[docId]!;
        delete bucket[key];
        size -= JSON.stringify(key).length + JSON.stringify(entry).length + 2;
        if (Object.keys(bucket).length === 0) {
            delete file.docs[docId];
        }
    }
}

/** 0600 to a temp file, then renamed: a reader sees the old file or the new one, never half. */
function save(path: string, file: StoreFile): void {
    const temp = `${path}.${process.pid}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
        fchmodSync(fd, 0o600);
        writeSync(fd, JSON.stringify(file));
    } finally {
        closeSync(fd);
    }
    renameSync(temp, path);
}

/**
 * Nothing is held in memory: every read and every change starts from the file, so a second
 * daemon on the same directory (`bun run dev`, or one being replaced) keeps the keys this one
 * never touched.
 */
export function pageStore(path: string, options: PageStoreOptions = {}): PageStore {
    const now = options.now ?? Date.now;
    const totalMax = options.totalMax ?? TOTAL_MAX;
    return {
        read(docId) {
            const file = load(path, options.onCorrupt);
            const values: Record<string, string> = {};
            for (const bucket of [file.docs[docId] ?? {}, file.device]) {
                for (const [key, entry] of Object.entries(bucket)) {
                    values[key] = entry.v;
                }
            }
            return values;
        },
        apply(docId, change) {
            const file = load(path, options.onCorrupt);
            const at = now();
            const bucketOf = (key: string): Bucket =>
                DEVICE.has(key) ? file.device : (file.docs[docId] ??= {});
            for (const [key, v] of Object.entries(change.set ?? {})) {
                bucketOf(key)[key] = { v, at };
            }
            for (const key of change.delete ?? []) {
                delete bucketOf(key)[key];
            }
            prune(file, at, totalMax);
            save(path, file);
        },
    };
}
