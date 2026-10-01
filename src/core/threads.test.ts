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
import {
    isDocNote,
    isUnresolved,
    type AgentIdentity,
    type Anchor,
    type Event,
    type EventInput,
    type SourceSplice,
    type ThreadId,
} from "./model.ts";
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
    finishRemaining,
    foldLog,
    isStalled,
    needsAgent,
    nextThreadId,
    reanchorInput,
    unresolvedThreads,
    withoutDeleted,
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
                { type: "setting", by: "user", key: "autoApply", value: true },
                { type: "setting", by: "user", key: "autoApply", value: false },
                { type: "cursor", by: "agent", stream: "watch", upTo: 4 },
                { type: "cursor", by: "agent", stream: "watch", upTo: 2 },
                { type: "cursor", by: "agent", stream: "pending", upTo: 6 },
            ),
        );
        expect(state.settings).toEqual({ hold: true, autoApply: false });
        expect(state.cursors).toEqual({ watch: 4, pending: 6 });
        expect(state.agentSeenAt).toBe(new Date(T0 + 6000).toISOString());
        expect(state.version).toBe(7);
    });

    test("retired settings in older logs are read and ignored", () => {
        // Logs written before #11: a suggestions-only switch, per-thread auto-apply, and
        // `downgraded` on suggest events. They are no longer in the event types.
        const legacy = [
            comment("c1"),
            { type: "setting", by: "user", key: "suggestionsOnly", value: true },
            { type: "setting", by: "user", key: "autoApply", value: true, id: "c1" },
            {
                type: "suggest",
                by: "agent",
                id: "c1",
                replace: "words",
                apply: false,
                downgraded: true,
            },
        ] as unknown as EventInput[];
        const state = foldLog(log(...legacy));
        expect(state.settings).toEqual({ hold: false, autoApply: false });
        expect(thread(state)).not.toHaveProperty("autoApply");
        expect(thread(state)).toMatchObject({
            state: "replied",
            suggestion: { replace: "words", status: "pending" },
        });
    });

    test("a doc-level auto-apply from an older log still holds", () => {
        const legacy = [
            { type: "setting", by: "user", key: "suggestionsOnly", value: true },
            { type: "setting", by: "user", key: "autoApply", value: true },
        ] as unknown as EventInput[];
        expect(foldLog(log(...legacy)).settings).toEqual({ hold: false, autoApply: true });
    });

    test("messages and suggestions carry the agent's identity when the event has one", () => {
        const foreman = { name: "foreman", client: "claude-code" } as const;
        const state = foldLog(
            log(
                comment("c1"),
                { type: "reply", by: "agent", agent: foreman, id: "c1", text: "Old cache." },
                { type: "reply", by: "agent", id: "c1", text: "From an older build." },
                {
                    type: "suggest",
                    by: "agent",
                    agent: foreman,
                    id: "c1",
                    replace: "new",
                    note: "Tighter.",
                    apply: false,
                },
            ),
        );
        const messages = thread(state).messages;
        expect(messages.map((message) => message.agent)).toEqual([
            undefined,
            foreman,
            undefined,
            foreman,
        ]);
        expect(thread(state).suggestion?.agent).toEqual(foreman);
    });

    test("an identity from a log we did not write is validated before it reaches a message", () => {
        const hostile = (agent: unknown): EventInput =>
            ({ type: "reply", by: "agent", agent, id: "c1", text: "Hi." }) as EventInput;
        const state = foldLog(
            log(
                comment("c1"),
                hostile({ name: "ghost", client: "toString" }),
                hostile({ name: "ghost", client: "__proto__" }),
                hostile({ name: "ghost", client: "constructor" }),
                hostile({ name: { call: 1 }, client: "codex" }),
                hostile({ name: "n".repeat(500), client: "codex" }),
                hostile({ name: 7, client: "cursor" }),
                hostile("foreman"),
                hostile(null),
                {
                    type: "suggest",
                    by: "agent",
                    agent: { name: "ghost", client: "vim" } as unknown as AgentIdentity,
                    id: "c1",
                    replace: "new",
                    apply: false,
                },
            ),
        );
        expect(
            thread(state)
                .messages.slice(1)
                .map((message) => message.agent),
        ).toEqual([
            { name: "ghost", client: "unknown" },
            { name: "ghost", client: "unknown" },
            { name: "ghost", client: "unknown" },
            { name: "Codex", client: "codex" },
            { name: "n".repeat(200), client: "codex" },
            { name: "Cursor", client: "cursor" },
            { name: "Agent", client: "unknown" },
            { name: "Agent", client: "unknown" },
        ]);
        expect(thread(state).suggestion?.agent).toEqual({ name: "ghost", client: "unknown" });
    });

    test("an outside change without a splice marks the doc and leaves anchors", () => {
        const state = foldLog(
            log(comment("c1"), { type: "outside", by: "user", hashBefore: "a", hashAfter: "b" }),
        );
        expect(state.changedOnDisk).toBe(new Date(T0 + 1000).toISOString());
        expect(thread(state).anchor).toEqual(anchor);
    });
});

