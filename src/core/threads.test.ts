import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggest } from "../cli/commands.ts";
import { sandbox } from "../cli/testing.ts";
import { createAnchor, resolveAnchor } from "./anchor.ts";
import { hashText } from "./blocks.ts";
import { readLog } from "./log.ts";
import type { Anchor, Event, EventInput, SourceSplice, ThreadId } from "./model.ts";
import {
    buildSource,
    checkProperty,
    edgeFixtures,
    fragmentArb,
    snapOffset,
    scaledTimeout,
    sourceArb,
} from "./testing.ts";
import {
    STALL_MS,
    catchUpInputs,
    createThread,
    foldLog,
    isStalled,
    needsAgent,
    nextThreadId,
    type DocState,
} from "./threads.ts";

const THREADS_MODULE = join(import.meta.dir, "threads.ts");
const T0 = Date.parse("2026-09-30T12:00:00.000Z");

const anchor: Anchor = { exact: "quoted words", prefix: "some ", suffix: " here", hint: 40 };

/** Builds a log from inputs, one second apart, as the appender would store them. */
function log(...inputs: EventInput[]): Event[] {
    return inputs.map(
        (input, i) =>
            ({ seq: i + 1, at: new Date(T0 + i * 1000).toISOString(), ...input }) as Event,
    );
}

function comment(id: ThreadId, draft = false): EventInput {
    return { type: "comment", by: "user", id, anchor, text: "Why?", draft };
}

function thread(state: DocState, id: ThreadId = "c1") {
    const found = state.threads.get(id);
    if (!found) {
        throw new Error(`no thread ${id}`);
    }
    return found;
}

