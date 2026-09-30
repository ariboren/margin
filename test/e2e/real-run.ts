// W3c's one real Claude Code session (owner-approved, paid): a headless `claude -p` works
// review threads on a copy of a sample while this driver plays the user over the daemon's
// HTTP protocol and plays Monitor by feeding it `margin watch` batches: four small batches, then
// one large batch with a reject note and a user edit, then one batch through the agent's own
// Monitor. The watch line is compact only, so every batch goes through `pending`. `--dry` swaps Claude for scripts/fake-agent.ts, free.
//
// The transcript quotes the sample, so it and the sidecar go only to --run-dir; stdout and
// metrics.json are numbers and ids.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pickQuote, pickUnit, pickWords, threadSeeds } from "../../scripts/budget.ts";
import { FakeAgent, parseWatch } from "../../scripts/fake-agent.ts";
import { parseDoc } from "../../src/core/blocks.ts";
import { readLog, sidecar } from "../../src/core/log.ts";
import type { Range, Thread, ThreadId } from "../../src/core/model.ts";
import { foldLog, needsAgent } from "../../src/core/threads.ts";
import { openDoc, stopDaemon } from "../../src/server/api.ts";
import { Tab } from "./tab.ts";

const repo = resolve(import.meta.dir, "..", "..");
const TURN_TIMEOUT_MS = 10 * 60_000;
const MONITOR_WAIT_MS = 150_000;

const { values } = parseArgs({
    options: {
        "run-dir": { type: "string" },
        sample: { type: "string", default: join(repo, "fixtures/private/sample.md") },
        live: { type: "boolean", default: false },
        dry: { type: "boolean", default: false },
        model: { type: "string", default: "claude-opus-5-5" },
        "max-budget-usd": { type: "string", default: "10" },
    },
});
const runDir = values["run-dir"];
if (!runDir || values.live === values.dry) {
    console.error("usage: bun test/e2e/real-run.ts --run-dir <dir> (--live | --dry)");
    process.exit(2);
}
mkdirSync(runDir, { recursive: true });
const prefix = values.dry ? "dry-" : "";
const transcriptPath = join(runDir, `${prefix}transcript.jsonl`);
if (values.live && existsSync(transcriptPath)) {
    console.error("a live transcript already exists: one session only, no reruns");
    process.exit(2);
}

type Arm = "setup" | "compact" | "large" | "monitor";

interface Phase {
    name: string;
    arm: Arm;
    threads: ThreadId[];
    /** Event index range [from, to) in the transcript. */
    from: number;
    to: number;
    watchBytes?: number;
    monitorFired?: boolean;
    resultSubtype?: string;
    /** User accepts that failed (e.g. an earlier accept removed the quote). */
    acceptFailed?: number;
}

// ---- world ----

const work = mkdtempSync(join(tmpdir(), "margin-run-"));
const doc = join(work, "doc.md");
copyFileSync(values.sample, doc);
const stateDir = join(work, "state");
const binDir = join(work, "bin");
mkdirSync(binDir);
writeFileSync(
    join(binDir, "margin"),
    `#!/bin/sh\nexec bun ${JSON.stringify(join(repo, "src/cli/main.ts"))} "$@"\n`,
);
chmodSync(join(binDir, "margin"), 0o755);

const daemonEnv = { ...process.env, MARGIN_STATE_DIR: stateDir, MARGIN_NO_OPEN: "1" };
const { url, docId } = await openDoc(doc, { env: daemonEnv, openTab: false });
const tab = new Tab(url, docId);
const driverEnv = { MARGIN_STATE_DIR: stateDir, MARGIN_DEBOUNCE_MS: "0" };
const driver = new FakeAgent({ doc, cwd: work, env: driverEnv });

async function state() {
    return foldLog((await readLog(doc)).events);
}

// ---- seeds, picked by structure on the doc as it reads now ----

type Pick =
    | { seed: string }
    | { unit: Parameters<typeof pickUnit>[1]; words: [number, number]; msg: string };

const extraThread: Pick = {
    unit: { kind: "paragraph", at: 0.6 },
    words: [3, 4],
    msg: "Add when this was measured.",
};