describe("delete and undelete", () => {
    const del = (id: ThreadId): EventInput => ({ type: "delete", by: "user", id });
    const undel = (id: ThreadId): EventInput => ({ type: "undelete", by: "user", id });
    const claimed: EventInput[] = [comment("c1"), { type: "claim", by: "agent", ids: ["c1"] }];
    const suggested: EventInput[] = [
        comment("c1"),
        { type: "claim", by: "agent", ids: ["c1"] },
        {
            type: "suggest",
            by: "agent",
            id: "c1",
            replace: "better words",
            apply: false,
        },
    ];

    test.each([
        ["a claimed thread", claimed],
        ["a thread with a pending suggestion", suggested],
        ["a held draft", [comment("c1", true)]],
    ])("round trip leaves %s as it was", (_, inputs) => {
        const before = foldLog(log(...inputs));
        const deleted = foldLog(log(...inputs, del("c1")));
        expect([...deleted.deleted]).toEqual(["c1"]);
        expect(withoutDeleted(deleted).threads.has("c1")).toBe(false);
        const after = foldLog(log(...inputs, del("c1"), undel("c1")));
        expect(after.deleted.size).toBe(0);
        expect(thread(after)).toEqual(thread(before));
    });

    test("a deleted thread's anchor still follows edits, for an undelete", () => {
        const state = foldLog(
            log(comment("c1"), del("c1"), {
                type: "outside",
                by: "user",
                hashBefore: "a",
                hashAfter: "b",
                edit: { start: 0, before: "", after: "12345" },
            }),
        );
        expect(thread(state).anchor!.hint).toBe(anchor.hint + 5);
    });

    test("views leave deleted threads out and other threads alone", () => {
        const state = withoutDeleted(foldLog(log(comment("c1"), comment("c2"), del("c1"))));
        expect([...state.threads.keys()]).toEqual(["c2"]);
        expect(state.deleted.has("c1")).toBe(true);
    });

    test("deleting an unknown id marks nothing; a deleted id is never reused", () => {
        expect(foldLog(log(comment("c1"), del("c2"))).deleted.size).toBe(0);
        expect(nextThreadId(log(comment("c1"), del("c1")))).toBe("c2");
    });
});

