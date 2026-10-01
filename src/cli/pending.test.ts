import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyEdit } from "../core/apply.ts";
import { readLog } from "../core/log.ts";
import type { Event, PendingJson } from "../core/model.ts";
import { pending, pendingWait } from "./pending.ts";
import { sandbox, type Sandbox } from "./testing.ts";
import { emitWatch } from "./watch.ts";

let box: Sandbox;

beforeEach(() => {
    box = sandbox();
});

afterEach(() => {
    box.cleanup();
});

async function read(): Promise<PendingJson> {
    let out = "";
    await pending(box.doc, { json: true, write: (text) => (out += text) });
    return JSON.parse(out) as PendingJson;
}

async function events(): Promise<Event[]> {
    return (await readLog(box.doc)).events;
}

async function readText(): Promise<string> {
    let out = "";
    await pending(box.doc, { write: (text) => (out += text) });
    return out;
}

async function userEdit(before: string, after: string): Promise<void> {
    const start = box.text().indexOf(before);
    const result = await applyEdit(box.doc, { start, before, after, cause: "user", by: "user" });
    expect(result.ok).toBe(true);
}

describe("pending", () => {
    test("prints capped context and full messages, then claims", async () => {
        await box.comment("cold path", "Why rarely?");
        expect(await readText()).toBe(
            [
                "c1 open L5 Findings",
                "  The cache is warm by the time the first tile renders, so the [[cold path]] rarely runs.",
                "  user: Why rarely?",
                "",
            ].join("\n"),
        );
        const thread = (await box.state()).threads.get("c1")!;
        expect(thread.claimed).toBe(true);
        expect(thread.state).toBe("working");
    });

    test("a claimed thread shows only messages after the agent's last one", async () => {
        const id = await box.comment("cold path", "First");
        await read();
        await box.append(
            { type: "reply", by: "agent", id, text: "Answer" },
            { type: "reply", by: "user", id, text: "Second" },
        );
        const [thread] = (await read()).threads;
        expect(thread!.messages).toEqual([{ by: "user", text: "Second" }]);
    });

    test("after the agent's own suggestion, a reject shows only its note", async () => {
        const id = await box.comment("cold path", "Rename this.");
        await read();
        await box.append(
            {
                type: "suggest",
                by: "agent",
                id,
                replace: "slow path",
                apply: false,
            },
            { type: "reject", by: "user", id, note: "Shorter." },
        );
        const [thread] = (await read()).threads;
        expect(thread!.messages).toEqual([{ by: "user", text: "Shorter." }]);
        expect(thread!.suggestion).toEqual({ replace: "slow path", status: "rejected" });
    });

    test("a suggestion's own note counts as the agent's say", async () => {
        const id = await box.comment("cold path", "Rename this.");
        await read();
        await box.append(
            {
                type: "suggest",
                by: "agent",
                id,
                replace: "x",
                note: "Tried x.",
                apply: false,
            },
            { type: "reply", by: "user", id, text: "Not x." },
        );
        expect((await read()).threads[0]!.messages).toEqual([{ by: "user", text: "Not x." }]);
    });

    test("resolved, replied and draft threads never show", async () => {
        const resolved = await box.comment("cold path", "A");
        const replied = await box.comment("Retry queue", "B");
        await box.comment("first tile", "C", { draft: true });
        await box.append(
            { type: "resolve", by: "user", id: resolved },
            { type: "reply", by: "agent", id: replied, text: "Done" },
        );
        expect(await readText()).toBe("none\n");
    });

    test("table cells carry their header and row", async () => {
        await box.comment("Retry queue", "Which?");
        const [thread] = (await read()).threads;
        expect(thread!.cell).toEqual({ header: "Note", row: "Tiles" });
    });

    test("user edits ride along once, as word-diff hunks without the doc title", async () => {
        await userEdit("rarely runs", "never runs");
        expect((await read()).edits).toEqual([
            {
                path: "Findings",
                line: 5,
                hunks: ["…so the cold path [-rarely-]{+never+} runs."],
            },
        ]);
        expect((await read()).edits).toEqual([]);
    });

    test("an undo folds with the edit it inverts unless the agent already read it", async () => {
        const start = box.text().indexOf("rarely runs");
        const undo = async (of: number, before: string, after: string) => {
            const result = await applyEdit(box.doc, {
                start,
                before,
                after,
                cause: "undo",
                by: "user",
                of,
            });
            expect(result.ok).toBe(true);
            return result.ok && result.status === "changed" ? result.event.seq : 0;
        };
        await userEdit("rarely runs", "never runs");
        const edited = (await events()).at(-1)!.seq;
        const undone = await undo(edited, "never runs", "rarely runs");
        expect((await read()).edits).toEqual([]);
        await undo(undone, "rarely runs", "never runs");
        const [redone] = (await read()).edits;
        expect(redone?.hunks).toEqual(["…so the cold path [-rarely-]{+never+} runs."]);
        expect((await read()).edits).toEqual([]);

        // The agent has read the redo; undoing it again is a change it must see.
        const seq = (await events()).at(-1)!.seq;
        await undo(seq, "never runs", "rarely runs");
        const [shown] = (await read()).edits;
        expect(shown?.hunks).toEqual(["…so the cold path [-never-]{+rarely+} runs."]);
        expect((await read()).edits).toEqual([]);
    });

    test("an undo and its redo after the agent read the edit show nothing", async () => {
        await userEdit("rarely runs", "never runs");
        expect((await read()).edits).toHaveLength(1);
        const start = box.text().indexOf("never runs");
        const edited = (await events()).at(-1)!.seq;
        await applyEdit(box.doc, {
            start,
            before: "never runs",
            after: "rarely runs",
            cause: "undo",
            by: "user",
            of: edited,
        });
        const undone = (await events()).at(-1)!.seq;
        await applyEdit(box.doc, {
            start,
            before: "rarely runs",
            after: "never runs",
            cause: "undo",
            by: "user",
            of: undone,
        });
        expect((await read()).edits).toEqual([]);
    });

    test("agent edits do not ride along", async () => {
        const id = await box.comment("cold path", "Fix");
        const start = box.text().indexOf("cold path");
        await applyEdit(box.doc, {
            start,
            before: "cold path",
            after: "slow path",
            cause: "apply",
            by: "agent",
            id,
        });
        expect((await read()).edits).toEqual([]);
    });

    test("reading twice appends no bookkeeping the second time", async () => {
        await box.comment("cold path", "A");
        await read();
        const version = (await box.state()).version;
        await read();
        expect((await box.state()).version).toBe(version);
    });

    test("a detached thread still shows, marked detached", async () => {
        await box.comment("cold path", "A");
        await userEdit("the cold path rarely runs", "nothing else runs");
        const [thread] = (await read()).threads;
        expect(thread!.detached).toBe(true);
        expect(thread!.quote).toBe("cold path");
    });
});

