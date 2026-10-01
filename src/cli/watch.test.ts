import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readLog } from "../core/log.ts";
import type { Event, EventInput } from "../core/model.ts";
import { foldLog } from "../core/threads.ts";
import { sandbox, type Sandbox } from "./testing.ts";
import { DEBOUNCE_MS, docWake, emitWatch, wakeReason, watch } from "./watch.ts";

let box: Sandbox;

beforeEach(() => {
    box = sandbox();
});

afterEach(() => {
    box.cleanup();
});

const MAIN = join(import.meta.dir, "main.ts");

function collect(): { lines: string[]; write: (text: string) => void } {
    const lines: string[] = [];
    return { lines, write: (text) => lines.push(text) };
}

async function events(): Promise<Event[]> {
    return (await readLog(box.doc)).events;
}

describe("wake set", () => {
    test("new comment, user reply, reject with note and a retract that leaves the thread open wake; the rest never do", async () => {
        const id = await box.comment("cold path", "Why rarely?");
        await box.append(
            { type: "reply", by: "user", id, text: "Also this" },
            { type: "reply", by: "agent", id, text: "Checking" },
            { type: "reject", by: "user", id, note: "Not that" },
            { type: "reject", by: "user", id },
            { type: "accept", by: "user", id },
            { type: "resolve", by: "user", id },
            { type: "reopen", by: "user", id },
            { type: "retract", by: "user", id, of: 2 },
        );
        await box.comment("first tile", "Draft", { draft: true });
        const log = await events();
        const state = foldLog(log);
        const reasons = log.map((event) => [event.type, wakeReason(event, state) ?? null]);
        expect(reasons).toEqual([
            ["comment", "new"],
            ["reply", "reply"],
            ["reply", null],
            ["reject", "rejected"],
            ["reject", null],
            ["accept", null],
            ["resolve", null],
            ["reopen", null],
            ["retract", "reply"],
            ["comment", null],
        ]);
    });

    test("user edits never wake, and neither does a batch whose threads are done", async () => {
        const id = await box.comment("cold path", "Why?");
        await box.append({ type: "resolve", by: "user", id });
        const out = collect();
        expect(await emitWatch(box.doc, out.write)).toBe(false);
        expect(out.lines).toEqual([]);
        // The cursor still moved past the batch, so it is never reconsidered; it names no thread.
        expect((await box.state()).cursors.watch).toBe(2);
        expect((await events()).at(-1)).toMatchObject({ type: "cursor", upTo: 2, ids: [] });
    });
});

describe("emit", () => {
    test("a batch prints one compact line, claims nothing and moves the cursor", async () => {
        await box.comment("cold path", "Why rarely?");
        await box.comment("Retry queue", "Which queue?");
        const out = collect();
        expect(await emitWatch(box.doc, out.write)).toBe(true);
        expect(out.lines).toEqual(['new c1 c2 "Findings"\n']);
        const state = await box.state();
        expect(state.threads.get("c1")!.claimed).toBe(false);
        expect(state.threads.get("c1")!.state).toBe("open");
        expect(state.cursors.watch).toBe(2);
        expect((await events()).at(-1)).toMatchObject({ type: "cursor", ids: ["c1", "c2"] });
    });

    test("a long message changes nothing: the line carries ids and paths only", async () => {
        await box.comment("cold path", "Why? ".repeat(130));
        const out = collect();
        await emitWatch(box.doc, out.write);
        expect(out.lines).toEqual(['new c1 "Findings"\n']);
    });

    test("groups by reason and drops a path the group does not share", async () => {
        const id = await box.comment("cold path", "Why?");
        await emitWatch(box.doc, () => {});
        await box.comment("Title", "Rename?");
        await box.comment("Retry queue", "Which?");
        await box.append(
            { type: "reply", by: "user", id, text: "Any news?" },
            { type: "reject", by: "user", id, note: "Keep it short" },
        );
        const out = collect();
        await emitWatch(box.doc, out.write);
        expect(out.lines).toEqual(['new c2 c3 | reply c1 "Findings"\n']);
    });

    test("a group of doc notes prints doc where the path goes; a mixed group prints neither", async () => {
        await box.note("Overall?");
        const first = collect();
        await emitWatch(box.doc, first.write);
        expect(first.lines).toEqual(["new c1 doc\n"]);
        await box.note("And the title?");
        await box.comment("cold path", "Why?");
        const second = collect();
        await emitWatch(box.doc, second.write);
        expect(second.lines).toEqual(["new c2 c3\n"]);
    });

    test("a delete never prints; an undelete of a waiting thread wakes it as new", async () => {
        const id = await box.comment("cold path", "Why?");
        await box.append({ type: "delete", by: "user", id });
        const out = collect();
        expect(await emitWatch(box.doc, out.write)).toBe(false);
        expect(out.lines).toEqual([]);
        await box.append({ type: "undelete", by: "user", id });
        expect(await emitWatch(box.doc, out.write)).toBe(true);
        expect(out.lines).toEqual(['new c1 "Findings"\n']);
        await box.append({ type: "delete", by: "user", id });
        expect(await emitWatch(box.doc, out.write)).toBe(false);
        expect(out.lines).toHaveLength(1);
    });

    test("send wakes drafts", async () => {
        const id = await box.comment("cold path", "Held", { draft: true });
        await box.append({ type: "send", by: "user", ids: [id] });
        const out = collect();
        await emitWatch(box.doc, out.write);
        expect(out.lines).toEqual(['new c1 "Findings"\n']);
    });
});