describe("retract", () => {
    const agentReply: EventInput = { type: "reply", by: "agent", id: "c1", text: "Done" };
    const userReply: EventInput = { type: "reply", by: "user", id: "c1", text: "Not yet" };
    const suggested: EventInput = {
        type: "suggest",
        by: "agent",
        id: "c1",
        replace: "better words",
        apply: false,
    };
    const retract = (of: number): EventInput => ({ type: "retract", by: "user", id: "c1", of });

    test("a reply goes with its message; state and time go back while nothing changed them", () => {
        const before = foldLog(log(comment("c1"), agentReply));
        const after = foldLog(log(comment("c1"), agentReply, userReply, retract(3)));
        expect(thread(after)).toEqual(thread(before));
        expect(after.retractable.has(3)).toBe(false);
        expect(after.version).toBe(4);
    });

    test("a resolve, a reopen and a plain reject put the state back exactly", () => {
        const opened = foldLog(log(comment("c1"), agentReply));
        expect(thread(opened).state).toBe("replied");
        const resolved = log(comment("c1"), agentReply, { type: "resolve", by: "user", id: "c1" });
        expect(thread(foldLog([...resolved, ...log(retract(3)).map(at(4))]))).toEqual(
            thread(opened),
        );
        const reopened = [...resolved, ...log({ type: "reopen", by: "user", id: "c1" }).map(at(4))];
        expect(thread(foldLog(reopened)).state).toBe("open");
        expect(thread(foldLog([...reopened, ...log(retract(4)).map(at(5))])).state).toBe(
            "resolved",
        );
        const rejected = foldLog(
            log(comment("c1"), suggested, { type: "reject", by: "user", id: "c1" }, retract(3)),
        );
        expect(thread(rejected)).toMatchObject({
            state: "replied",
            suggestion: { status: "pending" },
        });
    });

    test("an accept or a reject with a note makes the suggestion pending again, note gone", () => {
        const pending = foldLog(log(comment("c1"), suggested));
        const accepted = foldLog(
            log(comment("c1"), suggested, { type: "accept", by: "user", id: "c1" }, retract(3)),
        );
        expect(thread(accepted)).toEqual(thread(pending));
        const rejected = foldLog(
            log(
                comment("c1"),
                suggested,
                { type: "reject", by: "user", id: "c1", note: "No" },
                retract(3),
            ),
        );
        expect(thread(rejected)).toEqual(thread(pending));
    });

    test("a state changed since stays, and a newer suggestion is left alone", () => {
        const state = foldLog(
            log(
                comment("c1"),
                suggested,
                { type: "accept", by: "user", id: "c1" },
                { type: "reopen", by: "user", id: "c1" },
                { ...suggested, replace: "newer" },
                retract(3),
            ),
        );
        expect(thread(state)).toMatchObject({
            state: "replied",
            suggestion: { replace: "newer", status: "pending" },
        });
    });

    test("only the user's own thread events are retractable; unknown seqs change nothing", () => {
        const state = foldLog(log(comment("c1"), agentReply, userReply));
        expect([...state.retractable.keys()]).toEqual([3]);
        expect(state.retractable.get(3)).toMatchObject({ id: "c1", type: "reply", after: "open" });
        const same = foldLog(log(comment("c1"), agentReply, userReply, retract(2), retract(9)));
        expect(thread(same).messages).toHaveLength(3);
        expect(same.retractable.has(3)).toBe(true);
    });
});

/** Re-numbers a built event to sit at `seq` in a longer log. */
function at(seq: number) {
    return (event: Event): Event => ({ ...event, seq });
}

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
        expect(thread(state).anchor!.hint).toBe(anchor.hint + 2);
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
            const anchor = thread(await box.state(), id).anchor!;
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
            const anchor = thread(await box.state(), id).anchor!;
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
            const anchor = thread(await box.state(), id).anchor!;
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
        expect(thread(state).anchor!.hint).toBe(moved.indexOf("cold path"));
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
        expect(isWrong(final, thread(foldLog(log(...events, editInput(edit)))).anchor!)).toBe(true);
        const caughtUp = foldLog(log(...events, ...catchUpInputs(events, moved), editInput(edit)));
        expect(thread(caughtUp).anchor!.exact).toBe("ThQ cold ");
        expect(isWrong(final, thread(caughtUp).anchor!)).toBe(false);
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
                        expect(isWrong(final, thread(state).anchor!)).toBe(false);
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