describe("thread state transitions", () => {
    test("draft opens on send", () => {
        const events = log(comment("c1", true), { type: "send", by: "user", ids: ["c1"] });
        expect(thread(foldLog(events.slice(0, 1))).state).toBe("draft");
        expect(thread(foldLog(events)).state).toBe("open");
    });

    test("open, claimed, replied, reopened by a user reply, claimed again", () => {
        const events = log(
            comment("c1"),
            { type: "claim", by: "agent", ids: ["c1"] },
            { type: "reply", by: "agent", id: "c1", text: "Because." },
            { type: "reply", by: "user", id: "c1", text: "Say more." },
            { type: "claim", by: "agent", ids: ["c1"] },
        );
        const states = events.map((_, i) => thread(foldLog(events.slice(0, i + 1))).state);
        expect(states).toEqual(["open", "working", "replied", "open", "working"]);
        const final = thread(foldLog(events));
        expect(final.claimed).toBe(true);
        expect(final.messages.map((m) => m.by)).toEqual(["user", "agent", "user"]);
    });

    test("an agent suggestion, accepted, resolves", () => {
        const events = log(comment("c1"), {
            type: "suggest",
            by: "agent",
            id: "c1",
            replace: "better words",
            note: "Tightened.",
            apply: false,
            downgraded: false,
        });
        const suggested = thread(foldLog(events));
        expect(suggested.state).toBe("replied");
        expect(suggested.suggestion).toMatchObject({ replace: "better words", status: "pending" });
        expect(suggested.messages.at(-1)).toMatchObject({ by: "agent", text: "Tightened." });

        const accepted = thread(foldLog(log(...events, { type: "accept", by: "user", id: "c1" })));
        expect(accepted.state).toBe("resolved");
        expect(accepted.suggestion?.status).toBe("accepted");
    });

    test("reject with a note reopens; without one resolves", () => {
        const suggest: EventInput = {
            type: "suggest",
            by: "agent",
            id: "c1",
            replace: "x",
            apply: false,
            downgraded: false,
        };
        const withNote = thread(
            foldLog(
                log(comment("c1"), suggest, { type: "reject", by: "user", id: "c1", note: "No" }),
            ),
        );
        expect(withNote.state).toBe("open");
        expect(withNote.suggestion?.status).toBe("rejected");
        expect(withNote.messages.at(-1)).toMatchObject({ by: "user", text: "No" });

        const bare = thread(
            foldLog(log(comment("c1"), suggest, { type: "reject", by: "user", id: "c1" })),
        );
        expect(bare.state).toBe("resolved");
        expect(bare.suggestion?.status).toBe("rejected");
    });

    test("resolve and reopen", () => {
        const events = log(
            comment("c1"),
            { type: "resolve", by: "agent", id: "c1" },
            { type: "reopen", by: "user", id: "c1" },
        );
        expect(thread(foldLog(events.slice(0, 2))).state).toBe("resolved");
        expect(thread(foldLog(events)).state).toBe("open");
    });

    test("a user reply reopens a resolved thread", () => {
        const events = log(
            comment("c1"),
            { type: "resolve", by: "user", id: "c1" },
            { type: "reply", by: "user", id: "c1", text: "Wait." },
        );
        expect(thread(foldLog(events)).state).toBe("open");
    });

    test("an agent suggestion with an anchor creates its own thread, replied", () => {
        const state = foldLog(
            log({
                type: "suggest",
                by: "agent",
                id: "c1",
                anchor,
                replace: "y",
                apply: false,
                downgraded: false,
            }),
        );
        expect(thread(state)).toMatchObject({ state: "replied", createdBy: "agent", anchor });
    });

    test("an applied suggestion is replied, marked applied, and revertible", () => {
        const applied = log(
            comment("c1"),
            {
                type: "suggest",
                by: "agent",
                id: "c1",
                replace: "new",
                apply: true,
                downgraded: false,
            },
            {
                type: "edit",
                by: "agent",
                cause: "apply",
                id: "c1",
                start: 40,
                before: "old",
                after: "new",
                line: 3,
                headingPath: ["Doc"],
            },
        );
        const state = foldLog(applied);
        expect(thread(state)).toMatchObject({
            state: "replied",
            suggestion: { status: "accepted" },
            applied: { seq: 3, start: 40, before: "old", after: "new", reverted: false },
        });
        expect(state.edits.map((edit) => edit.seq)).toEqual([3]);

        const reverted = foldLog(
            log(...applied, {
                type: "edit",
                by: "user",
                cause: "revert",
                id: "c1",
                start: 40,
                before: "new",
                after: "old",
                line: 3,
                headingPath: ["Doc"],
            }),
        );
        expect(thread(reverted).applied?.reverted).toBe(true);
    });

    test("working with no activity for 10 minutes is stalled", () => {
        const working = thread(
            foldLog(log(comment("c1"), { type: "claim", by: "agent", ids: ["c1"] })),
        );
        const claimedAt = Date.parse(working.lastActivity);
        expect(isStalled(working, claimedAt + STALL_MS - 1)).toBe(false);
        expect(isStalled(working, claimedAt + STALL_MS)).toBe(true);
        const open = thread(foldLog(log(comment("c1"))));
        expect(isStalled(open, Date.parse(open.lastActivity) + STALL_MS * 2)).toBe(false);
    });

    test("needsAgent covers open and working only", () => {
        const events = log(
            comment("c1"),
            comment("c2"),
            { type: "claim", by: "agent", ids: ["c2"] },
            comment("c3"),
            { type: "reply", by: "agent", id: "c3", text: "Done." },
            comment("c4", true),
            comment("c5"),
            { type: "resolve", by: "user", id: "c5" },
        );
        const state = foldLog(events);
        expect([...state.threads.values()].filter(needsAgent).map((t) => t.id)).toEqual([
            "c1",
            "c2",
        ]);
    });
});

describe("doc state", () => {
    test("settings, hold, cursors and agent presence", () => {
        const state = foldLog(
            log(
                comment("c1"),
                { type: "hold", by: "user", on: true },
                { type: "setting", by: "user", key: "suggestionsOnly", value: true },
                { type: "setting", by: "user", key: "autoApply", value: true, id: "c1" },
                { type: "cursor", by: "agent", stream: "watch", upTo: 4 },
                { type: "cursor", by: "agent", stream: "watch", upTo: 2 },
                { type: "cursor", by: "agent", stream: "pending", upTo: 6 },
            ),
        );
        expect(state.settings).toEqual({ hold: true, suggestionsOnly: true, autoApply: false });
        expect(thread(state).autoApply).toBe(true);
        expect(state.cursors).toEqual({ watch: 4, pending: 6 });
        expect(state.agentSeenAt).toBe(new Date(T0 + 6000).toISOString());
        expect(state.version).toBe(7);
    });

    test("an outside change without a splice marks the doc and leaves anchors", () => {
        const state = foldLog(
            log(comment("c1"), { type: "outside", by: "user", hashBefore: "a", hashAfter: "b" }),
        );
        expect(state.changedOnDisk).toBe(new Date(T0 + 1000).toISOString());
        expect(thread(state).anchor).toEqual(anchor);
    });
});

