import { describe, expect, test } from "bun:test";
import { hashText } from "../../core/blocks.ts";
import { MemoryStore } from "../../../mockup/memory-store.ts";
import { reviewModel, type ReviewModel } from "../view-model.ts";
import {
    asIsWarning,
    canAskToFinish,
    finishOutcome,
    kindLines,
    labelText,
    reviewLabel,
    unappliedLine,
    unresolvedHead,
    unresolvedSubhead,
    verdictActions,
} from "./review-menu.tsx";

const none = { agent: 0, user: 0, suggestion: 0, draft: 0 };

function model(change: Partial<ReviewModel> = {}): ReviewModel {
    return {
        state: "open",
        unresolved: [],
        counts: none,
        changed: false,
        accepts: 0,
        hands: 0,
        ...change,
    };
}

describe("reviewLabel", () => {
    const text = (change: Partial<ReviewModel>) => labelText(reviewLabel(model(change)));

    test("an open doc reads Review, with threads unresolved or not", () => {
        expect(reviewLabel(model())).toEqual({ tone: "open", lead: "Review", rest: "" });
        expect(text({ unresolved: ["c1"] })).toBe("Review");
    });

    test("a verdict is the label; only an approval carries changed since", () => {
        expect(text({ state: "approved" })).toBe("Approved");
        expect(reviewLabel(model({ state: "approved", changed: true }))).toEqual({
            tone: "approved",
            lead: "Approved",
            rest: ", changed since",
            badge: "",
        });
        expect(reviewLabel(model({ state: "declined", changed: true }))).toEqual({
            tone: "declined",
            lead: "Declined",
            rest: "",
        });
    });

    test("a finish request counts down, then reads ready once nothing is unresolved", () => {
        const finishing = model({ unresolved: ["c1", "c2"], finish: { total: 3, remaining: 2 } });
        expect(reviewLabel(finishing)).toEqual({
            tone: "finishing",
            lead: "Finishing",
            rest: ", 2 left",
            badge: "2",
        });
        expect(reviewLabel(model({ finish: { total: 3, remaining: 0 } }))).toEqual({
            tone: "ready",
            lead: "Ready",
            rest: " to approve",
        });
    });

    test("a settled finish request with newer threads unresolved is back to Review", () => {
        expect(text({ unresolved: ["c7"], finish: { total: 3, remaining: 0 } })).toBe("Review");
    });
});

describe("verdictActions", () => {
    const shown = (change: Partial<ReviewModel>) =>
        verdictActions(model(change)).map((action) => [action.label, action.state, action.look]);

    test("an open doc with nothing unresolved offers Approve first, then Decline", () => {
        expect(shown({})).toEqual([
            ["Approve", "approved", "accept"],
            ["Decline", "declined", "danger"],
        ]);
    });

    test("with threads unresolved Approve keeps its place before Decline, disabled", () => {
        expect(shown({ unresolved: ["c1"] })).toEqual([
            ["Approve", "approved", "accept"],
            ["Decline", "declined", "danger"],
        ]);
        const disabled = (change: Partial<ReviewModel>) =>
            verdictActions(model(change)).map((action) => action.disabled ?? false);
        expect(disabled({ unresolved: ["c1"] })).toEqual([true, false]);
        expect(disabled({})).toEqual([false, false]);
        expect(disabled({ state: "approved" })).toEqual([false, false]);
    });

    test("an approved doc reopens first, then declines", () => {
        expect(shown({ state: "approved" })).toEqual([
            ["Reopen", "open", "primary"],
            ["Decline instead", "declined", "danger"],
        ]);
    });

    test("a declined doc only reopens, with or without threads unresolved", () => {
        expect(shown({ state: "declined" })).toEqual([["Reopen", "open", "primary"]]);
        expect(shown({ state: "declined", unresolved: ["c1", "c2"] })).toEqual([
            ["Reopen", "open", "primary"],
        ]);
    });

    test("every button carries an icon that matches what it does", () => {
        const icons = (change: Partial<ReviewModel>) =>
            verdictActions(model(change)).map((action) => action.icon);
        expect(icons({})).toEqual(["check", "slash"]);
        expect(icons({ state: "approved" })).toEqual(["reopen", "slash"]);
        expect(icons({ state: "declined" })).toEqual(["reopen"]);
    });
});

