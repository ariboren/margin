import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readLog } from "../core/log.ts";
import type { Event } from "../core/model.ts";
import { sandbox, type Sandbox } from "./testing.ts";
import { emitWatch, wakeReason, watch } from "./watch.ts";

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
    test("new comment, user reply and reject with note wake; the rest never do", async () => {
        const id = await box.comment("cold path", "Why rarely?");
        await box.append(
            { type: "reply", by: "user", id, text: "Also this" },
            { type: "reply", by: "agent", id, text: "Checking" },
            { type: "reject", by: "user", id, note: "Not that" },
            { type: "reject", by: "user", id },
            { type: "accept", by: "user", id },
            { type: "resolve", by: "user", id },
            { type: "reopen", by: "user", id },
        );
        await box.comment("first tile", "Draft", { draft: true });
        const reasons = (await events()).map((event) => [event.type, wakeReason(event) ?? null]);
        expect(reasons).toEqual([
            ["comment", "new"],
            ["reply", "reply"],
            ["reply", null],
            ["reject", "rejected"],
            ["reject", null],
            ["accept", null],
            ["resolve", null],
            ["reopen", null],
            ["comment", null],
        ]);
    });

    test("user edits never wake, and neither does a batch whose threads are done", async () => {
        const id = await box.comment("cold path", "Why?");
        await box.append({ type: "resolve", by: "user", id });
        const out = collect();
        expect(await emitWatch(box.doc, out.write)).toBe(false);
        expect(out.lines).toEqual([]);
        // The cursor still moved past the batch, so it is never reconsidered.
        expect((await box.state()).cursors.watch).toBe(2);
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

    test("send wakes drafts", async () => {
        const id = await box.comment("cold path", "Held", { draft: true });
        await box.append({ type: "send", by: "user", ids: [id] });
        const out = collect();
        await emitWatch(box.doc, out.write);
        expect(out.lines).toEqual(['new c1 "Findings"\n']);
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