async function emitted(): Promise<string> {
    const out = collect();
    await emitWatch(box.doc, out.write);
    return out.lines.join("");
}

/** What a running `watch` prints for `input`, given time to settle. */
async function watchedQuietly(input: EventInput): Promise<string[]> {
    const stop = new AbortController();
    const out = collect();
    const running = watch(box.doc, out.write, { signal: stop.signal, debounceMs: 0 });
    await Bun.sleep(200);
    await box.append(input);
    await Bun.sleep(500);
    stop.abort();
    await running;
    return out.lines;
}

describe("doc status", () => {
    const approve = { type: "verdict", by: "user", state: "approved", hash: "h" } as const;
    const drop = { type: "verdict", by: "user", state: "dropped", hash: "h" } as const;
    const reopen = { type: "verdict", by: "user", state: "open", hash: "h" } as const;

    test("a verdict prints its word alone, once", async () => {
        await box.append({ ...approve, note: "Ship it" });
        expect(await emitted()).toBe("approved\n");
        expect((await events()).at(-1)).toMatchObject({ type: "cursor", upTo: 1, ids: [] });
        expect(await emitted()).toBe("");
        await box.append(drop);
        expect(await emitted()).toBe("dropped\n");
        await box.append(reopen);
        expect(await emitted()).toBe("reopened\n");
    });

    test("of several past the cursor only the standing one prints", async () => {
        await box.append(approve, reopen, drop);
        expect(await emitted()).toBe("dropped\n");
        await box.append(approve, drop, reopen);
        expect(await emitted()).toBe("reopened\n");
    });

    test("the user's thread activity on an approved doc reads as reopened, a held draft included", async () => {
        await box.append(approve);
        await emitted();
        await box.comment("cold path", "One more thing");
        expect(await emitted()).toBe('reopened | new c1 "Findings"\n');

        await box.append({ type: "resolve", by: "user", id: "c1" }, drop);
        await emitted();
        await box.comment("Retry queue", "Held", { draft: true });
        const log = await events();
        const last = log.at(-1)!;
        expect(wakeReason(last, foldLog(log))).toBeUndefined();
        expect(docWake(last, foldLog(log))).toBe("reopened");
        expect(await emitted()).toBe("reopened\n");
    });

    test("an agent event on an approved doc wakes nothing", async () => {
        const id = await box.comment("cold path", "Why?");
        await box.append({ type: "resolve", by: "user", id }, approve);
        await emitted();
        await box.append({ type: "reply", by: "agent", id, text: "Noted" });
        const log = await events();
        expect(docWake(log.at(-1)!, foldLog(log))).toBeUndefined();
        expect(await emitted()).toBe("");
    });

    test("a drop leaves waiting threads in the line", async () => {
        await box.comment("cold path", "Why?");
        await box.append(drop);
        expect(await emitted()).toBe('dropped | new c1 "Findings"\n');
    });

    test("finish lists the threads handed over, under no other word", async () => {
        const answered = await box.comment("cold path", "Why?");
        const held = await box.comment("Retry queue", "Held", { draft: true });
        await box.append({ type: "reply", by: "agent", id: answered, text: "Because" });
        await emitted();
        const fresh = await box.comment("Title", "Rename?");
        await box.append({ type: "finish", by: "user", ids: [answered, held, fresh] });
        expect(await emitted()).toBe("finish c1 c2 c3\n");
        expect((await events()).at(-1)).toMatchObject({ type: "cursor", ids: ["c1", "c2", "c3"] });
        expect(await emitted()).toBe("");
    });

    test("finish on a dropped doc leaves reopened out", async () => {
        const id = await box.comment("cold path", "Why?");
        await box.append(drop);
        await emitted();
        await box.append({ type: "finish", by: "user", ids: [id] });
        expect((await box.state()).verdict).toMatchObject({ state: "open", seq: 4 });
        expect(await emitted()).toBe("finish c1\n");
    });

    test("a finish prints only the threads still waiting on the agent", async () => {
        const settled = await box.comment("cold path", "Why?");
        const answered = await box.comment("Retry queue", "Which?");
        const open = await box.comment("Title", "Rename?");
        await emitted();
        await box.append(
            { type: "finish", by: "user", ids: [settled, answered, open] },
            { type: "resolve", by: "agent", id: settled },
            { type: "reply", by: "agent", id: answered, text: "The tile one" },
        );
        expect(await emitted()).toBe("finish c3\n");
    });

    test("a finish whose threads are settled, or that a verdict cleared, prints nothing", async () => {
        const id = await box.comment("cold path", "Why?");
        await emitted();
        await box.append(
            { type: "finish", by: "user", ids: [id] },
            { type: "resolve", by: "agent", id },
        );
        expect(await emitted()).toBe("");
        expect((await box.state()).cursors.watch).toBe(4);

        const next = await box.comment("Retry queue", "Which?");
        await emitted();
        await box.append(
            { type: "finish", by: "user", ids: [next] },
            { ...approve, closed: [next] },
        );
        expect(await emitted()).toBe("approved\n");
    });

    test("a verdict the user did not sign wakes nothing and prints nothing", async () => {
        await box.append({ ...approve, by: "agent" });
        const log = await events();
        expect(docWake(log[0]!, foldLog(log))).toBeUndefined();
        expect(wakeReason(log[0]!, foldLog(log))).toBeUndefined();
        expect(await emitted()).toBe("");
        expect(await events()).toHaveLength(1);
        expect(await watchedQuietly({ ...drop, by: "agent" })).toEqual([]);
    });

    test("a finish the user did not sign wakes nothing and prints nothing", async () => {
        const id = await box.comment("cold path", "Why?");
        await emitted();
        await box.append({ type: "finish", by: "agent", ids: [id] });
        const log = await events();
        expect(wakeReason(log.at(-1)!, foldLog(log))).toBeUndefined();
        expect(docWake(log.at(-1)!, foldLog(log))).toBeUndefined();
        expect(await emitted()).toBe("");
        expect((await events()).at(-1)).toMatchObject({ type: "finish" });
        expect(await watchedQuietly({ type: "finish", by: "agent", ids: [id] })).toEqual([]);
    });

    test("a verdict and a finish each end a waiting watch", async () => {
        const id = await box.comment("cold path", "Why?");
        await emitted();
        const finished = await watchDefault(async () => {
            await box.append({ type: "finish", by: "user", ids: [id] });
        });
        expect(finished.lines).toEqual(["finish c1\n"]);
        const approved = await watchDefault(async () => {
            await box.append({ ...approve, closed: [id] });
        });
        expect(approved.lines).toEqual(["approved\n"]);
    });
});

