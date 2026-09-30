// The whole loop against a real daemon: the user's side goes through the daemon's HTTP protocol
// (what the tab sends), the agent's side through the CLI (scripts/fake-agent.ts). Every edit is
// checked as exact bytes on disk.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ceilings } from "../../scripts/budget.ts";
import { FakeAgent, type Answer, type Policy } from "../../scripts/fake-agent.ts";
import { byteLength } from "../../src/core/diff.ts";
import type { ThreadId } from "../../src/core/model.ts";
import { openDoc, stopDaemon } from "../../src/server/api.ts";
import { Tab } from "./tab.ts";

const SAMPLE = join(import.meta.dir, "..", "..", "fixtures", "public-sample.md");
const QUOTES = [
    "six nodes to twenty-two",
    "one request in fifty",
    "256 by 256",
    "ninety days",
    "the geocoder",
    "content hash of that document",
];
const NO_WAKE_MS = 800;
const budget = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "budget.json"), "utf8"),
) as Ceilings;

let root: string;
let daemonEnv: Record<string, string | undefined>;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "margin-e2e-"));
    // Own state dir: other checkouts' tests and a user's daemon never see this one.
    daemonEnv = { ...process.env, MARGIN_STATE_DIR: join(root, "state"), MARGIN_NO_OPEN: "1" };
});

afterAll(async () => {
    await stopDaemon({ env: daemonEnv });
    rmSync(root, { recursive: true, force: true });
});

interface World {
    original: Buffer;
    tab: Tab;
    agent: FakeAgent;
    bytes(): Buffer;
}

let worlds = 0;

/** A fresh copy of the public sample in its own directory, registered with the shared daemon. */
async function world(): Promise<World> {
    const dir = join(root, `doc-${++worlds}`);
    mkdirSync(dir);
    const doc = join(dir, "doc.md");
    copyFileSync(SAMPLE, doc);
    const { url, docId } = await openDoc(doc, { env: daemonEnv, openTab: false });
    const agentEnv = { MARGIN_STATE_DIR: join(root, "state"), MARGIN_DEBOUNCE_MS: "0" };
    return {
        original: readFileSync(doc),
        tab: new Tab(url, docId),
        agent: new FakeAgent({ doc, cwd: dir, env: agentEnv }),
        bytes: () => readFileSync(doc),
    };
}

/** The original bytes with each `exact` (unique in the doc) replaced, and nothing else touched. */
function spliced(original: Buffer, ...edits: [exact: string, replace: string][]): Buffer {
    let text = original.toString("utf8");
    for (const [exact, replace] of edits) {
        const start = text.indexOf(exact);
        expect(start).toBeGreaterThanOrEqual(0);
        text = text.slice(0, start) + replace + text.slice(start + exact.length);
    }
    return Buffer.from(text, "utf8");
}

function lastStdout(agent: FakeAgent, command: string): string {
    return agent.calls.findLast((call) => call.argv[0] === command)?.stdout ?? "";
}

