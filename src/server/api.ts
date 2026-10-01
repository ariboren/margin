// What the CLI calls. Kept light (no markdown parser, no server code) so `margin doc.md` starts
// fast; the daemon itself lives in daemon.ts and runs in its own process.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { signed } from "../core/agent.ts";
import { withLock } from "../core/lock.ts";
import type { AgentIdentity } from "../core/model.ts";
import { isFile } from "./doc-location.ts";
import { openTab, type Env, type Opener } from "./open-tab.ts";
import {
    ensureStateDir,
    isAlive,
    readDaemonInfo,
    removeDaemonInfo,
    stateDir,
    statePaths,
    type DaemonInfo,
    type StatePaths,
} from "./paths.ts";
import {
    PROTOCOL_VERSION,
    routes,
    type DaemonStatus,
    type ErrorBody,
    type RegisterRequest,
    type RegisterResponse,
} from "./protocol.ts";

const DAEMON_ENTRY = join(import.meta.dir, "daemon.ts");
const READY_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 2_000;

export class DocNotFoundError extends Error {
    constructor(readonly path: string) {
        super(`${path}: no such file`);
        this.name = "DocNotFoundError";
    }
}

export class DaemonStartError extends Error {
    constructor(readonly logPath: string) {
        super(`margin daemon did not start; see ${logPath}`);
        this.name = "DaemonStartError";
    }
}

export interface OpenDocOptions {
    /** Default true. */
    openTab?: boolean;
    /**
     * Open no tab when one already shows the doc. For callers that cannot see the browser (an
     * agent rerunning the command to check it worked would otherwise stack up tabs).
     */
    reuseTab?: boolean;
    /** The agent running the open; the page shows it as connecting until its watcher arrives. */
    agent?: AgentIdentity;
    env?: Env;
}

export interface OpenDocResult {
    /** Tab URL, token included. */
    url: string;
    docId: string;
    /** A new daemon was started for this call. */
    spawned: boolean;
    opened: Opener;
    /** A tab already showed the doc, so `reuseTab` opened none. */
    reusedTab: boolean;
}

/**
 * Registers the doc with the running daemon, starting one if none answers, then opens a tab.
 * The tab is opened from this process, not the daemon, so it lands in the caller's Orca worktree.
 */
export async function openDoc(
    docPath: string,
    options: OpenDocOptions = {},
): Promise<OpenDocResult> {
    const env = options.env ?? process.env;
    const path = resolve(docPath);
    if (!isFile(path)) {
        throw new DocNotFoundError(path);
    }
    const paths = statePaths(ensureStateDir(stateDir(env)));
    let spawned = false;
    let registered = await tryRegister(readDaemonInfo(paths.info), path, options.agent);
    if (!registered) {
        registered = await withLock(paths.spawnLock, async () => {
            const existing = await tryRegister(readDaemonInfo(paths.info), path, options.agent);
            if (existing) {
                return existing;
            }
            const info = await spawnDaemon(paths, env);
            spawned = true;
            const fresh = await tryRegister(info, path, options.agent);
            if (!fresh) {
                throw new DaemonStartError(paths.log);
            }
            return fresh;
        });
    }
    const reusedTab = options.reuseTab === true && (registered.clients ?? 0) > 0;
    const opened =
        options.openTab === false || reusedTab ? "none" : await openTab(registered.url, env);
    return { url: registered.url, docId: registered.docId, spawned, opened, reusedTab };
}

export interface StopResult {
    stopped: boolean;
    pid?: number;
}

/** Stops the daemon if one answers with our token. Never signals a pid it could not verify. */
export async function stopDaemon(options: { env?: Env } = {}): Promise<StopResult> {
    const paths = statePaths(stateDir(options.env ?? process.env));
    const info = readDaemonInfo(paths.info);
    if (!info) {
        return { stopped: false };
    }
    const response = await request(info, routes.stop, { method: "POST" });
    if (!response?.ok) {
        if (!isAlive(info.pid)) {
            removeDaemonInfo(paths.info, info.pid);
        }
        return { stopped: false };
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (isAlive(info.pid) && Date.now() < deadline) {
        await Bun.sleep(10);
    }
    return { stopped: true, pid: info.pid };
}

/** Null when no daemon answers. */
export async function daemonStatus(options: { env?: Env } = {}): Promise<DaemonStatus | null> {
    const info = readDaemonInfo(statePaths(stateDir(options.env ?? process.env)).info);
    if (!info) {
        return null;
    }
    const response = await request(info, routes.status, { method: "GET" });
    return response?.ok ? ((await response.json()) as DaemonStatus) : null;
}

async function tryRegister(
    info: DaemonInfo | null,
    path: string,
    agent: AgentIdentity | undefined,
): Promise<RegisterResponse | null> {
    if (!info) {
        return null;
    }
    if (info.protocol !== PROTOCOL_VERSION) {
        // An older or newer daemon: stop it (verified by token) and start ours.
        await request(info, routes.stop, { method: "POST" });
        return null;
    }
    const response = await request(info, routes.register, {
        method: "POST",
        body: JSON.stringify({ path, ...signed(agent) } satisfies RegisterRequest),
    });
    if (!response) {
        return null;
    }
    if (response.status === 404) {
        throw new DocNotFoundError(path);
    }
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ErrorBody | null;
        if (response.status === 403) {
            return null;
        }
        throw new Error(`margin daemon refused ${path}: ${body?.error ?? response.status}`);
    }
    return (await response.json()) as RegisterResponse;
}

/** Null when nothing answers on the port (a stale info file). */
async function request(
    info: DaemonInfo,
    path: string,
    init: { method: "GET" | "POST"; body?: string },
): Promise<Response | null> {
    const origin = `http://127.0.0.1:${info.port}`;
    try {
        return await fetch(`${origin}${path}`, {
            ...init,
            headers: {
                authorization: `Bearer ${info.token}`,
                origin,
                ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch {
        return null;
    }
}

async function spawnDaemon(paths: StatePaths, env: Env): Promise<DaemonInfo> {
    const log = openSync(paths.log, "a", 0o600);
    let exited = false;
    let pid: number | undefined;
    try {
        const child = spawn(process.execPath, [DAEMON_ENTRY], {
            cwd: paths.dir,
            detached: true,
            stdio: ["ignore", "ignore", log],
            env: { ...env, MARGIN_STATE_DIR: paths.dir },
        });
        child.on("exit", () => {
            exited = true;
        });
        child.unref();
        pid = child.pid;
    } finally {
        closeSync(log);
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!exited && Date.now() < deadline) {
        const info = readDaemonInfo(paths.info);
        if (info && info.pid === pid) {
            return info;
        }
        await Bun.sleep(5);
    }
    throw new DaemonStartError(paths.log);
}