/** Runs `watch` with its default timing until `act` is done and output has been quiet a while. */
async function watchDefault(act: () => Promise<void>): Promise<{ lines: string[]; ms: number }> {
    const stop = new AbortController();
    const out = collect();
    const running = watch(box.doc, out.write, { signal: stop.signal });
    await Bun.sleep(200);
    const started = Date.now();
    await act();
    while (out.lines.length === 0 && Date.now() - started < 5_000) await Bun.sleep(5);
    const ms = Date.now() - started;
    await Bun.sleep(600);
    stop.abort();
    await running;
    return { lines: out.lines, ms };
}

describe("default timing", () => {
    test("a comment reaches the watch line well under a second", async () => {
        const { lines, ms } = await watchDefault(async () => {
            await box.comment("cold path", "Why?");
        });
        expect(lines).toEqual(['new c1 "Findings"\n']);
        expect(ms).toBeLessThan(1_000);
    });

    test("comments landing back to back are one batch", async () => {
        const { lines } = await watchDefault(async () => {
            await box.comment("cold path", "One");
            await box.comment("Retry queue", "Two");
        });
        expect(lines).toEqual(['new c1 c2 "Findings"\n']);
    });

    test("Send all is one line with every held thread", async () => {
        const { lines } = await watchDefault(async () => {
            const ids = [
                await box.comment("cold path", "One", { draft: true }),
                await box.comment("Retry queue", "Two", { draft: true }),
                await box.comment("first tile", "Three", { draft: true }),
            ];
            await Bun.sleep(DEBOUNCE_MS * 2);
            await box.append({ type: "send", by: "user", ids });
        });
        expect(lines).toEqual(['new c1 c2 c3 "Findings"\n']);
    });
});

