import { describe, expect, test } from "bun:test";
import { createAnchor } from "../core/anchor.ts";
import { hashText, parseDoc } from "../core/blocks.ts";
import type {
    DocSnapshot,
    Event,
    EventInput,
    Thread,
    ThreadId,
    ThreadState,
} from "../core/model.ts";
import { foldLog, unresolvedThreads } from "../core/threads.ts";
import {
    anchoredThreads,
    buildView,
    docNotes,
    docNotesBusy,
    firstUnresolved,
    headingSlugs,
    latestAgentSeq,
    needsDeleteConfirm,
    reviewModel,
    threadStatus,
    unresolvedKind,
} from "./view-model.ts";

const source = "# Title\n\nOne sentence here. Another sentence there.\n";

function snapshotWith(states: ThreadState[]): DocSnapshot {
    const threads: Thread[] = states.map((state, index) => {
        const exact = index === 0 ? "One sentence" : "Another sentence";
        const start = source.indexOf(exact);
        return {
            id: `c${index + 1}`,
            state,
            anchor: createAnchor(source, { start, end: start + exact.length }),
            detached: false,
            createdBy: "user",
            messages: [],
            claimed: false,
            lastActivity: "2026-09-30T12:00:00Z",
        };
    });
    return {
        path: "doc.md",
        doc: parseDoc(source),
        threads,
        edits: [],
        settings: { hold: false, autoApply: false },
        missing: false,
        version: 1,
    };
}

describe("buildView decorations", () => {
    test("resolved threads leave their text unmarked by default", () => {
        const view = buildView(snapshotWith(["open", "resolved"]));
        expect(view.decorations.map((decoration) => [decoration.id, decoration.kind])).toEqual([
            ["c1", "comment"],
        ]);
        expect(view.order).toEqual(["c1"]);
    });

    test("show resolved paints them with the faint kind", () => {
        const view = buildView(snapshotWith(["open", "resolved"]), true);
        expect(view.decorations.map((decoration) => [decoration.id, decoration.kind])).toEqual([
            ["c1", "comment"],
            ["c2", "resolved"],
        ]);
    });
});

describe("headingSlugs", () => {
    test("GitHub-style anchors, repeats numbered", () => {
        expect(
            headingSlugs([
                "1. Verdict",
                "What's next?",
                "A/B & C — notes",
                "Überblick",
                "Setup",
                "Setup",
                "Setup-1",
                "snake_case `code`",
            ]),
        ).toEqual([
            "1-verdict",
            "whats-next",
            "ab--c--notes",
            "überblick",
            "setup",
            "setup-1",
            "setup-1-1",
            "snake_case-code",
        ]);
    });
});

describe("threadStatus", () => {
    const anchor = createAnchor(source, { start: 9, end: 21 });
    const now = Date.parse("2026-09-30T12:00:00Z");
    const log: Event[] = [];
    const append = (...inputs: EventInput[]) => {
        for (const input of inputs) {
            const seq = log.length + 1;
            log.push({ ...input, seq, at: new Date(now + seq * 1000).toISOString() } as Event);
        }
    };
    const status = () => {
        const state = foldLog(log);
        return threadStatus(state.threads.get("c1")!, now + 60_000);
    };

    test("open until the watch cursor passes, notified until claimed", () => {
        append({ type: "comment", by: "user", id: "c1", anchor, text: "Why?", draft: false });
        expect(status()).toBe("open");
        append({ type: "cursor", by: "agent", stream: "watch", upTo: 1 });
        expect(status()).toBe("notified");
        append({ type: "claim", by: "agent", ids: ["c1"] });
        expect(status()).toBe("working");
    });

    test("a reopened thread with a new reply waits for the next watch cursor", () => {
        append(
            { type: "reply", by: "agent", id: "c1", text: "Because." },
            { type: "resolve", by: "user", id: "c1" },
            { type: "reopen", by: "user", id: "c1" },
            { type: "reply", by: "user", id: "c1", text: "Not quite." },
        );
        expect(status()).toBe("open");
        append({ type: "cursor", by: "agent", stream: "watch", upTo: log.length });
        expect(status()).toBe("notified");
        append({ type: "claim", by: "agent", ids: ["c1"] });
        expect(status()).toBe("working");
    });

    test("only a cursor that names the thread notifies it; an older one names every thread", () => {
        log.length = 0;
        append({ type: "comment", by: "user", id: "c1", anchor, text: "Why?", draft: false });
        append({ type: "cursor", by: "agent", stream: "watch", upTo: 1, ids: [] });
        expect(status()).toBe("open");
        append({ type: "cursor", by: "agent", stream: "watch", upTo: 2, ids: ["c2"] });
        expect(status()).toBe("open");
        append({ type: "cursor", by: "agent", stream: "watch", upTo: 3, ids: ["c1"] });
        expect(status()).toBe("notified");
        append({ type: "reply", by: "user", id: "c1", text: "And?" });
        expect(status()).toBe("open");
        append({ type: "cursor", by: "agent", stream: "watch", upTo: 5 });
        expect(status()).toBe("notified");
    });

    test("a draft is never notified", () => {
        const thread: Thread = {
            id: "c9",
            state: "draft",
            anchor,
            detached: false,
            createdBy: "user",
            messages: [],
            claimed: false,
            lastActivity: "2026-09-30T12:00:00Z",
            notifiedAt: "2026-09-30T12:05:00Z",
        };
        expect(threadStatus(thread, now)).toBe("draft");
    });
});