describe("doc notes", () => {
    test("print as `cN open doc` with no clip line, and are claimed", async () => {
        await box.note("Tighten the whole intro.");
        expect(await readText()).toBe("c1 open doc\n  user: Tighten the whole intro.\n");
        const thread = (await box.state()).threads.get("c1")!;
        expect(thread.claimed).toBe(true);
        expect(thread.state).toBe("working");
    });

    test("the JSON marks them and never calls them detached", async () => {
        await box.note("Overall?");
        await box.comment("cold path", "Why?");
        const [note, anchored] = (await read()).threads;
        expect(note).toMatchObject({ id: "c1", doc: true, detached: false, path: "", line: 0 });
        expect(note!.quote).toBe("");
        expect(anchored).not.toHaveProperty("doc");
    });

    test("a held doc note waits for send all", async () => {
        await box.note("Later", { draft: true });
        expect(await readText()).toBe("none\n");
        await box.append({ type: "send", by: "user", ids: ["c1"] });
        expect((await read()).threads.map((thread) => thread.id)).toEqual(["c1"]);
    });
});

describe("pending --wait", () => {
    test("returns at once for a backlog", async () => {
        await box.comment("cold path", "A");
        let out = "";
        await pendingWait(box.doc, { debounceMs: 0, write: (text) => (out += text) });
        expect(out).toContain("c1 open");
    });

    test("blocks until a wake, not an edit", async () => {
        let out = "";
        const waiting = pendingWait(box.doc, { debounceMs: 0, write: (text) => (out += text) });
        await Bun.sleep(300);
        await userEdit("rarely runs", "never runs");
        await Bun.sleep(400);
        expect(out).toBe("");
        await box.comment("Retry queue", "B");
        await waiting;
        expect(out).toContain("c1 open");
        expect(out).toContain("edit L5 Findings");
    });

    test("waits again once the backlog has been read", async () => {
        await box.comment("cold path", "A");
        await read();
        const stop = new AbortController();
        let out = "";
        const waiting = pendingWait(box.doc, {
            debounceMs: 0,
            signal: stop.signal,
            write: (text) => (out += text),
        });
        await Bun.sleep(400);
        stop.abort();
        expect(await waiting).toBe(false);
        expect(out).toBe("");
    });
});

describe("deleted threads", () => {
    test("are neither pending nor in a watch batch, and come back on undelete", async () => {
        await box.comment("cold path", "Why?");
        const id = await box.comment("Retry queue", "Which queue?");
        await box.append({ type: "delete", by: "user", id });
        let line = "";
        await emitWatch(box.doc, (text) => (line += text));
        expect(line).toBe('new c1 "Findings"\n');
        expect((await read()).threads.map((thread) => thread.id)).toEqual(["c1"]);

        await box.append({ type: "undelete", by: "user", id });
        expect((await read()).threads.map((thread) => thread.id)).toEqual(["c1", id]);
    });
});
