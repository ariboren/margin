import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const LIBC_CANDIDATES =
    process.platform === "darwin"
        ? ["libc.dylib", "/usr/lib/libSystem.B.dylib"]
        : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"];

type Flock = (fd: number, operation: number) => number;

let flockFn: Flock | undefined;

function flock(): Flock {
    if (flockFn) {
        return flockFn;
    }
    for (const name of LIBC_CANDIDATES) {
        try {
            const lib = dlopen(name, {
                flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
            });
            flockFn = (fd, operation) => lib.symbols.flock(fd, operation);
            return flockFn;
        } catch {
            continue;
        }
    }
    throw new Error(`flock unavailable: no libc found among ${LIBC_CANDIDATES.join(", ")}`);
}

export class LockTimeoutError extends Error {
    constructor(readonly path: string) {
        super(`Timed out waiting for lock ${path}`);
        this.name = "LockTimeoutError";
    }
}

export interface LockOptions {
    /** Give up after this long. Default 10 s. */
    timeoutMs?: number;
}

/**
 * Runs `fn` while holding an exclusive `flock(2)` on `path`. The kernel drops the lock when the
 * holder exits, even on SIGKILL, so there is no stale lock to break and the file is never
 * removed. Two opens in one process conflict too (the lock belongs to the open file
 * description), so concurrent callers in the same process also serialize. Local filesystems
 * only; flock over NFS is not reliable.
 */
export async function withLock<T>(
    path: string,
    fn: () => T | Promise<T>,
    options: LockOptions = {},
): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const lock = flock();
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "a");
    try {
        const deadline = Date.now() + timeoutMs;
        let delay = 1;
        // A non-blocking attempt in a loop: a blocking flock would stall Bun's event loop.
        while (lock(fd, LOCK_EX | LOCK_NB) !== 0) {
            if (Date.now() >= deadline) {
                throw new LockTimeoutError(path);
            }
            await Bun.sleep(delay + Math.random() * delay);
            delay = Math.min(delay * 2, 25);
        }
        try {
            return await fn();
        } finally {
            lock(fd, LOCK_UN);
        }
    } finally {
        closeSync(fd);
    }
}