describe("popover copy", () => {
    test("only the kinds present, singular and plural", () => {
        expect(kindLines({ agent: 2, user: 1, suggestion: 1, draft: 1 })).toEqual([
            "2 comments waiting on your agent",
            "1 agent reply waiting on you",
            "1 pending suggestion",
            "1 held draft",
        ]);
        expect(kindLines({ agent: 1, user: 3, suggestion: 0, draft: 2 })).toEqual([
            "1 comment waiting on your agent",
            "3 agent replies waiting on you",
            "2 held drafts",
        ]);
        expect(kindLines(none)).toEqual([]);
    });

    test("the heading and the line under it, singular and plural", () => {
        expect(unresolvedHead(1)).toBe("You have 1 unresolved thread");
        expect(unresolvedHead(9)).toBe("You have 9 unresolved threads");
        expect(unresolvedSubhead(1)).toBe("Decide how to handle it before approving");
        expect(unresolvedSubhead(9)).toBe("Decide how to handle them before approving");
    });

    test("approve as is says what it leaves undone", () => {
        expect(asIsWarning(5)).toBe(
            "Closes the 5 threads without action. Pending suggestions are not applied.",
        );
        expect(asIsWarning(1)).toBe(
            "Closes the thread without action. Pending suggestions are not applied.",
        );
    });

    test("the finish outcome follows the numbers too", () => {
        expect(finishOutcome(1, 4)).toBe("Accepted 1 suggestion. Sent 4 threads to your agent.");
        expect(finishOutcome(0, 1)).toBe("Sent 1 thread to your agent.");
        expect(finishOutcome(2, 0)).toBe("Accepted 2 suggestions.");
        expect(finishOutcome(0, 0)).toBe("Nothing was left to send.");
        expect(unappliedLine(1)).toBe("1 suggestion could not be applied and went to your agent");
        expect(unappliedLine(2)).toBe("2 suggestions could not be applied and went to your agent");
    });

    test("asking to finish is offered until the agent already has every thread", () => {
        const counts = { ...none, agent: 2 };
        const handed: Partial<ReviewModel> = {
            unresolved: ["c1", "c2"],
            counts,
            finish: { total: 2, remaining: 2 },
        };
        expect(canAskToFinish(model({ unresolved: ["c1", "c2"], counts }))).toBe(true);
        expect(canAskToFinish(model(handed))).toBe(false);
        expect(canAskToFinish(model({ ...handed, counts: { ...none, agent: 1, user: 1 } }))).toBe(
            true,
        );
        expect(canAskToFinish(model({ ...handed, unresolved: ["c1", "c2", "c3"] }))).toBe(true);
        expect(canAskToFinish(model())).toBe(false);
    });
});

describe("against the store", () => {
    const source = "# Title\n\nThe first paragraph says something plain.\n";
    const read = (store: MemoryStore) => {
        const snapshot = store.snapshot();
        return reviewModel(snapshot, hashText(snapshot.doc.source));
    };

    test("the unresolved total is what an approval is refused on", async () => {
        const store = new MemoryStore("doc.md", source);
        const open = await store.comment({ text: "A doc note" });
        const replied = await store.comment({ text: "Another" });
        store.agentReply(replied, "Noted.");
        const done = await store.comment({ text: "Settled" });
        await store.resolve(done);
        const gone = await store.comment({ text: "Deleted" });
        await store.deleteThread(gone);
        await store.setHold(true);
        const held = await store.comment({ text: "Held" });

        const before = read(store);
        expect(before.unresolved).toEqual([open, replied, held]);
        expect(await store.setVerdict({ state: "approved" })).toEqual({
            ok: false,
            reason: "unresolved",
            ids: before.unresolved,
        });
    });

    test("the label follows a finish request through to the approval and an edit after", async () => {
        const store = new MemoryStore("doc.md", source);
        const label = () => labelText(reviewLabel(read(store)));
        const first = await store.comment({ text: "One" });
        const second = await store.comment({ text: "Two" });
        expect(label()).toBe("Review");

        const preview = read(store);
        const result = await store.requestFinish();
        expect(result.ids).toHaveLength(preview.hands);
        expect(label()).toBe("Finishing, 2 left");
        store.agentResolve(first);
        expect(label()).toBe("Finishing, 1 left");
        store.agentResolve(second);
        expect(label()).toBe("Ready to approve");

        await store.setVerdict({ state: "approved" });
        expect(label()).toBe("Approved");
        const { doc } = store.snapshot();
        const start = doc.source.indexOf("plain");
        store.simulateOutsideChange({ start, end: start + 5 }, "simple");
        expect(label()).toBe("Approved, changed since");

        await store.setVerdict({ state: "declined" });
        expect(label()).toBe("Declined");
        await store.setVerdict({ state: "open" });
        expect(label()).toBe("Review");
    });
});