describe("anchor rebase", () => {
    const splice = { start: 0, before: "", after: "12345" };

    test("an outside change with a splice moves anchors", () => {
        const state = foldLog(
            log(comment("c1"), {
                type: "outside",
                by: "user",
                hashBefore: "a",
                hashAfter: "b",
                edit: splice,
            }),
        );
        expect(thread(state).anchor).toMatchObject({ exact: anchor.exact, hint: anchor.hint + 5 });
    });

    test("edits are replayed in log order", () => {
        const edit = (start: number, before: string, after: string): EventInput => ({
            type: "edit",
            by: "user",
            cause: "user",
            start,
            before,
            after,
            line: 1,
            headingPath: [],
        });
        const state = foldLog(log(comment("c1"), edit(0, "", "12345"), edit(0, "123", "")));
        expect(thread(state).anchor.hint).toBe(anchor.hint + 2);
    });

    test("an edit that removes the quote keeps the last anchor", () => {
        const state = foldLog(
            log(comment("c1"), {
                type: "edit",
                by: "user",
                cause: "user",
                start: anchor.hint - 2,
                before: `e ${anchor.exact} h`,
                after: "gone",
                line: 1,
                headingPath: [],
            }),
        );
        expect(thread(state).anchor).toEqual(anchor);
    });

    test("an applied edit logged before its creating suggestion still marks the thread", () => {
        const state = foldLog(
            log(
                {
                    type: "edit",
                    by: "agent",
                    cause: "apply",
                    id: "c1",
                    start: 40,
                    before: "old",
                    after: "new",
                    line: 3,
                    headingPath: [],
                },
                {
                    type: "suggest",
                    by: "agent",
                    id: "c1",
                    anchor,
                    replace: "new",
                    apply: true,
                    downgraded: false,
                },
            ),
        );
        expect(thread(state)).toMatchObject({
            state: "replied",
            applied: { seq: 1, before: "old", after: "new", reverted: false },
        });
    });
});

describe("anchors after an unlogged outside edit (gate B)", () => {
    /** The doc changes with no daemon running, so no outside event is logged. */
    async function staleThenApply(insert: string) {
        const box = sandbox();
        try {
            const id = await box.comment("cold path", "Why?");
            writeFileSync(box.doc, box.text().replace("## Findings", `## Findings\n${insert}`));
            const ack = await suggest(box.doc, { id, replace: "slow path", apply: true });
            expect(ack).toMatchObject({ ok: true, id });
            const anchor = thread(await box.state(), id).anchor;
            return { anchor, source: box.text() };
        } finally {
            box.cleanup();
        }
    }

    for (const insert of ["Hi.", "An intro line here."]) {
        test(`suggest --apply follows the replacement after a ${insert.length + 1}-char insert`, async () => {
            const { anchor, source } = await staleThenApply(insert);
            expect(anchor.exact).toBe("slow path");
            expect(source.slice(anchor.hint, anchor.hint + anchor.exact.length)).toBe("slow path");
            expect(resolveAnchor(source, anchor)).not.toBeNull();
        });
    }

    test("an old log with a stale hint is repaired by the fold", () => {
        const source = "Intro. The cache is warm, so the cold path rarely runs.";
        const stale: Anchor = {
            exact: "cold path",
            prefix: "The cache is warm, so the ",
            suffix: " rarely runs.",
            hint: source.indexOf("cold path") - 4,
        };
        const state = foldLog(
            log(
                {
                    type: "comment",
                    by: "user",
                    id: "c1",
                    anchor: stale,
                    text: "Why?",
                    draft: false,
                },
                {
                    type: "edit",
                    by: "agent",
                    cause: "apply",
                    id: "c1",
                    start: source.indexOf("cold path"),
                    before: "cold path",
                    after: "slow path",
                    line: 1,
                    headingPath: [],
                },
            ),
        );
        expect(thread(state).anchor).toMatchObject({
            exact: "slow path",
            hint: source.indexOf("cold path"),
        });
    });

    test("with an accurate hint, a find that overlaps the quote mid-word keeps whole words", async () => {
        const box = sandbox();
        try {
            const id = await box.comment("cold path", "Why?");
            const ack = await suggest(box.doc, { find: "path rar", replace: "route", apply: true });
            expect(ack).toMatchObject({ ok: true });
            const anchor = thread(await box.state(), id).anchor;
            const source = box.text();
            expect(anchor.exact).toBe("cold routeely");
            expect(source.slice(anchor.hint, anchor.hint + anchor.exact.length)).toBe(anchor.exact);
        } finally {
            box.cleanup();
        }
    });
});