describe("buildView user edits", () => {
    const edit = (seq: number, of?: number): DocSnapshot["edits"][number] => ({
        seq,
        at: `2026-09-30T12:00:${String(seq).padStart(2, "0")}Z`,
        by: "user",
        type: "edit",
        cause: of === undefined ? "user" : "undo",
        ...(of === undefined ? {} : { of }),
        start: 0,
        before: seq % 2 ? "One" : "Two",
        after: seq % 2 ? "Two" : "One",
        line: 1,
        headingPath: [],
    });
    const cards = (edits: DocSnapshot["edits"]) =>
        buildView({ ...snapshotWith([]), edits }, true).userEdits.map((e) => e.seq);

    test("edit cards show with resolved threads and count with them, never in j/k or the outline", () => {
        const snapshot = { ...snapshotWith(["open", "resolved"]), edits: [edit(1), edit(2)] };
        const shown = buildView(snapshot, true);
        const hidden = buildView(snapshot, false);
        expect(shown.userEdits.map((e) => e.seq)).toEqual([1, 2]);
        expect(hidden.userEdits).toEqual([]);
        expect(shown.settled).toBe(3);
        expect(hidden.settled).toBe(3);
        expect(hidden.order).toEqual(shown.order);
        expect(shown.order).toEqual(["c1"]);
        expect(hidden.outline).toEqual(shown.outline);
        expect(shown.outline[0]!.openThreads).toBe(1);
    });

    test("an undone edit has no card; a redone one has one, which names the redo's seq", () => {
        expect(cards([edit(1)])).toEqual([1]);
        expect(cards([edit(1), edit(2, 1)])).toEqual([]);
        expect(cards([edit(1), edit(2, 1), edit(3, 2)])).toEqual([3]);
        expect(cards([edit(1), edit(2, 1), edit(3, 2), edit(4, 3)])).toEqual([]);
    });

    test("a follow-through thread hides the card of the edit it names, the redo included", () => {
        const snapshot = snapshotWith(["open"]);
        snapshot.threads[0]!.followsEdit = 3;
        const view = buildView({ ...snapshot, edits: [edit(1), edit(2, 1), edit(3, 2)] }, true);
        expect(view.userEdits).toEqual([]);
        expect(view.settled).toBe(0);
    });
});

describe("needsDeleteConfirm", () => {
    test("drafts delete at once, every other thread asks first", () => {
        const states: ThreadState[] = ["draft", "open", "working", "replied", "resolved"];
        const threads = snapshotWith(states).threads;
        expect(threads.map(needsDeleteConfirm)).toEqual([false, true, true, true, true]);
    });
});

