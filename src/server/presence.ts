// Whether an agent is listening on a doc right now. `margin watch` and `pending --wait` hold a
// presence file naming their pid while they run; the daemon reads it for the "Agent watching"
// chip. It lives beside the log but is not an event, so arming a watcher costs the log nothing.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sidecar } from "../core/log.ts";
import { isAlive } from "./paths.ts";

export function watcherFile(docPath: string): string {
    const { dir, doc } = sidecar(docPath);
    return join(dir, `${basename(doc)}.watcher`);
}

/** True when the presence file names a live process. A stale file (killed watcher) reads false. */
export function agentWatching(docPath: string): boolean {
    let text: string;
    try {
        text = readFileSync(watcherFile(docPath), "utf8");
    } catch {
        return false;
    }
    const pid = Number(text.trim());
    return Number.isSafeInteger(pid) && pid > 0 && isAlive(pid);
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Writes this process's presence file for the life of `run`, best effort. A signal removes it
 * and then re-raises, so the default exit still happens; SIGKILL leaves a stale file, which the
 * pid check covers. A second watcher takes the file over; each removes it only while it is theirs.
 */
export async function withPresence<T>(docPath: string, run: () => Promise<T>): Promise<T> {
    const file = watcherFile(docPath);
    const pid = String(process.pid);
    const release = () => {
        try {
            if (readFileSync(file, "utf8").trim() === pid) {
                rmSync(file, { force: true });
            }
        } catch {
            // Already gone.
        }
    };
    const onSignal = (signal: NodeJS.Signals) => {
        detach();
        release();
        process.kill(process.pid, signal);
    };
    const detach = () => {
        for (const signal of SIGNALS) {
            process.off(signal, onSignal);
        }
        process.off("exit", release);
    };
    // Handlers first: once the file is visible, a signal must already find them, or the default
    // exit would leave the file behind.
    for (const signal of SIGNALS) {
        process.on(signal, onSignal);
    }
    process.on("exit", release);
    try {
        // Only beside a doc that exists: never create `.margin/` for a mistyped or deleted path.
        if (existsSync(sidecar(docPath).doc)) {
            mkdirSync(dirname(file), { recursive: true });
            // Written aside and renamed, so a reader never sees a half-written pid.
            const temp = `${file}.${pid}`;
            writeFileSync(temp, `${pid}\n`);
            renameSync(temp, file);
        }
    } catch {
        // Presence is a courtesy to the page; the watcher works without it.
    }
    try {
        return await run();
    } finally {
        detach();
        release();
    }
}
