import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAnchor } from "../src/core/anchor.ts";
import { decodeSource, hashText } from "../src/core/blocks.ts";
import { isUnresolved, type Thread, type ThreadId } from "../src/core/model.ts";
import { attachScriptedAgent, proposeEdit } from "./agent.ts";
import { MemoryStore, type Clock, type DocWake, type Wake } from "./memory-store.ts";
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

describe("memory store verdict and finish", () => {
    /** No scripted agent: the tests play the agent, so nothing moves on its own. */
    function bare() {
        const store = new MemoryStore("doc.md", doc, new ManualClock());
        const wakes: Wake[] = [];
        const docWakes: DocWake[] = [];
        store.onWake = (batch) => wakes.push(...batch);
        store.onVerdict = (reason) => docWakes.push(reason);
        return { store, wakes, docWakes };
    }

    test("approve is refused while threads are unresolved, and names them", async () => {
        const { store, docWakes } = bare();
        const open = await store.comment({ anchor: anchorOn(store, "Title"), text: "Rename?" });
        const replied = await store.comment({ text: "A doc note" });
        store.agentReply(replied, "Noted.");
        const gone = await store.comment({ anchor: anchorOn(store, "aside"), text: "Drop" });
        await store.deleteThread(gone);
        expect(await store.setVerdict({ state: "approved" })).toEqual({
            ok: false,
            reason: "unresolved",
            ids: [open, replied],
        });
        expect(store.snapshot().verdict).toBeUndefined();
        await store.resolve(open);
        await store.resolve(replied);
        expect(await store.setVerdict({ state: "approved", note: "Ship it" })).toEqual({
            ok: true,
        });
        const { verdict, version, doc: parsed } = store.snapshot();
        expect(verdict).toMatchObject({
            state: "approved",
            seq: version,
            hash: hashText(parsed.source),
            note: "Ship it",
        });
        expect(verdict?.closed).toBeUndefined();
        expect(docWakes).toEqual(["approved"]);
    });

    test("approve as is closes every unresolved thread and applies no suggestion", async () => {
        const { store, wakes } = bare();
        const suggested = await store.comment({ anchor: anchorOn(store, quote), text: "Shorter" });
        store.agentSuggest(suggested, "Shorter.", { apply: false });
        await store.setHold(true);
        const draft = await store.comment({ anchor: anchorOn(store, "Title"), text: "Held" });
        const done = await store.comment({ text: "Already settled" });
        await store.resolve(done);
        wakes.length = 0;
        expect(await store.setVerdict({ state: "approved", asIs: true })).toEqual({ ok: true });
        expect(store.snapshot().threads.map((each) => each.state)).toEqual([
            "resolved",
            "resolved",
            "resolved",
        ]);
        expect(thread(store, suggested).suggestion?.status).toBe("rejected");
        expect(store.snapshot().doc.source).toBe(doc);
        expect(store.snapshot().verdict).toMatchObject({
            state: "approved",
            closed: [suggested, draft],
        });
        expect(wakes).toEqual([]);
    });

    test("drop leaves open threads alone; reopen goes back to open and says so once", async () => {
        const { store, docWakes } = bare();
        const id = await store.comment({ anchor: anchorOn(store, "Title"), text: "Rename?" });
        expect(await store.setVerdict({ state: "open" })).toEqual({ ok: true });
        expect(store.snapshot().verdict).toBeUndefined();
        expect(await store.setVerdict({ state: "dropped", asIs: true })).toEqual({ ok: true });
        expect(thread(store, id).state).toBe("open");
        expect(store.snapshot().verdict).toMatchObject({ state: "dropped" });
        expect(store.snapshot().verdict?.closed).toBeUndefined();
        await store.setVerdict({ state: "open" });
        expect(store.snapshot().verdict).toMatchObject({ state: "open" });
        await store.setVerdict({ state: "open" });
        expect(docWakes).toEqual(["dropped", "reopened"]);
    });

    test("an edit never clears the verdict; its hash tells the doc changed since", async () => {
        const { store } = bare();
        await store.setVerdict({ state: "approved" });
        const start = doc.indexOf(quote);
        await store.saveUnit({ start, before: quote, after: "Rewritten." });
        const changed = store.snapshot();
        expect(changed.verdict?.state).toBe("approved");
        expect(changed.verdict?.hash).not.toBe(hashText(changed.doc.source));
        await store.saveUnit({ start, before: "Rewritten.", after: quote });
        expect(store.snapshot().verdict?.hash).toBe(hashText(store.snapshot().doc.source));
    });

    test("the user's thread activity reopens an approved or dropped doc", async () => {
        const anchor = (store: MemoryStore) => anchorOn(store, "Title");
        const acts: [string, (store: MemoryStore, id: ThreadId) => Promise<unknown>][] = [
            ["comment", (store) => store.comment({ text: "One more" })],
            ["suggest", (store) => store.suggest({ anchor: anchor(store), replace: "Heading" })],
            ["reply", (store, id) => store.reply(id, "Actually")],
            ["reject with a note", (store, id) => store.reject(id, "Try again")],
            ["reopen", (store, id) => store.reopen(id)],
        ];
        for (const [name, act] of acts) {
            const { store, docWakes } = bare();
            const id = await store.comment({ anchor: anchor(store), text: "Rename?" });
            await store.resolve(id);
            await store.setVerdict({ state: "approved", note: "Ship it" });
            await act(store, id);
            const { verdict, version } = store.snapshot();
            expect([name, verdict]).toEqual([
                name,
                { state: "open", seq: version, at: verdict!.at },
            ]);
            expect(docWakes).toEqual(["approved", "reopened"]);
        }
    });

    test("undeleting reopens only for an unresolved thread; agent activity never does", async () => {
        const { store, docWakes } = bare();
        const settled = await store.comment({ text: "Settled" });
        await store.resolve(settled);
        await store.deleteThread(settled);
        const waiting = await store.comment({ text: "Waiting" });
        await store.deleteThread(waiting);
        await store.setVerdict({ state: "approved" });
        await store.undeleteThread(settled);
        await store.resolve(settled);
        await store.reject(settled);
        store.agentFind({ start: doc.indexOf("Title"), end: doc.indexOf("Title") + 5 }, "Heading", {
            apply: false,
            note: "Clearer",
        });
        expect(store.snapshot().verdict?.state).toBe("approved");
        await store.undeleteThread(waiting);
        expect(store.snapshot().verdict?.state).toBe("open");
        expect(docWakes).toEqual(["approved", "reopened"]);
    });

    test("finish accepts agent suggestions, sends drafts and hands over the rest", async () => {
        const { store, wakes } = bare();
        const accepted = await store.comment({ anchor: anchorOn(store, quote), text: "Shorter" });
        store.agentSuggest(accepted, "Shorter.", { apply: false });
        const own = await store.suggest({ anchor: anchorOn(store, "Title"), replace: "Heading" });
        const replied = await store.comment({ text: "A doc note" });
        store.agentClaim([replied]);
        store.agentReply(replied, "Noted.");
        const working = await store.comment({ text: "Another note" });
        store.agentClaim([working]);
        await store.setHold(true);
        const draft = await store.comment({ anchor: anchorOn(store, "aside"), text: "Held" });
        const done = await store.comment({ text: "Settled" });
        await store.resolve(done);
        wakes.length = 0;

        expect(await store.requestFinish()).toEqual({
            ids: [own, replied, working, draft],
            unapplied: [],
        });
        const snapshot = store.snapshot();
        expect(thread(store, accepted)).toMatchObject({ state: "resolved" });
        expect(thread(store, accepted).suggestion?.status).toBe("accepted");
        expect(snapshot.doc.source).toContain("Shorter.");
        expect(snapshot.doc.source).toContain("# Title");
        expect(thread(store, own).suggestion?.status).toBe("pending");
        for (const id of [own, replied, working, draft]) {
            expect(thread(store, id).state).toBe("open");
        }
        expect(thread(store, replied).claimed).toBe(true);
        expect(snapshot.finish).toMatchObject({ seq: snapshot.version, ids: snapshot.finish!.ids });
        expect(snapshot.finish?.ids).toEqual([own, replied, working, draft]);
        expect(snapshot.verdict).toBeUndefined();
        expect(wakes).toEqual(
            [own, replied, working, draft].map((id) => ({ id, reason: "finish" as const })),
        );
    });

    test("a suggestion that no longer applies stays pending and is reported", async () => {
        const { store } = bare();
        const id = await store.comment({ anchor: anchorOn(store, "aside"), text: "Reword" });
        store.agentSuggest(id, "remark", { apply: false });
        const start = doc.indexOf("A second paragraph");
        const before = "A second paragraph (with an aside in it) sits here.";
        await store.saveUnit({ start, before, after: "A second paragraph sits here." });
        expect(thread(store, id).detached).toBe(true);
        expect(await store.requestFinish()).toEqual({ ids: [id], unapplied: [id] });
        expect(thread(store, id)).toMatchObject({ state: "open" });
        expect(thread(store, id).suggestion?.status).toBe("pending");
    });

    test("a finish request stays until a verdict, and is done once the agent settles it", async () => {
        const { store, wakes, docWakes } = bare();
        expect(await store.requestFinish()).toEqual({ ids: [], unapplied: [] });
        expect(store.snapshot().finish).toBeUndefined();
        expect(wakes).toEqual([]);

        const id = await store.comment({ text: "Sort this out" });
        await store.setVerdict({ state: "dropped" });
        await store.requestFinish();
        expect(store.snapshot().verdict?.state).toBe("open");
        expect(docWakes).toEqual(["dropped", "reopened"]);
        expect(await store.setVerdict({ state: "approved" })).toMatchObject({ ok: false });

        store.agentResolve(id);
        const settled = store.snapshot();
        expect(settled.finish?.ids).toEqual([id]);
        expect(settled.threads.filter(isUnresolved)).toEqual([]);
        expect(await store.setVerdict({ state: "approved" })).toEqual({ ok: true });
        expect(store.snapshot().finish).toBeUndefined();
    });
});

describe("scripted agent", () => {
    test("settles every thread of a finish request, so the doc can be approved", async () => {
        const { store, clock } = setup();
        const first = await store.comment({ text: "Sort this out" });
        clock.advance(1_000);
        expect(thread(store, first).state).toBe("replied");
        await store.setHold(true);
        const held = await store.comment({
            anchor: anchorOn(store, "something plain"),
            text: "And this",
        });
        expect(thread(store, held).state).toBe("draft");

        expect((await store.requestFinish()).ids).toEqual([first, held]);
        clock.advance(5_000);
        expect(store.snapshot().threads.filter(isUnresolved)).toEqual([]);
        expect(thread(store, held).messages.at(-1)?.by).toBe("agent");
        expect(await store.setVerdict({ state: "approved" })).toEqual({ ok: true });
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
