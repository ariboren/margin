// The title Claude Code shows for the session that spawned us (its tab and terminal title), read
// from the session's transcript: a `custom-title` entry once the user has renamed the session,
// else the latest `ai-title` Claude Code wrote for itself.
import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../server/open-tab.ts";

/** Claude Code rewrites both title entries as the session grows, so the tail always holds them. */
const TAIL_BYTES = 1024 * 1024;

/** The id becomes a file name, so it must be exactly the shape Claude Code issues. */
const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function configDir(env: Env): string | undefined {
    if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
    return env.HOME ? join(env.HOME, ".claude") : undefined;
}

function readTail(file: string): string | undefined {
    let fd: number | undefined;
    try {
        fd = openSync(file, "r");
        const { size } = fstatSync(fd);
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        return buffer.toString("utf8");
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/**
 * The transcript sits under a directory named for the cwd the session started in, which is not
 * ours to reconstruct: a margin command may run from anywhere.
 */
function transcriptTail(env: Env, sessionId: string): string | undefined {
    const dir = configDir(env);
    if (dir === undefined) return undefined;
    const projects = join(dir, "projects");
    let names: string[];
    try {
        names = readdirSync(projects);
    } catch {
        return undefined;
    }
    for (const name of names) {
        const tail = readTail(join(projects, name, `${sessionId}.jsonl`));
        if (tail !== undefined) return tail;
    }
    return undefined;
}

function titleField(line: string, type: string, field: string): string | undefined {
    if (!line.includes(`"${type}"`)) return undefined;
    try {
        const entry: unknown = JSON.parse(line);
        if (typeof entry !== "object" || entry === null) return undefined;
        const record = entry as Record<string, unknown>;
        const title = record[field];
        return record.type === type && typeof title === "string" ? title : undefined;
    } catch {
        // The tail's first line is cut mid-entry.
        return undefined;
    }
}

export function sessionTitle(env: Env): string | undefined {
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    if (sessionId === undefined || !SESSION_ID.test(sessionId)) return undefined;
    const tail = transcriptTail(env, sessionId);
    if (tail === undefined) return undefined;
    const lines = tail.split("\n").reverse();
    const latest = (type: string, field: string): string | undefined => {
        for (const line of lines) {
            const title = titleField(line, type, field);
            if (title !== undefined) return title;
        }
        return undefined;
    };
    const custom = latest("custom-title", "customTitle");
    // A blank custom title is one the user cleared.
    return custom?.trim() ? custom : latest("ai-title", "aiTitle");
}
