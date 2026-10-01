import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { applyEdit } from "../core/apply.ts";
import { decodeSource, hashText } from "../core/blocks.ts";
import { readLog } from "../core/log.ts";
import type { Event, EventInput, PendingJson, ThreadId } from "../core/model.ts";
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

describe("review header", () => {
    /** The hash a verdict records: `hashText` of the decoded source, as `viewOf` reads it. */
    function docHash(): string {
        return hashText(decodeSource(readFileSync(box.doc)));
    }

    async function verdict(
        state: "approved" | "declined" | "open",
        extra: { note?: string; closed?: ThreadId[] } = {},
    ): Promise<void> {
        await box.append({ type: "verdict", by: "user", state, hash: docHash(), ...extra });
    }

    test("an open doc has none, and none stays none", async () => {
        expect(await readText()).toBe("none\n");
        expect(await read()).toEqual({ threads: [], edits: [] });
    });

    test("an approved doc says so on every read, alone when nothing waits", async () => {
        await verdict("approved");
        expect(await readText()).toBe("approved\n");
        expect(await readText()).toBe("approved\n");
        expect((await read()).review).toEqual({ verdict: "approved" });
    });

    test("the note follows a colon, on one line", async () => {
        await verdict("approved", { note: "Ship it" });
        expect(await readText()).toBe("approved: Ship it\n");
        expect((await read()).review).toEqual({ verdict: "approved", note: "Ship it" });
        await verdict("declined", { note: "Not now\nmaybe later" });
        expect(await readText()).toBe("declined: Not now\\nmaybe later\n");
    });

    test("changed is the verdict's hash against hashText of the source as read", async () => {
        await verdict("approved", { note: "Go" });
        expect((await read()).review).toEqual({ verdict: "approved", note: "Go" });
        await userEdit("rarely runs", "never runs");
        expect(await readText()).toStartWith("approved changed: Go\nedit L5 Findings\n");
        expect((await read()).review).toEqual({ verdict: "approved", changed: true, note: "Go" });
        await userEdit("never runs", "rarely runs");
        expect((await read()).review).toEqual({ verdict: "approved", note: "Go" });
    });

    test("a BOM and CRLF doc approved at its own hash is not changed", async () => {
        box.cleanup();
        box = sandbox("\uFEFF# Title\r\n\r\nThe cold path rarely runs.");
        await verdict("approved");
        expect(await readText()).toBe("approved\n");
    });

    test("a declined doc never says changed, and a missing doc says nothing of it", async () => {
        await verdict("declined");
        await userEdit("rarely runs", "never runs");
        expect((await read()).review).toEqual({ verdict: "declined" });
        await verdict("approved");
        rmSync(box.doc);
        expect((await read()).review).toEqual({ verdict: "approved" });
    });

    test("a decline leaves its threads under the header", async () => {
        await box.comment("cold path", "Why?");
        await verdict("declined");
        expect(await readText()).toStartWith("declined\nc1 open L5 Findings\n");
    });

    test("reopened is said once, to the read whose cursor it is past", async () => {
        await verdict("approved");
        await read();
        await verdict("open");
        expect(await readText()).toBe("reopened\n");
        expect(await readText()).toBe("none\n");

        await verdict("approved");
        await box.comment("cold path", "One more thing");
        expect((await read()).review).toEqual({ reopened: true });
        expect((await read()).review).toBeUndefined();
    });

    test("finish heads every read while a handed thread waits on the agent", async () => {
        const answered = await box.comment("cold path", "First");
        await read();
        await box.append({ type: "reply", by: "agent", id: answered, text: "Answer" });
        const held = await box.comment("Retry queue", "Held", { draft: true });
        await box.append({ type: "finish", by: "user", ids: [answered, held] });

        const first = await read();
        expect(first.review).toEqual({ finish: true });
        // The thread the agent had answered comes back with nothing new to read.
        expect(first.threads.map((thread) => [thread.id, thread.messages])).toEqual([
            ["c1", []],
            ["c2", [{ by: "user", text: "Held" }]],
        ]);
        expect(await readText()).toStartWith("finish\nc1 working L5 Findings\n");

        await box.append({ type: "resolve", by: "agent", id: answered });
        expect((await read()).review).toEqual({ finish: true });
        // Answered without resolving: it waits on the user, so the request is no longer said.
        await box.append({ type: "reply", by: "agent", id: held, text: "Done" });
        expect(await readText()).toBe("none\n");
    });

    test("a finish that reopened a declined doc says finish, then nothing once settled", async () => {
        const id = await box.comment("cold path", "Why?");
        await verdict("declined");
        await box.append({ type: "finish", by: "user", ids: [id] });
        expect((await read()).review).toEqual({ finish: true });
        await box.append({ type: "resolve", by: "agent", id });
        expect(await readText()).toBe("none\n");
        await verdict("approved");
        expect(await readText()).toBe("approved\n");
    });
});

