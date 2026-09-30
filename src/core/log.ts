import {
    closeSync,
    fstatSync,
    ftruncateSync,
    openSync,
    readSync,
    realpathSync,
    writeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { withLock, type LockOptions } from "./lock.ts";
import type { Event, EventInput } from "./model.ts";

export interface Sidecar {
    /** Absolute doc path, symlinks resolved when the doc exists. */
    doc: string;
    dir: string;
    log: string;
    lock: string;
}

/** `.margin/<doc>.jsonl` and `.margin/<doc>.lock` beside the doc. */
export function sidecar(docPath: string): Sidecar {
    let doc = resolve(docPath);
    try {
        doc = realpathSync(doc);
    } catch {
        // A missing doc keeps its given path; the log outlives it.
    }
    const dir = join(dirname(doc), ".margin");
    const name = basename(doc);
    return { doc, dir, log: join(dir, `${name}.jsonl`), lock: join(dir, `${name}.lock`) };
}

export interface LogRead {
    events: Event[];
    /** Byte offset just past the last complete line; pass it back to read only what follows. */
    offset: number;
}

const NEWLINE = 0x0a;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Parses complete lines only. Bytes after the last newline are either an append in flight
 * (another process, seen without the lock) or a torn write from a crash; neither is an event yet.
 */
function parseLines(bytes: Uint8Array, base: number): LogRead {
    const end = bytes.lastIndexOf(NEWLINE) + 1;
    const events: Event[] = [];
    for (const line of decoder.decode(bytes.subarray(0, end)).split("\n")) {
        if (line.trim() === "") {
            continue;
        }
        try {
            events.push(JSON.parse(line) as Event);
        } catch {
            // A corrupt complete line is skipped rather than making the whole log unreadable.
        }
    }
    return { events, offset: base + end };
}

async function readBytes(path: string): Promise<Uint8Array> {
    try {
        return new Uint8Array(await readFile(path));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return new Uint8Array();
        }
        throw error;
    }
}

/** Reads the log without the lock. With `fromOffset`, only lines starting at or after it. */
export async function readLog(docPath: string, fromOffset = 0): Promise<LogRead> {
    const bytes = await readBytes(sidecar(docPath).log);
    return parseLines(bytes.subarray(fromOffset), fromOffset);
}

export async function readSince(docPath: string, afterSeq: number): Promise<Event[]> {
    const { events } = await readLog(docPath);
    return events.filter((event) => event.seq > afterSeq);
}

export interface LogTxn {
    readonly sidecar: Sidecar;
    /** Every event in the log, including those appended in this transaction. */
    readonly events: readonly Event[];
    /** Assigns `seq` and `at`, writes the lines, and returns the stored events. */
    append(inputs: readonly EventInput[]): Event[];
}

/**
 * Runs `fn` under the doc lock with a consistent view of the log. Use it whenever an append
 * depends on what is already there (id allocation, claims, compare-and-swap edits).
 */
export async function transact<T>(
    docPath: string,
    fn: (txn: LogTxn) => T | Promise<T>,
    options?: LockOptions,
): Promise<T> {
    const paths = sidecar(docPath);
    return await withLock(
        paths.lock,
        async () => {
            const fd = openSync(paths.log, "a+");
            try {
                const events = readAndRepair(fd);
                const txn: LogTxn = {
                    sidecar: paths,
                    events,
                    append(inputs) {
                        const at = new Date().toISOString();
                        let seq = events.at(-1)?.seq ?? 0;
                        const stored = inputs.map(
                            (input) => ({ seq: ++seq, at, ...input }) as Event,
                        );
                        if (stored.length > 0) {
                            const text = stored
                                .map((event) => `${JSON.stringify(event)}\n`)
                                .join("");
                            writeAll(fd, encoder.encode(text));
                            events.push(...stored);
                        }
                        return stored;
                    },
                };
                return await fn(txn);
            } finally {
                closeSync(fd);
            }
        },
        options,
    );
}

export async function appendEvents(
    docPath: string,
    inputs: readonly EventInput[],
    options?: LockOptions,
): Promise<Event[]> {
    return await transact(docPath, (txn) => txn.append(inputs), options);
}

/** Reads the whole log and cuts off a torn last line, so the next append starts a clean line. */
function readAndRepair(fd: number): Event[] {
    const size = fstatSync(fd).size;
    const bytes = new Uint8Array(size);
    let read = 0;
    while (read < size) {
        const n = readSync(fd, bytes, read, size - read, read);
        if (n === 0) {
            break;
        }
        read += n;
    }
    const { events, offset } = parseLines(bytes.subarray(0, read), 0);
    if (offset < read) {
        ftruncateSync(fd, offset);
    }
    return events;
}

function writeAll(fd: number, bytes: Uint8Array): void {
    let written = 0;
    while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
    }
}
