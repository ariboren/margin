import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readLog } from "../core/log.ts";
import { applyEdit } from "../core/apply.ts";
import { DocSession } from "../server/session.ts";
import type { Ack, EventInput, ShowOutput } from "../core/model.ts";
import { reply, resolveThread, show, suggest } from "./commands.ts";
import { formatShow } from "./format.ts";
import { DOC, sandbox, type Sandbox } from "./testing.ts";

let box: Sandbox;

beforeEach(() => {
    box = sandbox();
});

afterEach(() => {
    box.cleanup();
});

describe("reply and resolve", () => {
    test("reply appends an agent message; --resolve also resolves", async () => {
        const id = await box.comment("cold path", "Why?");
        expect(await reply(box.doc, id, "Because")).toEqual({ ok: true, id, state: "replied" });
        expect(await reply(box.doc, id, "Done", { resolve: true })).toEqual({
            ok: true,
            id,
            state: "resolved",
        });
        const thread = (await box.state()).threads.get(id)!;
        expect(thread.state).toBe("resolved");
        expect(thread.messages.map((m) => [m.by, m.text])).toEqual([
            ["user", "Why?"],
            ["agent", "Because"],
            ["agent", "Done"],
        ]);
    });

    test("unknown and resolved threads are refused", async () => {
        expect(await reply(box.doc, "c9", "Hi")).toEqual({
            ok: false,
            id: "c9",
            error: "not-found",
        });
        const id = await box.comment("cold path", "Why?");
        await resolveThread(box.doc, id);
        expect(await reply(box.doc, id, "Late")).toMatchObject({ ok: false, error: "resolved" });
    });

    test("resolve is idempotent", async () => {
        const id = await box.comment("cold path", "Why?");
        await resolveThread(box.doc, id);
        const version = (await box.state()).version;
        expect(await resolveThread(box.doc, id)).toEqual({ ok: true, id, state: "resolved" });
        expect((await box.state()).version).toBe(version);
    });
});

describe("suggest", () => {
    test("defaults to a suggestion and leaves the file alone", async () => {
        const id = await box.comment("cold path", "Rename");
        expect(await suggest(box.doc, { id, replace: "slow path", apply: false })).toEqual({
            ok: true,
            id,
            state: "replied",
        });
        expect(box.text()).toBe(DOC);
        expect((await box.state()).threads.get(id)!.suggestion).toMatchObject({
            replace: "slow path",
            status: "pending",
        });
    });

    test("--apply splices through applyEdit and marks the thread changed by agent", async () => {
        const id = await box.comment("cold path", "Rename");
        await suggest(box.doc, { id, replace: "slow path", apply: true, note: "Renamed" });
        expect(box.text()).toBe(DOC.replace("cold path", "slow path"));
        const thread = (await box.state()).threads.get(id)!;
        expect(thread.applied).toMatchObject({ before: "cold path", after: "slow path" });
        expect(thread.anchor!.exact).toBe("slow path");
        expect(thread.messages.at(-1)).toMatchObject({ by: "agent", text: "Renamed" });
    });

    test("the doc's auto-apply applies without --apply", async () => {
        const id = await box.comment("cold path", "Rename");
        await box.append({ type: "setting", by: "user", key: "autoApply", value: true });
        expect(await suggest(box.doc, { id, replace: "slow path", apply: false })).toEqual({
            ok: true,
            id,
            state: "replied",
        });
        expect(box.text()).toBe(DOC.replace("cold path", "slow path"));
    });

    test("an older log's suggestions only and per-thread auto-apply are ignored", async () => {
        const id = await box.comment("cold path", "Rename");
        const legacy = [
            { type: "setting", by: "user", key: "autoApply", value: true, id },
            { type: "setting", by: "user", key: "suggestionsOnly", value: true },
        ] as unknown as EventInput[];
        await box.append(...legacy);
        await suggest(box.doc, { id, replace: "slow path", apply: false });
        expect(box.text()).toBe(DOC);
        await suggest(box.doc, { id, replace: "slow path", apply: true });
        expect(box.text()).toBe(DOC.replace("cold path", "slow path"));
    });

    test("a pipe in a table cell is escaped", async () => {
        const id = await box.comment("Retry queue", "Rename");
        await suggest(box.doc, { id, replace: "a | b", apply: true });
        expect(box.text()).toContain("| Tiles | Platform | a \\| b fills under load |");
    });

    test("a detached thread is refused", async () => {
        const id = await box.comment("cold path", "Rename");
        const start = DOC.indexOf("the cold path");
        await applyEdit(box.doc, {
            start,
            before: "the cold path",
            after: "it",
            cause: "user",
            by: "user",
        });
        expect(await suggest(box.doc, { id, replace: "x", apply: false })).toMatchObject({
            ok: false,
            error: "detached",
        });
    });

    test("--find starts an agent thread on unique text", async () => {
        expect(
            await suggest(box.doc, { find: "first tile", replace: "first image", apply: false }),
        ).toMatchObject({ ok: true, id: "c1", state: "replied" });
        const thread = (await box.state()).threads.get("c1")!;
        expect(thread.createdBy).toBe("agent");
        expect(thread.anchor!.exact).toBe("first tile");
    });

    test("--find --apply anchors the new thread on the text as it now reads", async () => {
        await suggest(box.doc, { find: "first tile", replace: "first image", apply: true });
        expect(box.text()).toContain("first image renders");
        const thread = (await box.state()).threads.get("c1")!;
        expect(thread.anchor!.exact).toBe("first image");
        expect(thread.applied).toMatchObject({ before: "first tile", after: "first image" });
    });

    test("--find refuses missing and repeated text", async () => {
        expect(await suggest(box.doc, { find: "absent", replace: "x", apply: false })).toEqual({
            ok: false,
            error: "before-missing",
        });
        expect(await suggest(box.doc, { find: "the", replace: "x", apply: false })).toEqual({
            ok: false,
            error: "not-unique",
        });
        expect((await box.state()).threads.size).toBe(0);
    });
});