describe("catch-up after a change no event describes (gate B, round 2)", () => {
    test("with no daemon, an agent edit inside a quote after an unlogged insert above keeps it", async () => {
        const box = sandbox();
        try {
            const id = await box.comment("cold path rarely runs", "Why?");
            writeFileSync(box.doc, box.text().replace("## Findings", "## Findings\nIntro."));
            const ack = await suggest(box.doc, {
                find: "path rarely",
                replace: "path very rarely",
                apply: true,
            });
            expect(ack).toMatchObject({ ok: true });
            const anchor = thread(await box.state(), id).anchor;
            const source = box.text();
            expect(anchor.exact).toBe("cold path very rarely runs");
            expect(source.slice(anchor.hint, anchor.hint + anchor.exact.length)).toBe(anchor.exact);
            const types = (await readLog(box.doc)).events.map((event) => event.type);
            expect(types.slice(0, 3)).toEqual(["comment", "reanchor", "edit"]);
        } finally {
            box.cleanup();
        }
    });

    test("an unlogged change after a known hash logs an outside change, then the reanchor", () => {
        const base = "Intro. The cold path rarely runs.";
        const start = base.indexOf("cold path");
        const events = log(
            {
                type: "comment",
                by: "user",
                id: "c1",
                anchor: createAnchor(base, { start, end: start + 9 }),
                text: "Why?",
                draft: false,
            },
            { type: "reanchor", by: "user", hash: hashText(base), anchors: {} },
        );
        const moved = `Hello. ${base}`;
        const inputs = catchUpInputs(events, moved);
        expect(inputs.map((input) => input.type)).toEqual(["outside", "reanchor"]);
        expect(catchUpInputs(events, base)).toEqual([]);
        const state = foldLog(log(...events, ...inputs));
        expect(thread(state).anchor.hint).toBe(moved.indexOf("cold path"));
    });

    /** A comment on `base`, the reanchor that vouches for it, and an edit input on `moved`. */
    function catchUpCase(base: string, quote: { start: number; end: number }) {
        return log(
            {
                type: "comment",
                by: "user",
                id: "c1",
                anchor: createAnchor(base, quote),
                text: "Why?",
                draft: false,
            },
            { type: "reanchor", by: "user", hash: hashText(base), anchors: {} },
        );
    }

    function editInput(edit: SourceSplice): EventInput {
        return { type: "edit", by: "user", cause: "user", ...edit, line: 1, headingPath: [] };
    }

    function isWrong(source: string, quote: Anchor): boolean {
        return (
            source.slice(quote.hint, quote.hint + quote.exact.length) !== quote.exact ||
            resolveAnchor(source, quote) === null
        );
    }

    test("without the catch-up, an edit after an unlogged shift gives a wrong quote", () => {
        const base = "Intro. The cold path rarely runs here.";
        const events = catchUpCase(base, { start: 7, end: 16 });
        const moved = `x${base}`;
        const edit = { start: 10, before: "e", after: "Q" };
        const final = `${moved.slice(0, 10)}Q${moved.slice(11)}`;
        expect(isWrong(final, thread(foldLog(log(...events, editInput(edit)))).anchor)).toBe(true);
        const caughtUp = foldLog(log(...events, ...catchUpInputs(events, moved), editInput(edit)));
        expect(thread(caughtUp).anchor.exact).toBe("ThQ cold ");
        expect(isWrong(final, thread(caughtUp).anchor)).toBe(false);
    });

    test(
        "property: after an unlogged shift and catch-up, the fold is deterministic and an edit at the quote never gives a wrong quote",
        () => {
            const baseArb = fc.oneof(
                { weight: 4, arbitrary: sourceArb(["public-sample.md"]) },
                { weight: 1, arbitrary: sourceArb(edgeFixtures) },
            );
            checkProperty(
                fc.property(
                    baseArb,
                    fc.nat(),
                    fc.integer({ min: 5, max: 29 }),
                    fc.string({ unit: fragmentArb, minLength: 1, maxLength: 8 }),
                    fc.constantFrom("ins", "del1", "rep1", "del3", "insNear"),
                    fc.nat(),
                    (sourceCase, rawStart, length, unlogged, kind, rawAt) => {
                        const base = buildSource(sourceCase);
                        const start = snapOffset(base, 40 + (rawStart % (base.length - 100)));
                        const end = snapOffset(base, start + length);
                        const shift = unlogged.length;
                        const moved = unlogged + base;
                        const at = snapOffset(
                            moved,
                            shift +
                                (kind === "insNear"
                                    ? start - (rawAt % (shift + 1))
                                    : start + (rawAt % (end - start))),
                        );
                        let cutEnd = at + (kind === "del3" ? 3 : 1);
                        if (snapOffset(moved, cutEnd) !== cutEnd) cutEnd++;
                        const edit =
                            kind === "ins" || kind === "insNear"
                                ? { start: at, before: "", after: "Z" }
                                : {
                                      start: at,
                                      before: moved.slice(at, cutEnd),
                                      after: kind === "rep1" ? "Q" : "",
                                  };
                        const final =
                            moved.slice(0, at) + edit.after + moved.slice(at + edit.before.length);
                        const events = catchUpCase(base, { start, end });
                        const caughtUp = log(
                            ...events,
                            ...catchUpInputs(events, moved),
                            editInput(edit),
                        );
                        const state = foldLog(caughtUp);
                        expect(foldLog(caughtUp)).toEqual(state);
                        expect(isWrong(final, thread(state).anchor)).toBe(false);
                    },
                ),
                10_000,
            );
        },
        scaledTimeout(30_000),
    );
});