describe("loop against a live daemon", () => {
    test("one thread: comment, watch line, pending, suggest, accept, exact bytes", async () => {
        const { tab, agent, original, bytes } = await world();
        const quote = QUOTES[0]!;
        const replace = "six nodes to `twenty-two` ($NODES)";
        const id = await tab.comment(quote, "Say what drove the growth.");

        const batch = await agent.handleBatch(() => ({ suggest: replace }), 5_000);
        expect(batch?.line).toMatchObject({ groups: [{ reason: "new", ids: [id] }] });
        expect(byteLength(lastStdout(agent, "watch"))).toBeLessThanOrEqual(budget.watch);
        expect(agent.calls.map((call) => call.argv[0])).toEqual(["watch", "pending", "suggest"]);
        expect(batch?.tasks).toEqual([{ id, quote, messages: ["Say what drove the growth."] }]);
        expect(batch?.acks).toEqual([`ok ${id} replied`]);
        expect(byteLength(`${batch!.acks[0]}\n`)).toBeLessThanOrEqual(budget.ack);
        expect(bytes().equals(original)).toBe(true);

        expect(await tab.accept(id)).toEqual({ ok: true });
        expect(bytes().equals(spliced(original, [quote, replace]))).toBe(true);
        expect((await tab.thread(id))?.state).toBe("resolved");
        expect((await agent.pending()).threads).toEqual([]);
    });

    test("a large batch is one watch line and one pending", async () => {
        const { tab, agent, original, bytes } = await world();
        const ids: ThreadId[] = [];
        for (const quote of QUOTES) {
            ids.push(
                await tab.comment(
                    quote,
                    `This needs a source and a date, and it should say which cluster it came from (${quote}).`,
                ),
            );
        }
        const replacements = new Map(QUOTES.map((quote) => [quote, `${quote} [checked]`]));
        const policy: Policy = (task) => ({ suggest: replacements.get(task.quote)! });

        const batch = await agent.handleBatch(policy, 5_000);
        expect(batch?.line.groups.flatMap((group) => group.ids).sort()).toEqual([...ids].sort());
        expect(byteLength(lastStdout(agent, "watch"))).toBeLessThanOrEqual(budget.watch);
        expect(agent.calls.filter((call) => call.argv[0] === "pending")).toHaveLength(1);
        expect(batch?.tasks.map((task) => task.id).sort()).toEqual([...ids].sort());
        expect(batch?.tasks.map((task) => task.quote).sort()).toEqual([...QUOTES].sort());
        expect(batch?.acks).toEqual(batch!.tasks.map((task) => `ok ${task.id} replied`));
        expect((await agent.pending()).threads).toEqual([]);

        for (const id of ids) expect(await tab.accept(id)).toEqual({ ok: true });
        const expected = spliced(original, ...[...replacements]);
        expect(bytes().equals(expected)).toBe(true);
    });

    test("--apply writes at once; suggestions only downgrades it", async () => {
        const { tab, agent, original, bytes } = await world();
        const [first, second] = [QUOTES[1]!, QUOTES[2]!];
        const apply: Policy = (task) => ({ suggest: `${task.quote} (applied)`, apply: true });

        const applied = await tab.comment(first, "Fix this now.");
        const batch = await agent.handleBatch(apply, 5_000);
        expect(batch?.acks).toEqual([`ok ${applied} replied`]);
        const afterApply = spliced(original, [first, `${first} (applied)`]);
        expect(bytes().equals(afterApply)).toBe(true);

        await tab.post("setting", { key: "suggestionsOnly", value: true });
        const held = await tab.comment(second, "Fix this too.");
        const downgraded = await agent.handleBatch(apply, 5_000);
        expect(downgraded?.acks).toEqual([`ok ${held} downgraded`]);
        expect(bytes().equals(afterApply)).toBe(true);

        expect(await tab.accept(held)).toEqual({ ok: true });
        expect(bytes().equals(spliced(afterApply, [second, `${second} (applied)`]))).toBe(true);
    });

    test("reject with a note wakes the agent; without one it resolves quietly", async () => {
        const { tab, agent, original, bytes } = await world();
        const quote = QUOTES[3]!;
        const id = await tab.comment(quote, "Is this retention right?");
        await agent.handleBatch(() => ({ suggest: "thirty days" }), 5_000);

        const note = "No, keep the number and add who decided it.";
        await tab.post("reject", { id, note });
        expect(bytes().equals(original)).toBe(true);
        const retry: Answer = { suggest: "ninety days (set by the data team)" };
        const woken = await agent.handleBatch(() => retry, 5_000);
        expect(woken?.line).toMatchObject({ groups: [{ reason: "rejected", ids: [id] }] });
        expect(woken?.tasks[0]?.messages).toEqual([note]);
        expect(await tab.accept(id)).toEqual({ ok: true });
        expect(bytes().equals(spliced(original, [quote, retry.suggest]))).toBe(true);

        const quiet = await tab.comment(QUOTES[4]!, "Drop this?");
        await agent.handleBatch(() => ({ suggest: "the search service" }), 5_000);
        const before = bytes();
        await tab.post("reject", { id: quiet });
        expect(await agent.watchOnce(NO_WAKE_MS)).toBeUndefined();
        expect((await tab.thread(quiet))?.state).toBe("resolved");
        expect(bytes().equals(before)).toBe(true);
    });

    test("a held batch waits for send all", async () => {
        const { tab, agent } = await world();
        await tab.post("hold", { on: true });
        const ids = [
            await tab.comment(QUOTES[0]!, "First held note."),
            await tab.comment(QUOTES[5]!, "Second held note."),
        ];
        expect(await agent.watchOnce(NO_WAKE_MS)).toBeUndefined();
        for (const id of ids) expect((await tab.thread(id))?.state).toBe("draft");

        await tab.post("send-all", {});
        const batch = await agent.handleBatch(() => ({ reply: "Done." }), 5_000);
        expect(batch?.line).toMatchObject({ groups: [{ reason: "new", ids }] });
        expect(batch?.acks).toEqual(ids.map((id) => `ok ${id} replied`));
        expect((await agent.pending()).threads).toEqual([]);
    });

    test("a user edit rides along in pending without waking the agent", async () => {
        const { tab, agent, original, bytes } = await world();
        const snapshot = await tab.snapshot();
        const phrase = QUOTES[1]!;
        const at = snapshot.source.indexOf(phrase);
        const start = snapshot.source.lastIndexOf("\n", at) + 1;
        const end = snapshot.source.indexOf("\n", at);
        const before = snapshot.source.slice(start, end);
        const after = before.replace(phrase, "one request in forty");
        const saved = await tab.post("save", { start, before, after, version: snapshot.version });
        expect(saved).toMatchObject({ ok: true });
        expect(bytes().equals(spliced(original, [before, after]))).toBe(true);
        expect(await agent.watchOnce(NO_WAKE_MS)).toBeUndefined();

        const id = await tab.comment(QUOTES[0]!, "Unrelated question.");
        const pending = await agent.pending();
        expect(pending.threads.map((thread) => thread.id)).toEqual([id]);
        expect(pending.edits).toHaveLength(1);
        const [edit] = pending.edits;
        expect(edit!.hunks.join(" ")).toContain("forty");
        expect(edit!.path).toBe("1. Scope and method");
        expect(byteLength(edit!.text)).toBeLessThan(byteLength(before));

        await agent.answer(id, { reply: "Answered." });
        expect(await agent.pending()).toEqual({ threads: [], edits: [] });
    });
});