async function post(picks: Pick[]): Promise<ThreadId[]> {
    const { source } = await tab.snapshot();
    const parsed = parseDoc(source);
    const targets: { range: Range; msg: string }[] = picks.map((pick) => {
        if ("seed" in pick) {
            const seed = threadSeeds.find((candidate) => candidate.id === pick.seed)!;
            const unit = pickUnit(parsed, seed.unit, seed.id);
            return { range: pickQuote(parsed, unit, seed.quote), msg: seed.msg };
        }
        const unit = pickUnit(parsed, pick.unit, "extra");
        return { range: pickWords(source, unit, pick.words), msg: pick.msg };
    });
    const ids: ThreadId[] = [];
    for (const target of targets) ids.push(await tab.commentAt(source, target.range, target.msg));
    return ids;
}

/** A user edit on one word of a paragraph, saved whole the way the unit editor saves it. */
async function userEdit(): Promise<void> {
    const snapshot = await tab.snapshot();
    const parsed = parseDoc(snapshot.source);
    const unit = pickUnit(parsed, { kind: "paragraph", at: 0.25 }, "edit");
    const word = pickWords(snapshot.source, unit, [10, 1]);
    const before = snapshot.source.slice(unit.start, unit.end);
    const offset = word.start - unit.start;
    const after = `${before.slice(0, offset)}roughly ${before.slice(offset)}`;
    const saved = await tab.post("save", {
        start: unit.start,
        before,
        after,
        version: snapshot.version,
    });
    if (!("ok" in saved) || !saved.ok) throw new Error("user edit did not save");
}

// ---- the agent: real Claude or the fake ----

interface StreamEvent {
    type: string;
    subtype?: string;
    message?: {
        id?: string;
        role?: string;
        content?: unknown;
        usage?: Usage;
    };
    total_cost_usd?: number;
    num_turns?: number;
    usage?: Usage;
    tools?: string[];
}

interface Usage {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
}

const events: StreamEvent[] = [];
const transcript = createWriteStream(transcriptPath);
let exited = false;

function record(event: StreamEvent): void {
    events.push(event);
    transcript.write(`${JSON.stringify(event)}\n`);
}

interface Session {
    send(text: string): Promise<void>;
    close(): Promise<void>;
}

function childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        // Billed to the owner's subscription, not an API key; not a child of this session.
        if (key === "ANTHROPIC_API_KEY" || key === "CLAUDECODE" || key === "CLAUDE_EFFORT")
            continue;
        if (key.startsWith("CLAUDE_CODE_") || key === "CLAUDE_PID" || key.startsWith("ORCA_"))
            continue;
        env[key] = value;
    }
    env.PATH = `${binDir}:${env.PATH ?? ""}`;
    env.MARGIN_STATE_DIR = stateDir;
    env.MARGIN_NO_OPEN = "1";
    return env;
}

function claudeSession(): Session {
    const args = [
        "-p",
        "--model",
        values.model,
        "--max-budget-usd",
        values["max-budget-usd"],
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--setting-sources",
        "project",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Bash(margin *)",
        "Read",
        "Grep",
        "Glob",
        "Monitor",
        "--disallowedTools",
        "Edit",
        "Write",
        "NotebookEdit",
    ];
    const child: ChildProcessWithoutNullStreams = spawn("claude", args, {
        cwd: work,
        env: childEnv(),
    });
    const stderr = createWriteStream(join(runDir!, "stderr.log"));
    child.stderr.pipe(stderr);
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
                try {
                    record(JSON.parse(line) as StreamEvent);
                } catch {
                    record({ type: "unparsed" });
                }
            }
            newline = buffer.indexOf("\n");
        }
    });
    child.on("exit", () => {
        exited = true;
    });
    return {
        async send(text) {
            const message = {
                type: "user",
                message: { role: "user", content: [{ type: "text", text }] },
                parent_tool_use_id: null,
            };
            child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        async close() {
            child.stdin.end();
            const deadline = Date.now() + 30_000;
            while (!exited && Date.now() < deadline) await Bun.sleep(200);
            if (!exited) child.kill();
        },
    };
}

/** Answers each batch through the CLI at once: checks the plumbing, costs nothing. */
function fakeSession(): Session {
    const agent = new FakeAgent({ doc, cwd: work, env: driverEnv });
    let turn = 0;
    return {
        async send(text) {
            const id = `fake-${++turn}`;
            record({ type: "assistant", message: { id, usage: {} } });
            const line = text.startsWith("margin watch:\n")
                ? parseWatch(text.slice("margin watch:\n".length))
                : undefined;
            if (line) {
                for (const thread of (await agent.pending()).threads) {
                    await agent.answer(thread.id, { suggest: `fake ${thread.id}` });
                }
            }
            record({ type: "result", subtype: "success", total_cost_usd: 0, num_turns: turn });
        },
        async close() {},
    };
}

