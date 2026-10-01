import { describe, expect, test } from "bun:test";
import { detachedLabel } from "./detached-action.tsx";
import { radioStep, shortLabelsBelow } from "./top-bar.tsx";

describe("radioStep", () => {
    test("Right and Down step on, wrapping from the last option to the first", () => {
        for (const key of ["ArrowRight", "ArrowDown"]) {
            expect([0, 1, 2].map((index) => radioStep(key, index, 3))).toEqual([1, 2, 0]);
        }
    });

    test("Left and Up step back, wrapping from the first option to the last", () => {
        for (const key of ["ArrowLeft", "ArrowUp"]) {
            expect([0, 1, 2].map((index) => radioStep(key, index, 3))).toEqual([2, 0, 1]);
        }
    });

    test("Home and End reach the ends from anywhere", () => {
        for (const index of [0, 1, 2]) {
            expect(radioStep("Home", index, 3)).toBe(0);
            expect(radioStep("End", index, 3)).toBe(2);
        }
    });

    test("any other key, Tab and Escape included, is left to the page", () => {
        for (const key of ["Tab", "Escape", "Enter", " ", "a"]) {
            expect(radioStep(key, 1, 3)).toBeUndefined();
        }
    });
});

describe("the bar's wide buttons", () => {
    test("take their short labels sooner the more of them are showing", () => {
        expect(shortLabelsBelow({ detached: false, drafts: true })).toBe("(max-width: 620px)");
        expect(shortLabelsBelow({ detached: true, drafts: false })).toBe("(max-width: 860px)");
        expect(shortLabelsBelow({ detached: true, drafts: true })).toBe("(max-width: 960px)");
    });

    test("the detached action's full label stays its name whatever the bar shows", () => {
        expect(detachedLabel(1)).toBe("Resolve 1 detached thread");
        expect(detachedLabel(3)).toBe("Resolve 3 detached threads");
    });
});
