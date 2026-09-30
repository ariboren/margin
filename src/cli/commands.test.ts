import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readLog } from "../core/log.ts";
import { applyEdit } from "../core/apply.ts";
import { DocSession } from "../server/session.ts";
import type { ShowOutput } from "../core/model.ts";
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
        expect(await reply(box.doc, id, "Done", true)).toEqual({ ok: true, id, state: "resolved" });
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
            downgraded: false,
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
        expect(thread.anchor.exact).toBe("slow path");
        expect(thread.messages.at(-1)).toMatchObject({ by: "agent", text: "Renamed" });
    });

    test("suggestions only downgrades --apply and says so", async () => {
        const id = await box.comment("cold path", "Rename");
        await box.append({ type: "setting", by: "user", key: "suggestionsOnly", value: true });
        expect(await suggest(box.doc, { id, replace: "slow path", apply: true })).toMatchObject({
            ok: true,
            downgraded: true,
        });
        expect(box.text()).toBe(DOC);
    });

    test("auto-apply on the thread applies without --apply", async () => {
        const id = await box.comment("cold path", "Rename");
        await box.append({ type: "setting", by: "user", key: "autoApply", value: true, id });
        await suggest(box.doc, { id, replace: "slow path", apply: false });
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
        expect(thread.anchor.exact).toBe("first tile");
    });

    test("--find --apply anchors the new thread on the text as it now reads", async () => {
        await suggest(box.doc, { find: "first tile", replace: "first image", apply: true });
        expect(box.text()).toContain("first image renders");
        const thread = (await box.state()).threads.get("c1")!;
        expect(thread.anchor.exact).toBe("first image");
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
            expect(created.anchor.hint).toBe(source.indexOf("Retry queue"));
            if (first) {
                expect(state.threads.get(first)!.anchor.hint).toBe(source.indexOf("cold path"));
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
