// Docs this machine has opened, watched or read pending for, newest first. Id-only commands
// (`reply c3 …`) find their doc here: `.margin/` is gitignored, so there is no cheap index to walk.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../core/lock.ts";
import { sidecar } from "../core/log.ts";
import type { Env } from "../server/open-tab.ts";
import { ensureStateDir, stateDir } from "../server/paths.ts";

export const RECENT_DOCS_MAX = 50;

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

export function recentDocs(env: Env): string[] {
    return readList(registryPaths(env).file);
}

/** Moves the doc's real path to the front. */
export async function recordDoc(docPath: string, env: Env): Promise<void> {
    const doc = sidecar(docPath).doc;
    const paths = registryPaths(env);
    ensureStateDir(stateDir(env));
    await withLock(paths.lock, () => {
        const list = readList(paths.file);
        if (list[0] === doc) return;
        const next = [doc, ...list.filter((item) => item !== doc)].slice(0, RECENT_DOCS_MAX);
        const temp = `${paths.file}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
        renameSync(temp, paths.file);
    });
}