describe("doc notes in the view", () => {
    const at = "2026-09-30T12:00:00Z";
    const note = (
        id: `c${number}`,
        state: ThreadState,
        agentSeq?: number,
        notifiedAt?: string,
    ): Thread => ({
        id,
        state,
        detached: false,
        createdBy: "user",
        messages: [
            { seq: 1, at, by: "user", text: "Overall?" },
            ...(agentSeq === undefined
                ? []
                : [{ seq: agentSeq, at, by: "agent" as const, text: "Yes." }]),
        ],
        claimed: false,
        lastActivity: at,
        ...(notifiedAt ? { notifiedAt } : {}),
    });

    test("they get no range, decoration, outline count or place in the j/k order", () => {
        const snapshot = snapshotWith(["open"]);
        snapshot.threads.push(note("c7", "open"));
        const view = buildView(snapshot);
        expect(view.order).toEqual(["c1"]);
        expect(view.ranges.has("c7")).toBe(false);
        expect(view.decorations.map((decoration) => decoration.id)).toEqual(["c1"]);
        expect(view.outline.map((entry) => entry.openThreads)).toEqual([1]);
        expect(anchoredThreads(snapshot.threads).map((thread) => thread.id)).toEqual(["c1"]);
    });

    test("docNotes keeps notes only, resolved ones on request", () => {
        const threads = [
            ...snapshotWith(["open"]).threads,
            note("c7", "open"),
            note("c8", "resolved"),
        ];
        expect(docNotes(threads, false).map((thread) => thread.id)).toEqual(["c7"]);
        expect(docNotes(threads, true).map((thread) => thread.id)).toEqual(["c7", "c8"]);
    });

    test("latestAgentSeq is the newest agent message across the notes, 0 with none", () => {
        expect(latestAgentSeq([note("c7", "open")])).toBe(0);
        expect(latestAgentSeq([note("c7", "replied", 4), note("c8", "replied", 9)])).toBe(9);
    });

    test("docNotesBusy while the agent is notified of or responding to a note", () => {
        const now = Date.parse(at) + 60_000;
        const seen = "2026-09-30T12:00:30Z";
        expect(docNotesBusy([note("c7", "open")], now)).toBe(false);
        expect(docNotesBusy([note("c7", "open", undefined, seen)], now)).toBe(true);
        expect(docNotesBusy([note("c7", "working")], now)).toBe(true);
        expect(docNotesBusy([note("c7", "replied", 3, seen)], now)).toBe(false);
    });
});

