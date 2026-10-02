// Docs this machine has opened, watched or read pending for, newest first. Id-only commands
// (`reply c3 …`) find their doc here: `.margin/` is gitignored, so there is no cheap index to walk.
// Beside it, the same list per agent session, which is what `margin watch` with no path follows.
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withLock } from "../core/lock.ts";
import { sidecar } from "../core/log.ts";
import type { Env } from "../server/open-tab.ts";
import { deviceDir, ensureStateDir, stateDir } from "../server/paths.ts";
import { sessionKey } from "./identity.ts";

export const RECENT_DOCS_MAX = 50;

/** A session's list is dropped once nothing has been recorded in it for this long. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function registryPaths(env: Env): { file: string; lock: string } {
    const dir = stateDir(env);
    return { file: join(dir, "recent-docs.json"), lock: join(dir, "recent-docs.lock") };
}

function readList(file: string): string[] {
    try {
        const list: unknown = JSON.parse(readFileSync(file, "utf8"));
        return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
    } catch {
        return [];
    }
}

function writeList(file: string, list: string[]): void {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(list), { mode: 0o600 });
    renameSync(temp, file);
}

function withDoc(list: string[], doc: string): string[] {
    return [doc, ...list.filter((item) => item !== doc)].slice(0, RECENT_DOCS_MAX);
}

export function recentDocs(env: Env): string[] {
    return readList(registryPaths(env).file);
}

/**
 * Not the state dir: that is wiped at logout on Linux, and a session outlives a logout. The key
 * is hashed because it comes from the environment and becomes a file name.
 */
function sessionPaths(env: Env, key: string): { dir: string; file: string; lock: string } {
    const dir = join(deviceDir(env), "sessions");
    const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return { dir, file: join(dir, `${name}.json`), lock: join(dir, "lock") };
}

/**
 * The docs this agent session has opened, newest first. Undefined without a session, and when
 * the session has no list: nothing recorded yet, or the list was removed.
 */
export function sessionDocs(env: Env): string[] | undefined {
    const key = sessionKey(env);
    if (key === undefined) return undefined;
    const { file } = sessionPaths(env, key);
    return existsSync(file) ? readList(file) : undefined;
}

/**
 * Marks the session's list as in use now. A watch that runs for weeks records nothing, and
 * without this another session's prune would take its list from under it.
 */
export function touchSession(env: Env, now = Date.now()): void {
    const key = sessionKey(env);
    if (key === undefined) return;
    try {
        utimesSync(sessionPaths(env, key).file, now / 1000, now / 1000);
    } catch {
        // No list yet.
    }
}

function pruneSessions(dir: string, keep: string, now: number): void {
    for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (!name.endsWith(".json") || file === keep) continue;
        try {
            if (now - statSync(file).mtimeMs > SESSION_MAX_AGE_MS) rmSync(file, { force: true });
        } catch {
            // Another command pruned it first.
        }
    }
}

async function recordSessionDoc(doc: string, env: Env, now: number): Promise<void> {
    const key = sessionKey(env);
    if (key === undefined) return;
    const paths = sessionPaths(env, key);
    ensureStateDir(deviceDir(env));
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    await withLock(paths.lock, () => {
        // Written even when nothing changes: the file's age is how a live session is told from
        // one long gone.
        writeList(paths.file, withDoc(readList(paths.file), doc));
        pruneSessions(paths.dir, paths.file, now);
    });
}

/** Moves the doc's real path to the front, here and in this agent session's list. */
export async function recordDoc(docPath: string, env: Env, now = Date.now()): Promise<void> {
    const doc = sidecar(docPath).doc;
    const paths = registryPaths(env);
    ensureStateDir(stateDir(env));
    await withLock(paths.lock, () => {
        const list = readList(paths.file);
        if (list[0] === doc) return;
        writeList(paths.file, withDoc(list, doc));
    });
    await recordSessionDoc(doc, env, now);
}