describe("suggest --find with a daemon yet to sync an editor save (gate B)", () => {
    for (const earlier of [true, false]) {
        test(`the new anchor is not shifted twice${earlier ? ", with an earlier thread" : ""}`, async () => {
            const first = earlier ? await box.comment("cold path", "Why?") : undefined;
            const session = await DocSession.open("0123456789ab", box.doc);
            writeFileSync(
                box.doc,
                box.text().replace("## Findings", "## Findings\nAn intro line."),
            );
            const ack = await suggest(box.doc, {
                find: "Retry queue",
                replace: "Retry backlog",
                apply: false,
            });
            expect(ack).toMatchObject({ ok: true });
            await session.sync();

            const source = box.text();
            const state = await box.state();
            const created = [...state.threads.values()].at(-1)!;
            expect(created.anchor!.hint).toBe(source.indexOf("Retry queue"));
            if (first) {
                expect(state.threads.get(first)!.anchor!.hint).toBe(source.indexOf("cold path"));
            }
            const { events } = await readLog(box.doc);
            expect(events.some((event) => event.type === "outside" && event.edit)).toBe(false);
            expect(session.snapshot().threads.every((thread) => !thread.detached)).toBe(true);
        });
    }
});

describe("show", () => {
    test("prints the whole unit and the whole thread", async () => {
        const id = await box.comment("cold path", "Why?");
        await reply(box.doc, id, "Because");
        const result = (await show(box.doc, id)) as ShowOutput;
        expect(formatShow(result)).toBe(
            [
                "c1 replied L5 Findings",
                "quote: cold path",
                "unit:",
                "The cache is warm by the time the first tile renders, so the cold path rarely runs.",
                "user: Why?",
                "agent: Because",
            ].join("\n"),
        );
    });

    test("a table cell shows its header and row, not the whole table", async () => {
        const id = await box.comment("Retry queue", "Why?");
        const result = (await show(box.doc, id)) as ShowOutput;
        expect(result.unit).toBe(
            "| Area | Owner | Note |\n| Tiles | Platform | Retry queue fills under load |",
        );
    });

    test("an unknown id is not found", async () => {
        expect(await show(box.doc, "c4")).toEqual({ ok: false, id: "c4", error: "not-found" });
    });
});

describe("deleted threads", () => {
    test("every agent command is refused, and nothing is appended", async () => {
        const id = await box.comment("cold path", "Why?");
        await box.append({ type: "delete", by: "user", id });
        const version = (await box.state()).version;
        const refused: Ack = { ok: false, id, error: "deleted" };
        expect(await reply(box.doc, id, "Because")).toEqual(refused);
        expect(await resolveThread(box.doc, id)).toEqual(refused);
        expect(await suggest(box.doc, { id, replace: "slow path", apply: true })).toEqual(refused);
        expect(await show(box.doc, id)).toEqual(refused);
        expect((await box.state()).version).toBe(version);
        expect(box.text()).toBe(DOC);
    });

    test("after an undelete the agent can answer again", async () => {
        const id = await box.comment("cold path", "Why?");
        await box.append({ type: "delete", by: "user", id }, { type: "undelete", by: "user", id });
        expect(await reply(box.doc, id, "Because")).toEqual({ ok: true, id, state: "replied" });
    });

    test("a reply racing the page's delete lands only if it takes the lock first", async () => {
        const first = await box.comment("cold path", "Why?");
        const second = await box.comment("Retry queue", "Why?");
        const session = await DocSession.open("0123456789ab", box.doc);
        expect(await reply(box.doc, first, "Because")).toMatchObject({ ok: true });
        await session.deleteThread(first);
        await session.deleteThread(second);
        expect(await reply(box.doc, second, "Late")).toMatchObject({ error: "deleted" });
        const state = await box.state();
        expect(state.threads.get(first)!.messages.map((m) => m.by)).toEqual(["user", "agent"]);
        expect(state.threads.get(second)!.messages.map((m) => m.by)).toEqual(["user"]);
        expect(session.snapshot().threads).toEqual([]);
    });
});

describe("doc notes", () => {
    test("reply and resolve work; suggest is refused with no-anchor and appends nothing", async () => {
        const id = await box.note("Tighten the whole intro.");
        expect(await reply(box.doc, id, "On it.")).toEqual({ ok: true, id, state: "replied" });
        const version = (await box.state()).version;
        expect(await suggest(box.doc, { id, replace: "x", apply: true })).toEqual({
            ok: false,
            id,
            error: "no-anchor",
        });
        expect((await box.state()).version).toBe(version);
        expect(box.text()).toBe(DOC);
        expect(await resolveThread(box.doc, id)).toEqual({ ok: true, id, state: "resolved" });
    });

    test("show prints the thread with no quote and no unit", async () => {
        const id = await box.note("Tighten the whole intro.");
        await reply(box.doc, id, "On it.");
        const result = (await show(box.doc, id)) as ShowOutput;
        expect(result).toMatchObject({ id, path: "", line: 0, unit: "" });
        expect(result.thread.detached).toBe(false);
        expect(result.thread.anchor).toBeUndefined();
        expect(formatShow(result)).toBe(
            ["c1 replied doc", "user: Tighten the whole intro.", "agent: On it."].join("\n"),
        );
    });
});
