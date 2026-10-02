// What the page keeps on the device: view settings and theme once, drafts and markers per doc.
// Browser storage cannot hold it, since every daemon start is a new port and so a new origin.
import { closeSync, fchmodSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { withLock } from "../core/lock.ts";
import {
    DEVICE_KEYS,
    STORED_CHANGE_MAX,
    STORED_KEY_MAX,
    STORED_VALUE_MAX,
    type DocId,
    type StoredChange,
} from "./protocol.ts";

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
    /** Rejects, changing nothing, when the file is there and cannot be read. */
    apply(docId: DocId, change: StoredChange): Promise<void>;
}

export interface PageStoreOptions {
    now?: () => number;
    totalMax?: number;
    /** Told about a file that is there and cannot be read or does not parse. */
    onCorrupt?: (caught: unknown) => void;
}

function validKey(key: string): boolean {
    return (
        key.startsWith(KEY_PREFIX) &&
        key.length <= STORED_KEY_MAX &&
        // Keys carry file paths, so anything printable goes; a control character never does.
        !/[\u0000-\u001f\u007f]/.test(key)
    );
}

export interface ParsedChange {
    change: Required<StoredChange>;
    /** Keys off the rules. They cost the rest of the change nothing. */
    skipped: string[];
}

/** Null when the body is not a change at all; one bad key or value is only skipped. */
export function parseChange(body: unknown): ParsedChange | null {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return null;
    }
    const { set = {}, delete: remove = [] } = body as { set?: unknown; delete?: unknown };
    if (typeof set !== "object" || set === null || Array.isArray(set) || !Array.isArray(remove)) {
        return null;
    }
    const entries = Object.entries(set as Record<string, unknown>);
    if (
        entries.length + remove.length > STORED_CHANGE_MAX ||
        remove.some((key) => typeof key !== "string")
    ) {
        return null;
    }
    const change: Required<StoredChange> = { set: {}, delete: [] };
    const skipped: string[] = [];
    for (const [key, value] of entries) {
        if (validKey(key) && typeof value === "string" && value.length <= STORED_VALUE_MAX) {
            change.set[key] = value;
        } else {
            skipped.push(key);
        }
    }
    for (const key of remove as string[]) {
        if (validKey(key)) {
            change.delete.push(key);
        } else {
            skipped.push(key);
        }
    }
    return { change, skipped };
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

/** The file is there and its text is not a store. */
class CorruptStore extends Error {}

/** Empty when there is no file. Throws when there is one and it cannot be read or parsed. */
function load(path: string): StoreFile {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
            return { device: {}, docs: {} };
        }
        throw caught;
    }
    let raw: { device?: unknown; docs?: unknown } | null;
    try {
        raw = JSON.parse(text) as typeof raw;
    } catch (caught) {
        throw new CorruptStore(`page store does not parse: ${path}`, { cause: caught });
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new CorruptStore(`page store is not an object: ${path}`);
    }
    const docs: Record<DocId, Bucket> = {};
    if (typeof raw.docs === "object" && raw.docs !== null) {
        for (const [docId, bucket] of Object.entries(raw.docs)) {
            docs[docId] = readBucket(bucket);
        }
    }
    return { device: readBucket(raw.device), docs };
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
 * Nothing is held in memory: every read and every change starts from the file, and a change
 * holds a lock from its read to its write, so a second daemon on the same directory
 * (`bun run dev`, or one being replaced) loses no key to this one.
 */
export function pageStore(path: string, options: PageStoreOptions = {}): PageStore {
    const now = options.now ?? Date.now;
    const totalMax = options.totalMax ?? TOTAL_MAX;
    /**
     * A file that does not parse will not parse later either, so it is moved aside, kept for
     * whoever wants its text, and the store starts over. A file that could not be read may be
     * whole: that throws, and the write is refused rather than made over it.
     */
    const loadForWrite = (): StoreFile => {
        try {
            return load(path);
        } catch (caught) {
            options.onCorrupt?.(caught);
            if (!(caught instanceof CorruptStore)) {
                throw caught;
            }
            renameSync(path, `${path}.unreadable`);
            return { device: {}, docs: {} };
        }
    };
    return {
        read(docId) {
            let file: StoreFile;
            try {
                file = load(path);
            } catch (caught) {
                options.onCorrupt?.(caught);
                return {};
            }
            const values: Record<string, string> = {};
            for (const bucket of [file.docs[docId] ?? {}, file.device]) {
                for (const [key, entry] of Object.entries(bucket)) {
                    values[key] = entry.v;
                }
            }
            return values;
        },
        async apply(docId, change) {
            await withLock(`${path}.lock`, () => {
                const file = loadForWrite();
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
            });
        },
    };
}