describe("doc notes", () => {
    const note = (id: ThreadId, draft = false): EventInput => ({
        type: "comment",
        by: "user",
        id,
        text: "Tighten the whole thing?",
        draft,
    });
    const splice: EventInput = {
        type: "edit",
        by: "user",
        cause: "user",
        start: 0,
        before: "",
        after: "12345",
        line: 1,
        headingPath: [],
    };

    test("a comment without an anchor is an open doc note, never detached", () => {
        const state = foldLog(log(note("c1"), note("c2", true)));
        expect(isDocNote(thread(state))).toBe(true);
        expect(thread(state)).toMatchObject({ state: "open", detached: false, claimed: false });
        expect(thread(state).anchor).toBeUndefined();
        expect(thread(state, "c2").state).toBe("draft");
        expect(isDocNote(thread(foldLog(log(comment("c3"))), "c3"))).toBe(false);
    });

    test("splices and outside changes move anchored threads and leave a doc note alone", () => {
        const state = foldLog(
            log(note("c1"), comment("c2"), splice, {
                type: "outside",
                by: "user",
                hashBefore: "a",
                hashAfter: "b",
                edit: { start: 0, before: "", after: "ab" },
            }),
        );
        expect(thread(state).anchor).toBeUndefined();
        expect(thread(state, "c2").anchor!.hint).toBe(anchor.hint + 7);
    });

    test("re-pinning by quote skips doc notes", () => {
        const source = `some ${anchor.exact} here`;
        expect(reanchorInput(foldLog(log(note("c1"))), source)).toBeNull();
        const moved = reanchorInput(foldLog(log(note("c1"), comment("c2"))), source);
        expect(moved).toMatchObject({ type: "reanchor", anchors: { c2: expect.anything() } });
        expect(Object.keys((moved as { anchors: object }).anchors)).toEqual(["c2"]);
    });

    test("a doc note goes through claim, reply, resolve, delete and undelete like any thread", () => {
        const events = log(
            note("c1"),
            { type: "claim", by: "agent", ids: ["c1"] },
            { type: "reply", by: "agent", id: "c1", text: "Done." },
            { type: "resolve", by: "user", id: "c1" },
            { type: "delete", by: "user", id: "c1" },
            { type: "undelete", by: "user", id: "c1" },
        );
        const states = events.map((_, i) => thread(foldLog(events.slice(0, i + 1))).state);
        expect(states).toEqual(["open", "working", "replied", "resolved", "resolved", "resolved"]);
        expect(needsAgent(thread(foldLog(events.slice(0, 2))))).toBe(true);
        expect(withoutDeleted(foldLog(events.slice(0, 5))).threads.has("c1")).toBe(false);
        expect(thread(foldLog(events)).anchor).toBeUndefined();
    });
});