describe("a declined doc", () => {
    const decline = { type: "verdict", by: "user", state: "declined", hash: "h" } as const;
    const reopen = { type: "verdict", by: "user", state: "open", hash: "h" } as const;

    test("shows its waiting threads and edits but claims nothing; the first read after a reopen claims them once", async () => {
        const taken = await box.comment("cold path", "Why?");
        await read();
        await box.comment("Retry queue", "Which queue?");
        await userEdit("rarely runs", "never runs");
        await box.append(decline);

        const first = await readText();
        expect(first).toStartWith("declined\nc1 working L5 Findings\n");
        expect(first).toContain("c2 open L");
        expect(first).toContain("  user: Which queue?");
        expect(first).toContain("edit L5 Findings");
        // The edit rode along with that read; the unclaimed thread prints in full again.
        const second = await readText();
        expect(second).toContain("  user: Which queue?");
        expect(second).not.toContain("edit L");

        let log = await events();
        expect(log.filter((event) => event.type === "claim")).toHaveLength(1);
        expect(log.at(-1)).toMatchObject({ type: "cursor", stream: "pending", ids: ["c1", "c2"] });
        let state = await box.state();
        expect(state.threads.get("c2")).toMatchObject({ state: "open", claimed: false });
        expect(state.threads.get(taken)!.state).toBe("working");

        await box.append(reopen);
        const after = await read();
        expect(after.review).toEqual({ reopened: true });
        expect(after.edits).toEqual([]);
        expect(after.threads.map((thread) => [thread.id, thread.messages])).toEqual([
            ["c1", [{ by: "user", text: "Why?" }]],
            ["c2", [{ by: "user", text: "Which queue?" }]],
        ]);
        log = await events();
        expect(log.filter((event) => event.type === "claim").map((event) => event.ids)).toEqual([
            ["c1"],
            ["c2"],
        ]);
        state = await box.state();
        expect(state.threads.get("c2")).toMatchObject({ state: "working", claimed: true });

        const settled = await events();
        expect(await read()).toMatchObject({ edits: [] });
        expect(await events()).toHaveLength(settled.length);
    });

    test("--wait reads it the same way, and blocks again until the reopen", async () => {
        await box.comment("cold path", "Why?");
        await box.append(decline);
        let out = "";
        await pendingWait(box.doc, { debounceMs: 0, write: (text) => (out += text) });
        expect(out).toStartWith("declined\nc1 open L5 Findings\n");
        expect((await events()).some((event) => event.type === "claim")).toBe(false);
        expect((await box.state()).threads.get("c1")!.state).toBe("open");

        out = "";
        const waiting = pendingWait(box.doc, { debounceMs: 0, write: (text) => (out += text) });
        await Bun.sleep(400);
        expect(out).toBe("");
        await box.append(reopen);
        expect(await waiting).toBe(true);
        expect(out).toStartWith("reopened\nc1 open L5 Findings\n");
        expect((await box.state()).threads.get("c1")).toMatchObject({
            state: "working",
            claimed: true,
        });
    });
});

describe("pending --wait", () => {
    test("a verdict and a finish each unblock it", async () => {
        const id = await box.comment("cold path", "A");
        await read();
        const steps: [EventInput, string][] = [
            [{ type: "finish", by: "user", ids: [id] }, "finish\nc1 open"],
            [
                { type: "verdict", by: "user", state: "approved", hash: "h", closed: [id] },
                "approved",
            ],
            [{ type: "verdict", by: "user", state: "open", hash: "h" }, "reopened\n"],
        ];
        for (const [input, text] of steps) {
            let out = "";
            const waiting = pendingWait(box.doc, {
                debounceMs: 0,
                write: (chunk) => (out += chunk),
            });
            await Bun.sleep(300);
            expect(out).toBe("");
            await box.append(input);
            expect(await waiting).toBe(true);
            expect(out).toStartWith(text);
        }
    });

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

    test("a verdict or a finish the user did not sign, or a verdict in an unknown state, leaves it blocked", async () => {
        const id = await box.comment("cold path", "A");
        await read();
        const steps: EventInput[] = [
            { type: "verdict", by: "agent", state: "approved", hash: "h", closed: [id] },
            { type: "finish", by: "agent", ids: [id] },
            { type: "verdict", by: "user", state: "shelved", hash: "h" } as unknown as EventInput,
        ];
        for (const input of steps) {
            const stop = new AbortController();
            let out = "";
            const waiting = pendingWait(box.doc, {
                debounceMs: 0,
                signal: stop.signal,
                write: (chunk) => (out += chunk),
            });
            await Bun.sleep(300);
            await box.append(input);
            await Bun.sleep(400);
            stop.abort();
            expect(await waiting).toBe(false);
            expect(out).toBe("");
        }
        expect((await read()).review).toBeUndefined();
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