describe("id allocation", () => {
    test("next id follows the highest id in the log", () => {
        expect(nextThreadId([])).toBe("c1");
        expect(nextThreadId(log(comment("c1"), comment("c9"), comment("c3")))).toBe("c10");
    });

    test("property: the next id is new and above every id in the log", () => {
        checkProperty(
            fc.property(fc.array(fc.nat({ max: 100_000 }), { maxLength: 30 }), (numbers) => {
                const events = log(...numbers.map((n) => comment(`c${n}`)));
                const next = Number(nextThreadId(events).slice(1));
                expect(numbers.every((n) => n < next)).toBe(true);
                expect(next).toBe(Math.max(0, ...numbers) + 1);
            }),
            500,
        );
    });

    test("20 processes creating threads concurrently get unique, gapless ids", async () => {
        const dir = mkdtempSync(join(tmpdir(), "margin-threads-"));
        try {
            const doc = join(dir, "doc.md");
            writeFileSync(doc, "# Doc\n");
            const perWorker = 5;
            const workers = 20;
            const script = join(dir, "worker.ts");
            writeFileSync(
                script,
                `import { createThread } from ${JSON.stringify(THREADS_MODULE)};
for (let i = 0; i < ${perWorker}; i++) {
    await createThread(${JSON.stringify(doc)}, (id) => [
        { type: "comment", by: "user", id, anchor: ${JSON.stringify(anchor)}, text: id, draft: false },
    ]);
}
`,
            );
            const children = Array.from({ length: workers }, () =>
                Bun.spawn([process.execPath, script], { stdout: "inherit", stderr: "inherit" }),
            );
            const codes = await Promise.all(children.map(async (child) => await child.exited));
            expect(codes.every((code) => code === 0)).toBe(true);

            const { events } = await readLog(doc);
            const total = workers * perWorker;
            expect(events).toHaveLength(total);
            const ids: string[] = events.map((event) => (event.type === "comment" ? event.id : ""));
            expect(new Set(ids).size).toBe(total);
            expect(ids.toSorted()).toEqual(
                Array.from({ length: total }, (_, i) => `c${i + 1}`).toSorted(),
            );
            expect(foldLog(events).threads.size).toBe(total);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    test("createThread returns the id it appended", async () => {
        const dir = mkdtempSync(join(tmpdir(), "margin-threads-"));
        try {
            const doc = join(dir, "doc.md");
            writeFileSync(doc, "# Doc\n");
            const first = await createThread(doc, (id) => [comment(id)]);
            const second = await createThread(doc, (id) => [comment(id)]);
            expect([first.id, second.id]).toEqual(["c1", "c2"]);
            expect(second.events[0]).toMatchObject({ seq: 2, type: "comment", id: "c2" });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