describe("doc verdict", () => {
    const approve = (closed?: ThreadId[]): EventInput => ({
        type: "verdict",
        by: "user",
        state: "approved",
        hash: "h1",
        ...(closed ? { closed } : {}),
    });
    const decline: EventInput = { type: "verdict", by: "user", state: "declined", hash: "h1" };
    const resolved: EventInput = { type: "resolve", by: "user", id: "c1" };
    const pendingSuggestion: EventInput = {
        type: "suggest",
        by: "agent",
        id: "c2",
        replace: "better words",
        apply: false,
    };

    test("a doc with no verdict is open; a verdict records its seq, time, hash and note", () => {
        expect(foldLog(log(comment("c1"))).verdict).toBeUndefined();
        const events = log(comment("c1"), resolved, {
            type: "verdict",
            by: "user",
            state: "approved",
            hash: "h1",
            note: "Ship it",
        });
        expect(foldLog(events).verdict).toEqual({
            state: "approved",
            seq: 3,
            at: events[2]!.at,
            hash: "h1",
            note: "Ship it",
        });
    });

    test("a verdict the agent signed is ignored: nothing is closed and the status stands", () => {
        const forged: EventInput = {
            type: "verdict",
            by: "agent",
            state: "approved",
            hash: "h9",
            closed: ["c1"],
        };
        const open = foldLog(log(comment("c1"), forged));
        expect(open.verdict).toBeUndefined();
        expect(thread(open, "c1").state).toBe("open");
        expect(open.version).toBe(2);

        const declined = foldLog(log(comment("c1"), decline, { ...forged, state: "open" }));
        expect(declined.verdict).toMatchObject({ state: "declined", seq: 2, hash: "h1" });
    });

    test("a verdict in a state this version does not know is ignored: no status, nothing closed, no reopen", () => {
        const unknown = {
            type: "verdict",
            by: "user",
            state: "shelved",
            hash: "h9",
            closed: ["c1"],
        } as unknown as EventInput;
        const alone = foldLog(log(comment("c1"), unknown, comment("c2")));
        expect(alone.verdict).toBeUndefined();
        expect(thread(alone, "c1").state).toBe("open");
        expect(alone.version).toBe(3);

        const standing = foldLog(log(comment("c1"), resolved, approve(), unknown));
        expect(standing.verdict).toMatchObject({ state: "approved", seq: 3, hash: "h1" });
    });

    test("any state follows any other, and the later verdict replaces the note and hash", () => {
        const state = foldLog(
            log(
                { type: "verdict", by: "user", state: "declined", hash: "h1", note: "No" },
                { type: "verdict", by: "user", state: "approved", hash: "h2" },
                { type: "verdict", by: "user", state: "open", hash: "h3" },
            ),
        );
        expect(state.verdict).toMatchObject({ state: "open", seq: 3, hash: "h3" });
        expect(state.verdict?.note).toBeUndefined();
    });

    test("approve as is resolves the closed threads and rejects a pending suggestion", () => {
        const events = log(
            comment("c1"),
            comment("c2"),
            comment("c3", true),
            pendingSuggestion,
            approve(["c1", "c2", "c3"]),
        );
        const state = foldLog(events);
        expect([...state.threads.values()].map((thread) => thread.state)).toEqual([
            "resolved",
            "resolved",
            "resolved",
        ]);
        expect(thread(state, "c2").suggestion?.status).toBe("rejected");
        expect(thread(state, "c1").lastActivity).toBe(events[4]!.at);
        expect(state.verdict).toMatchObject({ state: "approved", closed: ["c1", "c2", "c3"] });
        expect(unresolvedThreads(state)).toEqual([]);
    });

    test("the verdict's own closing neither reopens the doc nor leaves a thread to wake on", () => {
        const state = foldLog(log(comment("c1"), decline, approve(["c1"])));
        expect(state.verdict).toMatchObject({ state: "approved", seq: 3 });
        expect([...state.threads.values()].some(needsAgent)).toBe(false);
    });

    test("a closed thread already resolved keeps its time and its accepted suggestion", () => {
        const events = log(
            comment("c1"),
            comment("c2"),
            pendingSuggestion,
            { type: "accept", by: "user", id: "c2" },
            approve(["c1", "c2", "c9"]),
        );
        const state = foldLog(events);
        expect(thread(state, "c2").suggestion?.status).toBe("accepted");
        expect(thread(state, "c2").lastActivity).toBe(events[3]!.at);
    });

    test("closing is not retractable, and an older retract cannot revive a closed thread", () => {
        const userReply: EventInput = { type: "reply", by: "user", id: "c1", text: "Hm" };
        const agentReply: EventInput = { type: "reply", by: "agent", id: "c1", text: "Done" };
        const events = log(comment("c1"), agentReply, userReply, approve(["c1"]), {
            type: "retract",
            by: "user",
            id: "c1",
            of: 3,
        });
        expect(foldLog(events.slice(0, 3)).retractable.has(3)).toBe(true);
        expect(foldLog(events.slice(0, 4)).retractable.size).toBe(0);
        const after = foldLog(events);
        expect(thread(after).state).toBe("resolved");
        expect(thread(after).messages).toHaveLength(3);
        expect(after.verdict?.state).toBe("approved");
    });

    test("a thread the verdict did not close stays retractable", () => {
        const state = foldLog(log(comment("c1"), comment("c2"), resolved, approve(["c2"])));
        expect([...state.retractable.keys()]).toEqual([3]);
    });

    describe("auto-reopen", () => {
        const base = [comment("c1"), resolved, approve()];
        const reopening: [string, EventInput[], EventInput][] = [
            ["a comment", base, comment("c2")],
            ["a held draft", base, comment("c2", true)],
            ["a reply", base, { type: "reply", by: "user", id: "c1", text: "One more" }],
            [
                "a suggestion",
                base,
                { type: "suggest", by: "user", id: "c2", anchor, replace: "new", apply: false },
            ],
            [
                "a reject with a note",
                base,
                { type: "reject", by: "user", id: "c1", note: "Try again" },
            ],
            ["a thread reopened", base, { type: "reopen", by: "user", id: "c1" }],
            [
                "an unresolved thread undeleted",
                [comment("c1"), { type: "delete", by: "user", id: "c1" }, approve()],
                { type: "undelete", by: "user", id: "c1" },
            ],
            [
                "a retract that revives a thread",
                base,
                { type: "retract", by: "user", id: "c1", of: 2 },
            ],
            [
                "a finish request",
                [comment("c1"), decline],
                { type: "finish", by: "user", ids: ["c1"] },
            ],
        ];
        for (const [name, before, trigger] of reopening) {
            test(`${name} by the user reopens an approved or declined doc`, () => {
                const events = log(...before, trigger);
                const state = foldLog(events);
                const last = events.at(-1)!;
                expect(state.verdict).toEqual({ state: "open", seq: last.seq, at: last.at });
            });
        }

        const quiet: [string, EventInput[], EventInput][] = [
            ["an agent reply", base, { type: "reply", by: "agent", id: "c1", text: "Done" }],
            [
                "an agent thread",
                base,
                { type: "suggest", by: "agent", id: "c2", anchor, replace: "new", apply: false },
            ],
            ["a plain reject", base, { type: "reject", by: "user", id: "c1" }],
            ["a resolve", [comment("c1"), decline], resolved],
            ["a delete", [comment("c1"), decline], { type: "delete", by: "user", id: "c1" }],
            [
                "a resolved thread undeleted",
                [comment("c1"), resolved, { type: "delete", by: "user", id: "c1" }, approve()],
                { type: "undelete", by: "user", id: "c1" },
            ],
            [
                "a retract that revives nothing",
                [comment("c1"), { type: "reply", by: "user", id: "c1", text: "Hm" }, decline],
                { type: "retract", by: "user", id: "c1", of: 2 },
            ],
            [
                "a retract of an unknown seq",
                base,
                { type: "retract", by: "user", id: "c1", of: 99 },
            ],
            [
                "a reply to an unknown thread",
                base,
                { type: "reply", by: "user", id: "c9", text: "?" },
            ],
            [
                "an edit",
                base,
                {
                    type: "edit",
                    by: "user",
                    cause: "user",
                    start: 0,
                    before: "a",
                    after: "b",
                    line: 1,
                    headingPath: [],
                },
            ],
            ["a hold", base, { type: "hold", by: "user", on: true }],
        ];
        for (const [name, before, event] of quiet) {
            test(`${name} leaves the verdict standing`, () => {
                const settled = foldLog(log(...before)).verdict;
                expect(settled?.state).not.toBe("open");
                expect(foldLog(log(...before, event)).verdict).toEqual(settled!);
            });
        }

        test("activity on an open doc leaves it without a verdict", () => {
            expect(foldLog(log(comment("c1"), comment("c2"))).verdict).toBeUndefined();
            const reopened = foldLog(
                log(comment("c1"), decline, comment("c2"), comment("c3")),
            ).verdict;
            expect(reopened).toMatchObject({ state: "open", seq: 3 });
        });
    });

    describe("finish", () => {
        const finish = (...ids: ThreadId[]): EventInput => ({ type: "finish", by: "user", ids });

        test("hands drafts, replied and working threads to the agent as open", () => {
            const events = log(
                comment("c1", true),
                comment("c2"),
                comment("c3"),
                comment("c4"),
                { type: "claim", by: "agent", ids: ["c2", "c3"] },
                { type: "reply", by: "agent", id: "c3", text: "Done" },
                { type: "resolve", by: "user", id: "c4" },
                finish("c1", "c2", "c3", "c4"),
            );
            const state = foldLog(events);
            expect([...state.threads.values()].map((thread) => thread.state)).toEqual([
                "open",
                "open",
                "open",
                "resolved",
            ]);
            expect(thread(state, "c3").claimed).toBe(true);
            expect(state.finish).toEqual({
                seq: 8,
                at: events[7]!.at,
                ids: ["c1", "c2", "c3", "c4"],
            });
            expect(finishRemaining(state)).toEqual(["c1", "c2", "c3"]);
            expect(state.verdict).toBeUndefined();
        });

        test("a finish the agent signed is ignored: drafts stay held and no request stands", () => {
            const state = foldLog(
                log(comment("c1", true), approve(), { type: "finish", by: "agent", ids: ["c1"] }),
            );
            expect(thread(state, "c1").state).toBe("draft");
            expect(state.finish).toBeUndefined();
            expect(finishRemaining(state)).toEqual([]);
            expect(state.verdict).toMatchObject({ state: "approved" });
        });

        test("is outstanding until every thread is resolved or deleted", () => {
            const base = [comment("c1"), comment("c2"), finish("c1", "c2")];
            expect(finishRemaining(foldLog(log(...base)))).toEqual(["c1", "c2"]);
            const one = foldLog(log(...base, { type: "resolve", by: "agent", id: "c1" }));
            expect(finishRemaining(one)).toEqual(["c2"]);
            const done = foldLog(
                log(
                    ...base,
                    { type: "resolve", by: "agent", id: "c1" },
                    { type: "delete", by: "user", id: "c2" },
                ),
            );
            expect(finishRemaining(done)).toEqual([]);
            expect(done.finish?.ids).toEqual(["c1", "c2"]);
        });

        test("a thread outside the request is not part of what remains", () => {
            const state = foldLog(log(comment("c1"), finish("c1"), comment("c2")));
            expect(finishRemaining(state)).toEqual(["c1"]);
            expect(finishRemaining(foldLog(log(comment("c1"))))).toEqual([]);
        });

        test("any verdict clears the request", () => {
            const state = foldLog(log(comment("c1"), finish("c1"), decline));
            expect(state.finish).toBeUndefined();
            expect(finishRemaining(state)).toEqual([]);
            expect(thread(state).state).toBe("open");
        });
    });

    test("unresolved means every state but resolved, deleted threads left out", () => {
        const state = foldLog(
            log(
                comment("c1", true),
                comment("c2"),
                comment("c3"),
                comment("c4"),
                comment("c5"),
                comment("c6"),
                { type: "claim", by: "agent", ids: ["c3"] },
                { type: "reply", by: "agent", id: "c4", text: "Done" },
                { type: "resolve", by: "user", id: "c5" },
                { type: "delete", by: "user", id: "c6" },
            ),
        );
        expect(unresolvedThreads(state).map((thread) => [thread.id, thread.state])).toEqual([
            ["c1", "draft"],
            ["c2", "open"],
            ["c3", "working"],
            ["c4", "replied"],
        ]);
        expect(isUnresolved(thread(state, "c5"))).toBe(false);
        expect(isUnresolved(thread(state, "c6"))).toBe(true);
    });
});
