import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyEdit } from "../core/apply.ts";
import type { PendingJson } from "../core/model.ts";
import { pending, pendingWait } from "./pending.ts";
import { sandbox, type Sandbox } from "./testing.ts";

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
                downgraded: false,
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
                downgraded: false,
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
