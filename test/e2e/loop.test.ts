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
import type { ThreadId, VerdictState } from "../../src/core/model.ts";
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
/** The verdict that sets a doc aside: its stored state, and the word `watch` and `pending` print. */
const DROPPED = "dropped" satisfies VerdictState;
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
    doc: string;
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
        doc,
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

/** The thread once the daemon has folded the CLI's write (its watcher polls the log). */
async function threadAfterSync(tab: Tab, id: ThreadId, state: string) {
    const deadline = Date.now() + 3_000;
    let thread = await tab.thread(id);
    while (thread?.state !== state && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 50));
        thread = await tab.thread(id);
    }
    return thread;
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

        expect(await tab.accept(id)).toMatchObject({ ok: true });
        expect(bytes().equals(spliced(original, [quote, replace]))).toBe(true);
        expect((await tab.thread(id))?.state).toBe("resolved");
        expect((await agent.pending()).threads).toEqual([]);
    });

    test("a doc note: `doc` on the watch line, no quote in pending, reply and resolve; suggest refused", async () => {
        const { tab, agent, original, bytes } = await world();
        const { id } = await tab.post("comment", { text: "Tighten the whole intro." });

        const batch = await agent.handleBatch(() => ({ reply: "Will do.", resolve: true }), 5_000);
        expect(lastStdout(agent, "watch")).toBe(`new ${id} doc\n`);
        expect(batch?.line).toEqual({
            form: "compact",
            groups: [{ reason: "new", ids: [id], doc: true }],
        });
        expect(lastStdout(agent, "pending")).toBe(
            `${id} open doc\n  user: Tighten the whole intro.\n`,
        );
        expect(batch?.tasks).toEqual([{ id, quote: "", messages: ["Tighten the whole intro."] }]);
        expect(batch?.acks).toEqual([`ok ${id} resolved`]);
        const thread = await threadAfterSync(tab, id, "resolved");
        expect(thread).toMatchObject({ state: "resolved", detached: false });
        expect(thread?.anchor).toBeUndefined();

        const second = (await tab.post("comment", { text: "And the title?" })).id;
        const refused = await agent.handleBatch(() => ({ suggest: "New title" }), 5_000);
        expect(refused?.acks).toEqual([`err ${second} no-anchor`]);
        expect((await threadAfterSync(tab, second, "working"))?.state).toBe("working");
        expect(bytes().equals(original)).toBe(true);
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

        for (const id of ids) expect(await tab.accept(id)).toMatchObject({ ok: true });
        const expected = spliced(original, ...[...replacements]);
        expect(bytes().equals(expected)).toBe(true);
    });

    test("--apply writes at once, as does the doc's auto-apply; off, it suggests", async () => {
        const { tab, agent, original, bytes } = await world();
        const [first, second, third] = [QUOTES[1]!, QUOTES[2]!, QUOTES[4]!];
        const apply: Policy = (task) => ({ suggest: `${task.quote} (applied)`, apply: true });
        const propose: Policy = (task) => ({ suggest: `${task.quote} (applied)` });

        const applied = await tab.comment(first, "Fix this now.");
        const batch = await agent.handleBatch(apply, 5_000);
        expect(batch?.acks).toEqual([`ok ${applied} replied`]);
        const afterApply = spliced(original, [first, `${first} (applied)`]);
        expect(bytes().equals(afterApply)).toBe(true);

        await tab.post("setting", { key: "autoApply", value: true });
        const auto = await tab.comment(second, "Fix this too.");
        const autoBatch = await agent.handleBatch(propose, 5_000);
        expect(autoBatch?.acks).toEqual([`ok ${auto} replied`]);
        const afterAuto = spliced(afterApply, [second, `${second} (applied)`]);
        expect(bytes().equals(afterAuto)).toBe(true);

        await tab.post("setting", { key: "autoApply", value: false });
        const held = await tab.comment(third, "And this.");
        const heldBatch = await agent.handleBatch(propose, 5_000);
        expect(heldBatch?.acks).toEqual([`ok ${held} replied`]);
        expect(bytes().equals(afterAuto)).toBe(true);

        expect(await tab.accept(held)).toMatchObject({ ok: true });
        expect(bytes().equals(spliced(afterAuto, [third, `${third} (applied)`]))).toBe(true);
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
        expect(await tab.accept(id)).toMatchObject({ ok: true });
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

    test("approve: refused with threads open, as is closes them; an edit marks it changed, a comment reopens", async () => {
        const { tab, agent, original, bytes } = await world();
        const suggested = await tab.comment(QUOTES[0]!, "Say what drove the growth.");
        await agent.handleBatch(() => ({ suggest: "six nodes to thirty" }), 5_000);
        const open = await tab.comment(QUOTES[3]!, "Is this retention right?");

        expect(await tab.post("verdict", { state: "approved" })).toMatchObject({
            ok: false,
            reason: "unresolved",
            ids: [suggested, open],
        });
        expect((await tab.snapshot()).verdict).toBeUndefined();

        expect(await tab.post("verdict", { state: "approved", asIs: true })).toMatchObject({
            ok: true,
        });
        const closed = await tab.snapshot();
        expect(closed.verdict).toMatchObject({ state: "approved" });
        expect(closed.threads.map((thread) => thread.state)).toEqual(["resolved", "resolved"]);
        expect(closed.threads.find((thread) => thread.id === suggested)?.suggestion?.status).toBe(
            "rejected",
        );
        expect(bytes().equals(original)).toBe(true);

        expect(await agent.watchOnce(5_000)).toEqual({
            form: "compact",
            groups: [{ reason: "approved", ids: [] }],
        });
        expect(lastStdout(agent, "watch")).toBe("approved\n");
        expect(byteLength(lastStdout(agent, "watch"))).toBeLessThanOrEqual(budget.watch);
        // Unchanged right after the verdict: the daemon and the CLI hash the same source.
        await agent.pending();
        expect(lastStdout(agent, "pending")).toBe("approved\n");

        const phrase = QUOTES[1]!;
        const at = closed.source.indexOf(phrase);
        const start = closed.source.lastIndexOf("\n", at) + 1;
        const before = closed.source.slice(start, closed.source.indexOf("\n", at));
        const after = before.replace(phrase, "one request in forty");
        const saved = await tab.post("save", { start, before, after, version: closed.version });
        expect(saved).toMatchObject({ ok: true });
        expect(bytes().equals(spliced(original, [before, after]))).toBe(true);
        expect(await agent.watchOnce(NO_WAKE_MS)).toBeUndefined();
        const changed = await agent.pending();
        expect(changed.review).toEqual({ verdict: "approved", changed: true });
        expect(lastStdout(agent, "pending").split("\n")[0]).toBe("approved changed");
        expect(changed.edits).toHaveLength(1);
        expect((await tab.snapshot()).verdict).toMatchObject({ state: "approved" });

        const fresh = await tab.comment(QUOTES[4]!, "One more thing.");
        expect((await tab.snapshot()).verdict).toMatchObject({ state: "open" });
        const batch = await agent.handleBatch(() => ({ reply: "Done.", resolve: true }), 5_000);
        expect(batch?.line.groups).toMatchObject([
            { reason: "reopened", ids: [] },
            { reason: "new", ids: [fresh] },
        ]);
        expect(lastStdout(agent, "watch").startsWith(`reopened | new ${fresh} `)).toBe(true);
        expect(lastStdout(agent, "pending").split("\n")[0]).toBe("reopened");
        expect(batch?.tasks.map((task) => task.id)).toEqual([fresh]);
        expect(await agent.pending()).toEqual({ threads: [], edits: [] });
    });

    test("finish: the suggestion is accepted, the rest go to the agent; then approve with a note", async () => {
        const { doc, tab, agent, original, bytes } = await world();
        const quote = QUOTES[0]!;
        const replace = "six nodes to twenty-two (see the capacity log)";
        const suggested = await tab.comment(quote, "Say where this is recorded.");
        await agent.handleBatch(() => ({ suggest: replace }), 5_000);
        const open = await tab.comment(QUOTES[2]!, "Which tile size is this?");
        await tab.post("hold", { on: true });
        const draft = await tab.comment(QUOTES[5]!, "Name the hash function.");
        expect((await tab.thread(draft))?.state).toBe("draft");
        expect(bytes().equals(original)).toBe(true);

        const finished = await tab.post("finish", {});
        expect(finished).toMatchObject({ ids: [open, draft], unapplied: [] });
        expect(finished.seq).toBeGreaterThan(0);
        expect(bytes().equals(spliced(original, [quote, replace]))).toBe(true);
        const handed = await tab.snapshot();
        expect(handed.finish?.ids).toEqual([open, draft]);
        expect(handed.threads.map((thread) => [thread.id, thread.state])).toEqual([
            [suggested, "resolved"],
            [open, "open"],
            [draft, "open"],
        ]);

        const batch = await agent.handleBatch(() => ({ reply: "Done.", resolve: true }), 5_000);
        expect(batch?.line).toEqual({
            form: "compact",
            groups: [{ reason: "finish", ids: [open, draft] }],
        });
        expect(lastStdout(agent, "watch")).toBe(`finish ${open} ${draft}\n`);
        expect(byteLength(lastStdout(agent, "watch"))).toBeLessThanOrEqual(budget.watch);
        expect(lastStdout(agent, "pending").split("\n")[0]).toBe("finish");
        expect(batch?.tasks.map((task) => task.id)).toEqual([open, draft]);
        expect(batch?.acks).toEqual([`ok ${open} resolved`, `ok ${draft} resolved`]);

        await threadAfterSync(tab, draft, "resolved");
        const settled = await tab.snapshot();
        expect(settled.threads.map((thread) => thread.state)).toEqual([
            "resolved",
            "resolved",
            "resolved",
        ]);
        await agent.pending();
        expect(lastStdout(agent, "pending")).toBe("none\n");

        const wait = ["pending", doc, "--wait"];
        const idle = await agent.margin(wait, "", AbortSignal.timeout(NO_WAKE_MS));
        expect(idle.stdout).toBe("");
        const woken = agent.margin(wait, "", AbortSignal.timeout(5_000));
        expect(
            await tab.post("verdict", { state: "approved", note: "  Ship it.\n  Thanks.  " }),
        ).toMatchObject({ ok: true });
        expect((await woken).stdout).toBe("approved: Ship it. Thanks.\n");
        expect(await agent.watchOnce(5_000)).toEqual({
            form: "compact",
            groups: [{ reason: "approved", ids: [] }],
        });
        expect((await tab.snapshot()).verdict).toMatchObject({
            state: "approved",
            note: "Ship it. Thanks.",
        });
        expect(bytes().equals(spliced(original, [quote, replace]))).toBe(true);
    });

    test("finish with two overlapping suggestions applies the first and leaves the second pending", async () => {
        const { tab, agent, original, bytes } = await world();
        const [first, second] = ["six nodes to twenty-two", "twenty-two over the spring"];
        const replacements = new Map([
            [first, "six nodes to thirty"],
            [second, "twenty-two over the summer"],
        ]);
        const ids = [
            await tab.comment(first, "Check the count."),
            await tab.comment(second, "Check the season."),
        ];
        const batch = await agent.handleBatch(
            (task) => ({ suggest: replacements.get(task.quote)! }),
            5_000,
        );
        expect(batch?.acks).toEqual(ids.map((id) => `ok ${id} replied`));

        expect(await tab.post("finish", {})).toMatchObject({
            ids: [ids[1]],
            unapplied: [ids[1]],
        });
        expect(bytes().equals(spliced(original, [first, replacements.get(first)!]))).toBe(true);
        expect((await tab.thread(ids[0]!))?.state).toBe("resolved");
        const left = await tab.thread(ids[1]!);
        expect(left?.state).toBe("open");
        expect(left?.suggestion).toMatchObject({
            status: "pending",
            replace: replacements.get(second)!,
        });

        expect(await agent.watchOnce(5_000)).toEqual({
            form: "compact",
            groups: [{ reason: "finish", ids: [ids[1]!] }],
        });
        const pending = await agent.pending();
        expect(pending.review).toEqual({ finish: true });
        expect(pending.threads.map((thread) => thread.id)).toEqual([ids[1]!]);
    });

    test("drop with a thread open tells the agent and leaves the thread alone", async () => {
        const { tab, agent, original, bytes } = await world();
        const id = await tab.comment(QUOTES[3]!, "Is this retention right?");
        expect(await agent.watchOnce(5_000)).toMatchObject({
            groups: [{ reason: "new", ids: [id] }],
        });
        const before = await tab.thread(id);
        expect(before?.state).toBe("open");

        expect(await tab.post("verdict", { state: DROPPED })).toMatchObject({ ok: true });
        expect(await agent.watchOnce(5_000)).toEqual({
            form: "compact",
            groups: [{ reason: DROPPED, ids: [] }],
        });
        expect(lastStdout(agent, "watch")).toBe(`${DROPPED}\n`);
        const snapshot = await tab.snapshot();
        expect(snapshot.verdict).toMatchObject({ state: DROPPED });
        // The watch above stamped the thread as notified; the daemon may fold that only now.
        expect(snapshot.threads).toEqual([{ ...before!, notifiedAt: expect.any(String) }]);
        expect(bytes().equals(original)).toBe(true);

        const pending = await agent.pending();
        expect(pending.review).toEqual({ verdict: DROPPED });
        expect(lastStdout(agent, "pending").split("\n")[0]).toBe(DROPPED);
        expect(pending.threads.map((thread) => thread.id)).toEqual([id]);
    });
});
