import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAnchor } from "../src/core/anchor.ts";
import { decodeSource } from "../src/core/blocks.ts";
import type { Thread, ThreadId } from "../src/core/model.ts";
import { attachScriptedAgent, proposeEdit } from "./agent.ts";
import { MemoryStore, type Clock } from "./memory-store.ts";
import { planSeeds } from "./seed.ts";

class ManualClock implements Clock {
    private time = Date.parse("2026-09-30T12:00:00Z");
    private queue: { at: number; run: () => void }[] = [];
    now(): number {
        return this.time;
    }
    schedule(run: () => void, ms: number): void {
        this.queue.push({ at: this.time + ms, run });
    }
    advance(ms: number): void {
        const until = this.time + ms;
        for (;;) {
            this.queue.sort((a, b) => a.at - b.at);
            const next = this.queue[0];
            if (!next || next.at > until) {
                break;
            }
            this.queue.shift();
            this.time = next.at;
            next.run();
        }
        this.time = until;
    }
}

const doc = [
    "# Title",
    "",
    "The first paragraph says something plain, and then it adds a trailing clause.",
    "",
    "A second paragraph (with an aside in it) sits here.",
    "",
    "| Name | Note |",
    "| ---- | ---- |",
    "| one  | two  |",
    "",
].join("\n");

function setup() {
    const clock = new ManualClock();
    const store = new MemoryStore("doc.md", doc, clock);
    attachScriptedAgent(store, clock, { claim: 100, answer: 200 });
    return { store, clock };
}

function anchorOn(store: MemoryStore, text: string) {
    const { source } = store.snapshot().doc;
    const start = source.indexOf(text);
    return createAnchor(source, { start, end: start + text.length });
}

function thread(store: MemoryStore, id: ThreadId): Thread {
    return store.snapshot().threads.find((candidate) => candidate.id === id)!;
}

const quote = "The first paragraph says something plain, and then it adds a trailing clause.";