describe("reviewModel", () => {
    const hash = hashText(source);
    const at = "2026-09-30T12:00:00Z";

    test("an open doc with nothing unresolved has nothing to count", () => {
        const model = reviewModel(snapshotWith(["resolved"]), hash);
        expect(model).toMatchObject({ state: "open", unresolved: [], accepts: 0, hands: 0 });
        expect(model.verdict).toBeUndefined();
        expect(model.finish).toBeUndefined();
    });

    test("each unresolved thread is one kind, the agent's pending suggestion first after a draft", () => {
        const snapshot = snapshotWith(["draft", "open", "working", "replied", "replied", "open"]);
        const [, , , , suggested, own] = snapshot.threads;
        suggested!.suggestion = { seq: 9, by: "agent", replace: "x", status: "pending" };
        own!.suggestion = { seq: 10, by: "user", replace: "y", status: "pending" };
        expect(snapshot.threads.map(unresolvedKind)).toEqual([
            "draft",
            "agent",
            "agent",
            "user",
            "suggestion",
            "agent",
        ]);
        const model = reviewModel(snapshot, hash);
        expect(model.counts).toEqual({ agent: 3, user: 1, suggestion: 1, draft: 1 });
        expect(model).toMatchObject({ accepts: 1, hands: 5 });
    });

    test("a rejected or accepted suggestion is not pending", () => {
        const snapshot = snapshotWith(["replied", "open"]);
        snapshot.threads[0]!.suggestion = { seq: 3, by: "agent", replace: "x", status: "rejected" };
        snapshot.threads[1]!.suggestion = { seq: 4, by: "agent", replace: "x", status: "accepted" };
        expect(snapshot.threads.map(unresolvedKind)).toEqual(["user", "agent"]);
    });

    test("the counts add up to exactly the threads the server refuses an approval on", () => {
        const log: Event[] = [];
        const append = (...inputs: EventInput[]) => {
            for (const input of inputs) {
                const seq = log.length + 1;
                log.push({ ...input, seq, at } as Event);
            }
        };
        const anchor = createAnchor(source, { start: 9, end: 21 });
        const comment = (id: ThreadId, draft = false): EventInput => ({
            type: "comment",
            by: "user",
            id,
            anchor,
            text: "Why?",
            draft,
        });
        append(
            comment("c1"),
            comment("c2"),
            comment("c3"),
            comment("c4"),
            comment("c5"),
            comment("c6", true),
            comment("c7"),
            { type: "comment", by: "user", id: "c8", text: "A doc note", draft: false },
            { type: "claim", by: "agent", ids: ["c2"] },
            { type: "reply", by: "agent", id: "c3", text: "Because." },
            { type: "suggest", by: "agent", id: "c4", replace: "One line", apply: false },
            { type: "resolve", by: "user", id: "c5" },
            { type: "delete", by: "user", id: "c7" },
        );
        const state = foldLog(log);
        const refused = unresolvedThreads(state).map((thread) => thread.id);
        const snapshot: DocSnapshot = {
            ...snapshotWith([]),
            threads: [...state.threads.values()].filter((thread) => !state.deleted.has(thread.id)),
        };
        const model = reviewModel(snapshot, hash);
        expect(model.unresolved).toEqual(refused);
        expect(refused).toEqual(["c1", "c2", "c3", "c4", "c6", "c8"]);
        const total = Object.values(model.counts).reduce((sum, each) => sum + each, 0);
        expect(total).toBe(refused.length);
        expect(model.counts).toEqual({ agent: 3, user: 1, suggestion: 1, draft: 1 });
        expect(model.accepts + model.hands).toBe(refused.length);
    });

    test("changed since is for an approved doc whose hash moved", () => {
        const approved = { state: "approved" as const, seq: 2, at, hash };
        const snapshot = { ...snapshotWith(["resolved"]), verdict: approved };
        expect(reviewModel(snapshot, hash)).toMatchObject({ state: "approved", changed: false });
        expect(reviewModel(snapshot, "0badf00d")).toMatchObject({ changed: true });
        expect(reviewModel(snapshot, hash).verdict).toEqual(approved);
    });

    test("a dropped doc is never changed, nor is a verdict that recorded no hash", () => {
        const base = snapshotWith(["open"]);
        const dropped = { ...base, verdict: { state: "dropped" as const, seq: 2, at, hash } };
        expect(reviewModel(dropped, "0badf00d").changed).toBe(false);
        const bare = { ...base, verdict: { state: "approved" as const, seq: 2, at } };
        expect(reviewModel(bare, "0badf00d").changed).toBe(false);
    });

    test("an automatic reopen reads as open, with no standing verdict", () => {
        const snapshot = {
            ...snapshotWith(["open"]),
            verdict: { state: "open" as const, seq: 5, at },
        };
        const model = reviewModel(snapshot, "0badf00d");
        expect(model).toMatchObject({ state: "open", changed: false });
        expect(model.verdict).toBeUndefined();
    });

    test("finish progress counts the request's threads still unresolved", () => {
        const snapshot: DocSnapshot = {
            ...snapshotWith(["open", "resolved", "open"]),
            finish: { seq: 4, at, ids: ["c1", "c2", "c9"] },
        };
        expect(reviewModel(snapshot, hash).finish).toEqual({ total: 3, remaining: 1 });
        snapshot.threads[0]!.state = "resolved";
        const done = reviewModel(snapshot, hash);
        expect(done.finish).toEqual({ total: 3, remaining: 0 });
        expect(done.unresolved).toEqual(["c3"]);
    });

    test("a finish request is ignored once a verdict stands", () => {
        const snapshot: DocSnapshot = {
            ...snapshotWith(["open"]),
            verdict: { state: "dropped", seq: 6, at, hash },
            finish: { seq: 4, at, ids: ["c1"] },
        };
        expect(reviewModel(snapshot, hash).finish).toBeUndefined();
    });
});

describe("firstUnresolved", () => {
    test("the first thread in document order", () => {
        const snapshot = snapshotWith(["resolved", "open"]);
        expect(firstUnresolved(buildView(snapshot), snapshot.threads)).toBe("c2");
    });

    test("a doc note when no anchored thread is left, nothing when all are settled", () => {
        const snapshot = snapshotWith(["resolved", "replied"]);
        snapshot.threads[1]!.anchor = undefined;
        expect(firstUnresolved(buildView(snapshot), snapshot.threads)).toBe("c2");
        const settled = snapshotWith(["resolved"]);
        expect(firstUnresolved(buildView(settled), settled.threads)).toBeUndefined();
    });
});