async function waitTurn(from: number, timeoutMs: number): Promise<StreamEvent | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = events.slice(from).find((event) => event.type === "result");
        if (result) return result;
        if (exited) return undefined;
        await Bun.sleep(250);
    }
    return undefined;
}

// ---- the run ----

const session = values.dry ? fakeSession() : claudeSession();
const phases: Phase[] = [];
let aborted: string | undefined;

async function turn(phase: Phase, text: string): Promise<boolean> {
    phase.from = events.length;
    await session.send(text);
    const result = await waitTurn(phase.from, TURN_TIMEOUT_MS);
    phase.to = events.length;
    phase.resultSubtype = result?.subtype ?? (exited ? "exited" : "timeout");
    phases.push(phase);
    if (result?.subtype !== "success") aborted = `${phase.name}: ${phase.resultSubtype}`;
    return aborted === undefined;
}

const intro = [
    "You are reviewing doc.md with the margin CLI; the user comments in a browser tab.",
    "Start with `margin doc.md`: it prints the command reference.",
    "A harness runs `margin watch doc.md` for you and pastes each batch here as a message",
    "starting with `margin watch:`. Until told otherwise, do not run `margin watch` or",
    "`margin pending --wait` yourself. Answer each batch as the reference says, then end",
    "your turn. Change doc.md only through margin.",
].join("\n");

let reserved: ThreadId | undefined;

async function batch(
    name: string,
    arm: "compact" | "large",
    picks: Pick[],
    before?: () => Promise<void>,
): Promise<boolean> {
    await before?.();
    const threads = await post(picks);
    if (reserved && arm === "large") threads.push(reserved);
    const watched = await driver.margin(["watch", doc, "--once"], "", AbortSignal.timeout(10_000));
    const line = parseWatch(watched.stdout);
    const phase: Phase = {
        name,
        arm,
        threads,
        from: 0,
        to: 0,
        watchBytes: Buffer.byteLength(watched.stdout),
    };
    if (!line) {
        phases.push(phase);
        aborted = `${name}: watch printed nothing`;
        return false;
    }
    if (!(await turn(phase, `margin watch:\n${watched.stdout}`))) return false;
    await settle(phase);
    return true;
}

/** The user's side after a batch: accept every pending suggestion but one kept to reject. */
async function settle(phase: Phase): Promise<void> {
    const { threads } = await state();
    for (const id of phase.threads) {
        const thread = threads.get(id);
        if (thread?.suggestion?.status !== "pending") continue;
        if (phase.arm === "compact" && !reserved) {
            reserved = id;
            continue;
        }
        if (!(await tab.accept(id)).ok) phase.acceptFailed = (phase.acceptFailed ?? 0) + 1;
    }
}

async function rejectReserved(): Promise<void> {
    if (!reserved) return;
    await tab.post("reject", {
        id: reserved,
        note: "Closer, but keep the original terms and make it shorter still.",
    });
}

/** Asks the agent to arm its own Monitor, then posts one comment and waits for a wake. */
async function monitorCheck(): Promise<void> {
    const arm: Phase = { name: "monitor-arm", arm: "monitor", threads: [], from: 0, to: 0 };
    const armed = await turn(
        arm,
        "From now on nothing will be pasted here. Arm `margin watch doc.md` yourself with the Monitor tool, as the reference says, answer what arrives, then end your turn.",
    );
    if (!armed) return;
    const from = events.length;
    const [id] = await post([extraThread]);
    const phase: Phase = { name: "monitor", arm: "monitor", threads: [id!], from, to: from };
    const result = exited ? undefined : await waitTurn(from, MONITOR_WAIT_MS);
    phase.to = events.length;
    phase.monitorFired = events.slice(from).some((event) => event.type === "assistant");
    phase.resultSubtype = result?.subtype ?? "no-wake";
    phases.push(phase);
}

// ---- numbers ----

interface Totals {
    requests: number;
    input: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
    toolCalls: number;
    toolResultBytes: number;
    costUsd: number;
}

function contentBlocks(event: StreamEvent): { type?: string; content?: unknown }[] {
    const content = event.message?.content;
    return Array.isArray(content) ? (content as { type?: string; content?: unknown }[]) : [];
}

function resultBytes(content: unknown): number {
    if (typeof content === "string") return Buffer.byteLength(content);
    if (!Array.isArray(content)) return 0;
    return content.reduce(
        (sum: number, part: { text?: string }) => sum + Buffer.byteLength(part.text ?? ""),
        0,
    );
}

let costBefore = 0;

