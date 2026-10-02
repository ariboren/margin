// Which agents are listening on a doc right now. Each `margin watch` and `pending --wait`
// registers its own entry naming its pid and holding its identity while it runs; the daemon reads
// them for the agent chip. They live beside the log but are not events, so arming a watcher costs
// the log nothing. Liveness comes from the pid, never from a release having run: a crash skips
// release.
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { UNKNOWN_AGENT, agentKey, readIdentity } from "../core/agent.ts";
import { sidecar } from "../core/log.ts";
import type { AgentIdentity } from "../core/model.ts";

/** `.margin/<doc>.watchers/`, one `<pid>-<seq>` file per registered watcher, holding its identity. */
export function watchersDir(docPath: string): string {
    const { dir, doc } = sidecar(docPath);
    return join(dir, `${basename(doc)}.watchers`);
}

/** The single-pid file older builds wrote; read as one entry until its pid dies. */
export function legacyWatcherFile(docPath: string): string {
    const { dir, doc } = sidecar(docPath);
    return join(dir, `${basename(doc)}.watcher`);
}

/** Best effort: a reader or a releasing watcher must never throw over a file it could not remove. */
function remove(file: string): void {
    try {
        rmSync(file, { force: true });
    } catch {
        // Left for the next reader to prune.
    }
}

/**
 * A margin watcher always runs as this user, so a pid we may not signal (EPERM: pid 1, a root
 * daemon, another user's process) is not one, and its entry is pruned like a dead one's.
 */
function isOurs(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function parsePid(text: string): number | undefined {
    const pid = Number(text);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** An entry's contents, validated field by field; not JSON at all (the old empty file) is unknown. */
function parseIdentity(text: string): AgentIdentity {
    try {
        return readIdentity(JSON.parse(text));
    } catch {
        return UNKNOWN_AGENT;
    }
}

function readEntry(file: string): string | undefined {
    try {
        return readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}

/**
 * The distinct agents whose registered pids are alive, in directory order. Entries of dead pids
 * are pruned on the way; one process holding several entries counts once.
 */
export function connectedAgents(docPath: string): AgentIdentity[] {
    const seen = new Map<string, AgentIdentity>();
    const add = (agent: AgentIdentity) => {
        const key = agentKey(agent);
        if (!seen.has(key)) seen.set(key, agent);
    };
    const dir = watchersDir(docPath);
    let names: string[] = [];
    try {
        names = readdirSync(dir).sort();
    } catch {
        // No watcher has registered yet.
    }
    for (const name of names) {
        const pid = parsePid(name.split("-")[0] ?? "");
        if (pid === undefined) {
            continue;
        }
        const file = join(dir, name);
        if (!isOurs(pid)) {
            remove(file);
            continue;
        }
        const text = readEntry(file);
        if (text !== undefined) add(parseIdentity(text));
    }
    const legacy = legacyWatcherFile(docPath);
    const text = readEntry(legacy);
    if (text !== undefined) {
        const pid = parsePid(text.trim());
        if (pid !== undefined && isOurs(pid)) {
            add(UNKNOWN_AGENT);
        } else {
            remove(legacy);
        }
    }
    return [...seen.values()];
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Tells apart overlapping registrations from one process, so one release never drops another. */
let registrations = 0;

/** The entry files this process holds, across every doc it watches. */
const held = new Set<string>();

function releaseAll(): void {
    for (const entry of held) {
        remove(entry);
    }
    held.clear();
}

function onSignal(signal: NodeJS.Signals): void {
    detach();
    releaseAll();
    process.kill(process.pid, signal);
}

function attach(): void {
    for (const signal of SIGNALS) {
        process.on(signal, onSignal);
    }
    process.on("exit", releaseAll);
}

function detach(): void {
    for (const signal of SIGNALS) {
        process.off(signal, onSignal);
    }
    process.off("exit", releaseAll);
}

/**
 * Registers this process as `agent` on the doc, best effort, until the returned release is
 * called. A signal removes every entry this process holds and then re-raises, so the default exit
 * still happens; SIGKILL leaves stale entries, which the pid check prunes. Release removes only
 * this registration's own entry. One set of process listeners serves every registration: a watch
 * over many docs must not add its own per doc.
 */
export function holdPresence(docPath: string, agent: AgentIdentity): () => void {
    const dir = watchersDir(docPath);
    const name = `${process.pid}-${registrations++}`;
    const entry = join(dir, name);
    // Handlers first: once the entry is visible, a signal must already find them, or the default
    // exit would leave it behind.
    if (held.size === 0) attach();
    held.add(entry);
    try {
        // Only beside a doc that exists: never create `.margin/` for a mistyped or deleted path.
        if (existsSync(sidecar(docPath).doc)) {
            mkdirSync(dir, { recursive: true });
            // Written whole, then renamed: the daemon polls every second and a truncated file
            // would read as an unknown agent for a tick. The dot keeps the pid parser off it.
            const draft = join(dir, `.${name}`);
            writeFileSync(draft, JSON.stringify(agent));
            renameSync(draft, entry);
        }
    } catch {
        // Presence is a courtesy to the page; the watcher works without it.
    }
    let released = false;
    // The directory stays: removing it when empty would race a sibling about to register.
    return () => {
        if (released) return;
        released = true;
        remove(entry);
        held.delete(entry);
        if (held.size === 0) detach();
    };
}

/** Holds presence on the doc for the life of `run`. */
export async function withPresence<T>(
    docPath: string,
    agent: AgentIdentity,
    run: () => Promise<T>,
): Promise<T> {
    const release = holdPresence(docPath, agent);
    try {
        return await run();
    } finally {
        release();
    }
}
