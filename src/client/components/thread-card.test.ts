import { describe, expect, test } from "bun:test";
import type { ThreadState } from "../../core/model.ts";
import {
    cardRow,
    isFilled,
    revertAction,
    suggestionActions,
    type CardAction,
    type CardRowState,
} from "./thread-card.tsx";

function row(change: Partial<CardRowState> = {}): CardAction[] {
    return cardRow({
        state: "open",
        hold: false,
        pending: false,
        hasText: false,
        confirming: false,
        ...change,
    });
}

function looks(actions: CardAction[]): string[] {
    return actions.map((action) => `${action.label}: ${action.look}`);
}

const states: ThreadState[] = ["draft", "open", "working", "replied", "resolved"];
const flags = [false, true];

describe("cardRow", () => {
    test("a live thread offers a soft delete, a quiet resolve and the reply", () => {
        for (const state of ["open", "working", "replied"] as const) {
            expect(looks(row({ state }))).toEqual([
                "Delete: danger-soft",
                "Resolve: accept-quiet",
                "Reply: primary",
            ]);
        }
    });

    test("a held draft adds to itself; a draft that is not held replies", () => {
        expect(row({ state: "draft", hold: true }).at(-1)).toMatchObject({
            id: "send",
            label: "Add",
            icon: "plus",
        });
        expect(row({ state: "draft" }).at(-1)).toMatchObject({ label: "Reply", icon: "send" });
        expect(row({ state: "open", hold: true }).at(-1)).toMatchObject({ label: "Reply" });
    });

    test("typed text on a pending suggestion turns resolve into reject with note", () => {
        expect(looks(row({ pending: true, hasText: true }))).toEqual([
            "Delete: danger-soft",
            "Reject with note: danger-quiet",
            "Reply: primary",
        ]);
        expect(row({ pending: true }).map((action) => action.id)).toContain("resolve");
        expect(row({ hasText: true }).map((action) => action.id)).toContain("resolve");
    });

    test("a resolved thread stays quiet: no filled button", () => {
        const actions = row({ state: "resolved" });
        expect(looks(actions)).toEqual(["Delete: danger-soft", "Reopen: neutral"]);
        expect(actions.some((action) => isFilled(action.look))).toBe(false);
    });

    test("confirming a delete replaces the row, whatever the thread's state", () => {
        for (const state of states) {
            expect(looks(row({ state, confirming: true }))).toEqual([
                "Cancel: neutral",
                "Delete: danger",
            ]);
        }
    });

    test("no row holds more than one filled button, and ids are unique within it", () => {
        for (const state of states) {
            for (const hold of flags) {
                for (const pending of flags) {
                    for (const hasText of flags) {
                        for (const confirming of flags) {
                            const actions = row({ state, hold, pending, hasText, confirming });
                            const filled = actions.filter((action) => isFilled(action.look));
                            expect(filled.length).toBeLessThanOrEqual(1);
                            expect(new Set(actions.map((action) => action.id)).size).toBe(
                                actions.length,
                            );
                        }
                    }
                }
            }
        }
    });

    test("every button carries an icon, bar cancel and the long reject with note", () => {
        for (const state of states) {
            for (const confirming of flags) {
                for (const action of row({ state, confirming, pending: true, hasText: true })) {
                    const bare = action.id === "cancel" || action.id === "rejectWithNote";
                    expect(action.icon === undefined).toBe(bare);
                }
            }
        }
    });
});

describe("suggestion and applied actions", () => {
    test("accept is the one filled button; reject is the outlined negative", () => {
        expect(suggestionActions.accept).toMatchObject({ look: "accept", icon: "check", key: "a" });
        expect(suggestionActions.reject).toMatchObject({
            look: "danger-quiet",
            icon: "slash",
            key: "r",
        });
    });

    test("revert is neutral", () => {
        expect(revertAction).toMatchObject({ look: "neutral", icon: "undo" });
    });
});
