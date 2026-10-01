// `bun run dev`: runs the daemon from this checkout on the default state dir, so the global
// `margin` and the agent's CLI reuse it. Client changes rebuild and reload open tabs; server
// changes restart the daemon, and tabs reload once they reconnect.
import { rmSync, watch } from "node:fs";
import { join, relative } from "node:path";
import type { Subprocess } from "bun";
import { withLock } from "../src/core/lock.ts";
import { daemonStatus, stopDaemon } from "../src/server/api.ts";
import {
    ensureStateDir,
    isAlive,
    readDaemonInfo,
    stateDir,
    statePaths,
    type DaemonInfo,
    type StatePaths,
} from "../src/server/paths.ts";
import { routes } from "../src/server/protocol.ts";
import { buildClient, clientEntry } from "./build.ts";

export interface Jobs {
    build: boolean;
    restart: boolean;
}

/** What a batch of changed paths (relative to `src/`) needs. Tests never reach the daemon. */
export function jobsFor(files: Iterable<string>): Jobs {
    const jobs: Jobs = { build: false, restart: false };
    for (const file of files) {
        const path = file.replaceAll("\\", "/");
        if (/\.test\.tsx?$/.test(path) || path.endsWith("/testing.ts")) {
            continue;
        }
        if (path.startsWith("client/")) {
            jobs.build = true;
        } else if (path.startsWith("server/")) {
            jobs.restart = true;
        } else if (path.startsWith("core/")) {
            jobs.build = true;
            jobs.restart = true;
        }
    }
    return jobs;
}

const root = join(import.meta.dir, "..");
const daemonEntry = join(root, "src/server/daemon.ts");
const devClientDir = join(root, "dist/dev-client");
const DEBOUNCE_MS = 80;
const READY_TIMEOUT_MS = 5_000;

let paths: StatePaths;
/** Pinned after the first start, so tab URLs stay valid across restarts. */
let pinned: Pick<DaemonInfo, "port" | "token"> | undefined;
let child: Subprocess | undefined;
/** Every doc seen, so a daemon that died between changes gets its docs back. */
const docs = new Set<string>();
let stopping = false;

function log(line: string): void {
    const time = new Date().toTimeString().slice(0, 8);
    console.log(`[dev ${time}] ${line}`);
}

async function timed<T>(work: () => Promise<T>): Promise<[T, string]> {
    const started = performance.now();
    const result = await work();
    return [result, `${Math.round(performance.now() - started)} ms`];
}

async function build(): Promise<void> {
    await buildClient({ entry: clientEntry, outdir: devClientDir, minify: false });
}

/** Stops whatever daemon holds the state dir (adopting its port and token), starts ours. */
async function restart(): Promise<number> {
    // Held while no daemon answers, so a concurrent `margin <doc>` waits instead of spawning.
    return await withLock(paths.spawnLock, async () => {
        for (const doc of (await daemonStatus())?.docs ?? []) {
            docs.add(doc.path);
        }
        const running = readDaemonInfo(paths.info);
        if (!pinned && running) {
            pinned = { port: running.port, token: running.token };
        }
        const previous = child;
        child = undefined;
        await stopDaemon();
        if (previous) {
            previous.kill();
            await previous.exited;
        } else if (running && isAlive(running.pid)) {
            throw new Error(`daemon ${running.pid} did not stop; stop it and retry`);
        }
        const info = await spawn();
        pinned = { port: info.port, token: info.token };
        let registered = 0;
        const origin = `http://127.0.0.1:${info.port}`;
        for (const path of docs) {
            const response = await fetch(`${origin}${routes.register}`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${info.token}`,
                    origin,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ path }),
            }).catch(() => null);
            if (response?.status === 404) {
                docs.delete(path);
            }
            registered += response?.ok ? 1 : 0;
        }
        return registered;
    });
}

async function spawn(): Promise<DaemonInfo> {
    const proc = Bun.spawn([process.execPath, daemonEntry], {
        cwd: root,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
            ...process.env,
            MARGIN_STATE_DIR: paths.dir,
            MARGIN_DEV: "1",
            MARGIN_DEV_CLIENT_DIR: devClientDir,
            ...(pinned
                ? { MARGIN_DEV_PORT: String(pinned.port), MARGIN_DEV_TOKEN: pinned.token }
                : {}),
        },
    });
    child = proc;
    void watchExit(proc);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (proc.exitCode === null && Date.now() < deadline) {
        const info = readDaemonInfo(paths.info);
        if (info?.pid === proc.pid) {
            return info;
        }
        await Bun.sleep(5);
    }
    proc.kill();
    throw new Error(`daemon did not start (port ${pinned?.port ?? "any"})`);
}

async function watchExit(proc: Subprocess): Promise<void> {
    const code = await proc.exited;
    if (proc === child && !stopping) {
        child = undefined;
        log(`daemon exited (${code}); the next change starts it again`);
    }
}

async function run(files: string[]): Promise<void> {
    const jobs = jobsFor(files);
    if (!jobs.build && !jobs.restart) {
        return;
    }
    const what = files.length === 1 ? files[0] : `${files.length} files`;
    const parts: string[] = [];
    try {
        if (jobs.build) {
            const [, took] = await timed(build);
            parts.push(`client rebuilt in ${took}`);
        }
        if (jobs.restart || !child) {
            const [kept, took] = await timed(restart);
            parts.push(`daemon restarted in ${took} (${kept} docs)`);
        } else {
            // Not `child.kill("SIGUSR2")`: Bun 1.3 sends signal 12 by that name, SIGSYS on macOS.
            process.kill(child.pid, "SIGUSR2");
            parts.push("tabs reloading");
        }
        log(`${parts.join(", ")} for ${what}`);
    } catch (caught) {
        const message =
            caught instanceof AggregateError
                ? [caught.message, ...caught.errors.map(buildMessage)].join("\n")
                : caught instanceof Error
                  ? caught.message
                  : String(caught);
        log(`${[...parts, "failed"].join(", ")} for ${what}: ${message}`);
    }
}

function buildMessage(error: unknown): string {
    const position = (error as { position?: { file: string; line: number } | null }).position;
    const where = position ? `${relative(root, position.file)}:${position.line}: ` : "";
    return `  ${where}${error instanceof Error ? error.message : String(error)}`;
}

const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;

async function drain(): Promise<void> {
    if (running) {
        return;
    }
    running = true;
    try {
        while (pending.size > 0) {
            const files = [...pending];
            pending.clear();
            await run(files);
        }
    } finally {
        running = false;
    }
}

async function shutdown(): Promise<void> {
    if (stopping) {
        return;
    }
    stopping = true;
    await stopDaemon();
    child?.kill();
    process.exit(0);
}

if (import.meta.main) {
    paths = statePaths(ensureStateDir(stateDir()));
    rmSync(devClientDir, { recursive: true, force: true });
    const [, buildTook] = await timed(build);
    const [kept, restartTook] = await timed(restart);
    log(
        `client built in ${buildTook}, daemon started in ${restartTook} on port ${pinned?.port} ` +
            `(${kept} docs kept) from ${paths.dir}`,
    );
    log(
        `to run the global margin from this checkout: (cd ${root} && bun link); ` +
            `undo: (cd ${root} && bun unlink) && bun add -g margin-md`,
    );
    watch(join(root, "src"), { recursive: true }, (_event, file) => {
        if (!file) {
            return;
        }
        pending.add(file);
        clearTimeout(timer);
        timer = setTimeout(() => void drain(), DEBOUNCE_MS);
    });
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
}