describe("memory store", () => {
    test("comment wakes the scripted agent, which claims then replies", async () => {
        const { store, clock } = setup();
        const id = await store.comment({
            anchor: anchorOn(store, "something plain"),
            text: "Is this right?",
        });
        expect(thread(store, id).state).toBe("open");
        clock.advance(100);
        expect(thread(store, id).state).toBe("working");
        expect(store.snapshot().agentSeenAt).toBeDefined();
        clock.advance(300);
        expect(thread(store, id).state).toBe("replied");
        expect(thread(store, id).messages.map((message) => message.by)).toEqual(["user", "agent"]);
    });

    test("accepting an agent suggestion splices only the quote", async () => {
        const { store, clock } = setup();
        const id = await store.comment({
            anchor: anchorOn(store, quote),
            text: "Could this be shorter?",
        });
        clock.advance(400);
        const suggestion = thread(store, id).suggestion!;
        expect(suggestion).toMatchObject({ by: "agent", status: "pending" });
        expect(await store.accept(id)).toEqual({ ok: true });
        const after = store.snapshot().doc.source;
        const start = doc.indexOf(quote);
        expect(after.slice(0, start)).toBe(doc.slice(0, start));
        expect(after.slice(start, start + suggestion.replace.length)).toBe(suggestion.replace);
        expect(after.slice(start + suggestion.replace.length)).toBe(
            doc.slice(start + quote.length),
        );
        expect(thread(store, id).state).toBe("resolved");
    });

    test("reject with a note reopens and wakes; without a note resolves", async () => {
        const { store, clock } = setup();
        const id = await store.comment({ anchor: anchorOn(store, quote), text: "Tighten this" });
        clock.advance(400);
        await store.reject(id, "Keep the clause, cut something else");
        expect(thread(store, id).state).toBe("open");
        clock.advance(400);
        expect(thread(store, id).state).toBe("replied");
        const other = await store.suggest({ anchor: anchorOn(store, "Title"), replace: "Heading" });
        await store.reject(other);
        expect(thread(store, other).state).toBe("resolved");
        expect(store.snapshot().doc.source).toContain("# Title");
    });

    test("saveUnit is compare-and-swap and records user edits", async () => {
        const { store } = setup();
        const start = doc.indexOf(quote);
        expect(await store.saveUnit({ start, before: "stale text", after: "x" })).toMatchObject({
            ok: false,
            reason: "conflict",
        });
        expect(store.snapshot().doc.source).toBe(doc);
        expect(await store.saveUnit({ start, before: quote, after: quote })).toEqual({ ok: true });
        expect(store.snapshot().edits).toHaveLength(0);
        expect(await store.saveUnit({ start, before: quote, after: "Rewritten." })).toEqual({
            ok: true,
        });
        const [edit] = store.snapshot().edits;
        expect(edit).toMatchObject({
            cause: "user",
            by: "user",
            before: quote,
            after: "Rewritten.",
        });
        const id = await store.followThrough(edit!.seq, "Carry this through");
        expect(thread(store, id)).toMatchObject({ followsEdit: edit!.seq, detached: false });
    });

    test("table cell saves go through cell encoding", async () => {
        const { store } = setup();
        const start = doc.indexOf("two");
        expect(await store.saveUnit({ start, before: "two", after: "a | b" })).toEqual({
            ok: true,
        });
        expect(store.snapshot().doc.source).toContain("| one  | a \\| b  |");
    });

    test("auto-apply lands an agent edit that revert restores byte for byte", async () => {
        const { store, clock } = setup();
        await store.setSetting("autoApply", true);
        const id = await store.comment({ anchor: anchorOn(store, quote), text: "Shorter please" });
        clock.advance(400);
        const applied = thread(store, id).applied!;
        expect(applied).toMatchObject({ before: quote, reverted: false });
        expect(store.snapshot().doc.source).not.toBe(doc);
        expect(await store.revert(id)).toEqual({ ok: true });
        expect(store.snapshot().doc.source).toBe(doc);
        expect(thread(store, id).applied?.reverted).toBe(true);
    });

    test("without auto-apply an agent edit arrives as a suggestion", async () => {
        const { store, clock } = setup();
        const id = await store.comment({ anchor: anchorOn(store, quote), text: "Shorter please" });
        clock.advance(400);
        expect(store.snapshot().doc.source).toBe(doc);
        expect(thread(store, id).suggestion?.status).toBe("pending");
        expect(thread(store, id).applied).toBeUndefined();
    });

    test("hold keeps drafts quiet until send all", async () => {
        const { store, clock } = setup();
        await store.setHold(true);
        const id = await store.comment({ anchor: anchorOn(store, "Title"), text: "Later" });
        clock.advance(1000);
        expect(thread(store, id).state).toBe("draft");
        await store.sendAll();
        expect(thread(store, id).state).toBe("open");
        clock.advance(100);
        expect(thread(store, id).state).toBe("working");
    });

    test("an edit elsewhere keeps anchors attached; removing the quote detaches", async () => {
        const { store } = setup();
        const id = await store.comment({ anchor: anchorOn(store, "an aside"), text: "?" });
        const start = doc.indexOf(quote);
        await store.saveUnit({ start, before: quote, after: "Short." });
        expect(thread(store, id).detached).toBe(false);
        const source = store.snapshot().doc.source;
        const para = "A second paragraph (with an aside in it) sits here.";
        await store.saveUnit({ start: source.indexOf(para), before: para, after: "Gone." });
        expect(thread(store, id).detached).toBe(true);
    });

    test("ageWorking makes working threads read as stalled", async () => {
        const { store, clock } = setup();
        const id = await store.comment({ anchor: anchorOn(store, "Title"), text: "?" });
        clock.advance(100);
        store.ageWorking(11 * 60_000);
        expect(clock.now() - Date.parse(thread(store, id).lastActivity)).toBeGreaterThan(
            10 * 60_000,
        );
    });
});

describe("proposeEdit", () => {
    test("drops an aside, then a filler word, then a trailing clause", () => {
        expect(proposeEdit("A thing (an aside) here.")).toBe("A thing here.");
        expect(proposeEdit("It is very fast.")).toBe("It is fast.");
        expect(proposeEdit("Plain words first, then the clause.")).toBe("Plain words first.");
        expect(proposeEdit("Nothing to cut")).toBeNull();
    });
});

const samples = ["fixtures/public-sample.md", "fixtures/private/sample.md"].map((path) =>
    join(import.meta.dir, "..", path),
);

describe("seeds", () => {
    for (const path of samples) {
        test.skipIf(!existsSync(path))(
            `cover every thread state on ${path.split("/fixtures/")[1]}`,
            () => {
                const store = new MemoryStore("sample.md", decodeSource(readFileSync(path)));
                const seeds = planSeeds(store.snapshot().doc);
                store.seed(seeds.threads, seeds.edits);
                const { threads, edits } = store.snapshot();
                const states = new Set(threads.map((candidate) => candidate.state));
                for (const state of ["open", "working", "replied", "resolved"] as const) {
                    expect(states.has(state)).toBe(true);
                }
                expect(threads.some((candidate) => candidate.detached)).toBe(true);
                expect(
                    threads.some((candidate) => candidate.suggestion?.status === "pending"),
                ).toBe(true);
                expect(
                    threads.some((candidate) => candidate.applied && !candidate.applied.reverted),
                ).toBe(true);
                expect(threads.filter((candidate) => candidate.detached)).toHaveLength(1);
                expect(edits.some((edit) => edit.cause === "user")).toBe(true);
            },
        );
    }
});
