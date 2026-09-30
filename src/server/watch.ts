import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

export interface WatchHandle {
    close(): void;
}

export interface WatchOptions {
    /** Backstop for missed events (and for re-arming a watcher whose directory went away). */
    pollMs?: number;
    /** Events inside this window collapse into one call (an editor's save is several). */
    settleMs?: number;
}

/**
 * Watches a doc and its log through their directories, not the files: editors save by writing
 * a temp file and renaming it over the doc, which a file watch loses with the old inode. Calls
 * `onChange` for anything that may have touched either; the caller decides what changed.
 */
export function watchDoc(
    docPath: string,
    logPath: string,
    onChange: () => void,
    options: WatchOptions = {},
): WatchHandle {
    const pollMs = options.pollMs ?? 1_000;
    const settleMs = options.settleMs ?? 5;
    const docName = basename(docPath);
    const logDir = dirname(logPath);
    const logDirName = basename(logDir);
    const logName = basename(logPath);

    let closed = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
        if (closed || pending) {
            return;
        }
        pending = setTimeout(() => {
            pending = undefined;
            if (!closed) {
                onChange();
            }
        }, settleMs);
    };

    let docWatcher: FSWatcher | undefined;
    let logWatcher: FSWatcher | undefined;
    const arm = () => {
        docWatcher ??= open(
            dirname(docPath),
            (name) => {
                if (name === null || name === docName) {
                    fire();
                } else if (name === logDirName) {
                    arm();
                    fire();
                }
            },
            () => {
                docWatcher = undefined;
            },
        );
        logWatcher ??= open(
            logDir,
            (name) => {
                if (name === null || name === logName) {
                    fire();
                }
            },
            () => {
                logWatcher = undefined;
            },
        );
    };
    arm();

    let last = signature(docPath, logPath);
    const poll = setInterval(() => {
        arm();
        const next = signature(docPath, logPath);
        if (next !== last) {
            last = next;
            fire();
        }
    }, pollMs);

    return {
        close() {
            closed = true;
            clearInterval(poll);
            clearTimeout(pending);
            docWatcher?.close();
            logWatcher?.close();
        },
    };
}

function open(
    dir: string,
    onName: (name: string | null) => void,
    onGone: () => void,
): FSWatcher | undefined {
    try {
        const watcher = watch(dir, { persistent: false }, (_event, name) => {
            onName(typeof name === "string" ? name : null);
        });
        watcher.on("error", () => {
            watcher.close();
            onGone();
        });
        return watcher;
    } catch {
        return undefined;
    }
}

function signature(docPath: string, logPath: string): string {
    return `${stamp(docPath)}|${stamp(logPath)}`;
}

function stamp(path: string): string {
    try {
        const stat = statSync(path);
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
        return "-";
    }
}