describe("re-arming", () => {
    test("a watch stopped before it emits loses nothing; the next one emits the batch once", async () => {
        const stop = new AbortController();
        const first = collect();
        const running = watch(box.doc, first.write, { debounceMs: 60_000, signal: stop.signal });
        await Bun.sleep(200);
        await box.comment("cold path", "One");
        await Bun.sleep(400);
        stop.abort();
        await running;
        expect(first.lines).toEqual([]);

        const second = collect();
        await watch(box.doc, second.write, { debounceMs: 0, once: true });
        expect(second.lines).toHaveLength(1);
        expect(second.lines[0]).toContain("new c1");

        await box.comment("Retry queue", "Two");
        const third = collect();
        await watch(box.doc, third.write, { debounceMs: 0, once: true });
        expect(third.lines).toEqual(['new c2 "Findings"\n']);
    });

    test("two watchers on one doc print each batch once between them", async () => {
        const stop = new AbortController();
        const a = collect();
        const b = collect();
        const options = { debounceMs: 100, signal: stop.signal };
        const running = [watch(box.doc, a.write, options), watch(box.doc, b.write, options)];
        await Bun.sleep(200);
        await box.comment("cold path", "One");
        await Bun.sleep(800);
        await box.comment("Retry queue", "Two");
        await Bun.sleep(800);
        stop.abort();
        await Promise.all(running);
        const all = [...a.lines, ...b.lines].join("");
        expect(all.match(/new c1 /g)).toHaveLength(1);
        expect(all.match(/new c2 /g)).toHaveLength(1);
    });

    test("a watch killed mid-debounce is re-armed without loss or repeat", async () => {
        const env = { ...process.env, ...box.env };
        const killed = Bun.spawn(["bun", MAIN, "watch", box.doc], {
            env: { ...env, MARGIN_DEBOUNCE_MS: "60000" },
            stdout: "pipe",
        });
        await Bun.sleep(400);
        await box.comment("cold path", "One");
        await Bun.sleep(400);
        killed.kill("SIGKILL");
        await killed.exited;
        expect(await new Response(killed.stdout).text()).toBe("");

        const rearmed = Bun.spawnSync(["bun", MAIN, "watch", box.doc, "--once"], { env });
        expect(rearmed.stdout.toString()).toBe('new c1 "Findings"\n');

        const again = Bun.spawn(["bun", MAIN, "watch", box.doc], { env, stdout: "pipe" });
        await Bun.sleep(600);
        again.kill();
        await again.exited;
        expect(await new Response(again.stdout).text()).toBe("");
    });

    test("a steady trickle still flushes at the max wait", async () => {
        const stop = new AbortController();
        const out = collect();
        const running = watch(box.doc, out.write, {
            debounceMs: 400,
            maxWaitMs: 700,
            signal: stop.signal,
        });
        await Bun.sleep(200);
        const started = Date.now();
        let firstSeen: number | undefined;
        for (let i = 0; i < 12; i++) {
            await box.comment(i % 2 ? "cold path" : "Retry queue", `Note ${i}`);
            if (firstSeen === undefined && out.lines.length > 0) firstSeen = Date.now();
            await Bun.sleep(150);
        }
        stop.abort();
        await running;
        expect(firstSeen).toBeDefined();
        expect(firstSeen! - started).toBeLessThan(1_500);
    });
});