function totals(phase: Phase): Totals {
    const slice = events.slice(phase.from, phase.to);
    const usage = new Map<string, Usage>();
    let toolCalls = 0;
    let toolResultBytes = 0;
    for (const event of slice) {
        if (event.type === "assistant") {
            usage.set(event.message?.id ?? `anon-${usage.size}`, event.message?.usage ?? {});
            toolCalls += contentBlocks(event).filter((block) => block.type === "tool_use").length;
        }
        if (event.type === "user") {
            for (const block of contentBlocks(event)) {
                if (block.type === "tool_result") toolResultBytes += resultBytes(block.content);
            }
        }
    }
    const result = slice.findLast((event) => event.type === "result");
    // Streamed assistant events carry usage from the start of each message, so output tokens
    // there are partial; the turn's result event has the final count.
    const sum = (key: keyof Usage) =>
        result?.usage?.[key] ??
        [...usage.values()].reduce((total, entry) => total + (entry[key] ?? 0), 0);
    const cost = result?.total_cost_usd;
    const costUsd = cost === undefined ? 0 : cost - costBefore;
    if (cost !== undefined) costBefore = cost;
    return {
        requests: result?.num_turns ?? usage.size,
        input: sum("input_tokens"),
        cacheWrite: sum("cache_creation_input_tokens"),
        cacheRead: sum("cache_read_input_tokens"),
        output: sum("output_tokens"),
        toolCalls,
        toolResultBytes,
        costUsd: Math.round(costUsd * 10_000) / 10_000,
    };
}

function outcome(thread: Thread | undefined) {
    return {
        state: thread?.state ?? "missing",
        answered: thread !== undefined && !needsAgent(thread),
        suggestion: thread?.suggestion?.status ?? "none",
        agentMessages: thread?.messages.filter((message) => message.by === "agent").length ?? 0,
    };
}

async function report(): Promise<void> {
    const { threads } = await state();
    const init = events.find((event) => event.type === "system" && event.subtype === "init");
    const rows = phases.map((phase) => {
        const sums = totals(phase);
        const answered = phase.threads.filter((id) => outcome(threads.get(id)).answered).length;
        return {
            ...phase,
            ...sums,
            answered,
            perThread:
                phase.threads.length === 0
                    ? undefined
                    : {
                          requests: sums.requests / phase.threads.length,
                          input: Math.round(sums.input / phase.threads.length),
                          cacheWrite: Math.round(sums.cacheWrite / phase.threads.length),
                          cacheRead: Math.round(sums.cacheRead / phase.threads.length),
                          output: Math.round(sums.output / phase.threads.length),
                      },
            outcomes: Object.fromEntries(phase.threads.map((id) => [id, outcome(threads.get(id))])),
        };
    });
    const lastResult = events.findLast((event) => event.type === "result");
    const metrics = {
        mode: values.dry ? "dry" : "live",
        model: values.model,
        aborted: aborted ?? null,
        monitorToolListed: init?.tools?.includes("Monitor") ?? null,
        totalCostUsd: lastResult?.total_cost_usd ?? null,
        numTurns: lastResult?.num_turns ?? null,
        phases: rows,
    };
    writeFileSync(join(runDir!, `${prefix}metrics.json`), `${JSON.stringify(metrics, null, 2)}\n`);
    console.log(JSON.stringify(metrics, null, 2));
}

try {
    const setup: Phase = { name: "setup", arm: "setup", threads: [], from: 0, to: 0 };
    let ok = await turn(setup, intro);
    ok &&= await batch("b1", "compact", [{ seed: "c1" }, { seed: "c2" }]);
    ok &&= await batch("b2", "compact", [{ seed: "c3" }, { seed: "c4" }]);
    ok &&= await batch("b3", "compact", [{ seed: "c5" }, { seed: "c8" }]);
    ok &&= await batch("b4", "compact", [{ seed: "c6" }, { seed: "c10" }]);
    ok &&= await batch("b5", "large", [{ seed: "c7" }, { seed: "c9" }], async () => {
        await userEdit();
        await rejectReserved();
    });
    if (ok) await monitorCheck();
} catch (error) {
    aborted = `driver error: ${error instanceof Error ? error.name : "unknown"}`;
} finally {
    await session.close();
    transcript.end();
    await report();
    copyFileSync(sidecar(doc).log, join(runDir, `${prefix}sidecar.jsonl`));
    copyFileSync(doc, join(runDir, `${prefix}doc.md`));
    await stopDaemon({ env: daemonEnv });
    rmSync(work, { recursive: true, force: true });
}
