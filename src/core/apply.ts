import {
    closeSync,
    fchmodSync,
    fsyncSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { decodeSource, hashText, lineAt, parseDoc, spliceEdit, unitAt } from "./blocks.ts";
import { transact, type LogTxn } from "./log.ts";
import type { LockOptions } from "./lock.ts";
import type { Author, EditCause, EditEvent, Offset, SourceSplice, ThreadId } from "./model.ts";
import { catchUpInputs } from "./threads.ts";

export interface ApplyInput extends SourceSplice {
    cause: EditCause;
    by: Author;
    /** Thread the edit came from (accept, apply, revert). */
    id?: ThreadId;
}

export type ApplyFailure = "before-missing" | "not-unique" | "missing";

export type ApplyResult =
    | { ok: true; status: "changed"; event: EditEvent; source: string; hash: string }
    | { ok: true; status: "unchanged"; source: string; hash: string }
    | { ok: false; reason: ApplyFailure; source?: string };

/** The one write path for doc bytes: lock, read, check `before`, splice, atomic write, append. */
export async function applyEdit(
    docPath: string,
    input: ApplyInput,
    options?: LockOptions,
): Promise<ApplyResult> {
    return await transact(docPath, (txn) => applyEditIn(txn, input), options);
}

/**
 * `applyEdit` inside a caller's transaction, so related events (accept, suggest) land under the
 * same lock. The file is written before the event is appended: a crash in between leaves a
 * change the watcher sees as an outside edit, never an event for bytes that were not written.
 * A doc changed with no event to say so (an editor save with no daemon) is caught up first, so
 * the edit's splice rebases anchors from where their quotes really are.
 */
export function applyEditIn(txn: LogTxn, input: ApplyInput): ApplyResult {
    const path = txn.sidecar.doc;
    let bytes: Uint8Array;
    try {
        bytes = readFileSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { ok: false, reason: "missing" };
        }
        throw error;
    }
    const source = decodeSource(bytes);
    txn.append(catchUpInputs(txn.events, source));
    const found = locate(source, input.start, input.before);
    if (typeof found === "string") {
        return { ok: false, reason: found, source };
    }

    const doc = parseDoc(source);
    const result = spliceEdit(doc, { start: found, before: input.before, after: input.after });
    if (result.status === "unchanged") {
        return { ok: true, status: "unchanged", source, hash: hashText(source) };
    }
    if (result.status === "conflict") {
        return { ok: false, reason: "before-missing", source };
    }

    writeAtomic(path, new TextEncoder().encode(result.source));
    const hash = hashText(result.source);
    const unit = unitAt(doc.units, {
        start: found,
        end: found + input.before.length,
    });
    const [event] = txn.append([
        {
            type: "edit",
            by: input.by,
            cause: input.cause,
            ...result.edit,
            line: lineAt(source, found),
            headingPath: unit?.headingPath ?? [],
            ...(input.id === undefined ? {} : { id: input.id }),
            hashAfter: hash,
        },
    ]);
    return { ok: true, status: "changed", event: event as EditEvent, source: result.source, hash };
}

/**
 * Where `before` is now: at `start`, else its only occurrence. Several copies elsewhere are
 * refused rather than guessed at; the caller re-resolves its anchor and retries.
 */
export function locate(
    source: string,
    start: Offset,
    before: string,
): Offset | "before-missing" | "not-unique" {
    if (start >= 0 && start <= source.length && source.startsWith(before, start)) {
        return start;
    }
    if (before === "") {
        return "before-missing";
    }
    const first = source.indexOf(before);
    if (first === -1) {
        return "before-missing";
    }
    return source.indexOf(before, first + 1) === -1 ? first : "not-unique";
}

/** Temp file beside the target, fsync, rename over it. The target keeps its mode. */
function writeAtomic(path: string, bytes: Uint8Array): void {
    const dir = dirname(path);
    const temp = join(
        dir,
        `.${basename(path)}.margin-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    const mode = statSync(path).mode & 0o7777;
    const fd = openSync(temp, "wx", mode);
    try {
        // openSync's mode is filtered by the umask; set it exactly.
        fchmodSync(fd, mode);
        let written = 0;
        while (written < bytes.length) {
            written += writeSync(fd, bytes, written, bytes.length - written);
        }
        fsyncSync(fd);
    } catch (error) {
        closeSync(fd);
        unlinkSync(temp);
        throw error;
    }
    closeSync(fd);
    try {
        renameSync(temp, path);
    } catch (error) {
        unlinkSync(temp);
        throw error;
    }
    syncDir(dir);
}

function syncDir(dir: string): void {
    let fd: number | undefined;
    try {
        fd = openSync(dir, "r");
        fsyncSync(fd);
    } catch {
        // Some filesystems refuse fsync on a directory; the rename itself already happened.
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}
