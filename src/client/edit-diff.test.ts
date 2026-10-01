import { describe, expect, test } from "bun:test";
import type { HunkPieces } from "../core/diff.ts";
import { clipDiff, visibleText } from "./edit-diff.ts";

function hunk(...texts: string[]): HunkPieces {
    return {
        pieces: texts.map((text, index) => ({ kind: index % 2 ? "ins" : "same", text })),
        cutBefore: false,
        cutAfter: false,
    };
}

describe("clipDiff", () => {
    const four = [hunk("a"), hunk("b"), hunk("c"), hunk("d")];

    test("shows everything when it fits", () => {
        expect(clipDiff(four.slice(0, 3), false)).toEqual({
            shown: four.slice(0, 3),
            clipped: false,
        });
    });

    test("keeps the first hunks and says more were left out", () => {
        expect(clipDiff(four, false)).toEqual({ shown: four.slice(0, 3), clipped: true });
        expect(clipDiff(four, true)).toEqual({ shown: four, clipped: false });
    });

    test("cuts a long hunk at the character budget, inside a piece, and marks the cut", () => {
        const long = [hunk("12345", "67890", "abcde")];
        expect(clipDiff(long, false, { hunks: 3, chars: 7 })).toEqual({
            shown: [
                {
                    pieces: [
                        { kind: "same", text: "12345" },
                        { kind: "ins", text: "67" },
                    ],
                    cutBefore: false,
                    cutAfter: true,
                },
            ],
            clipped: true,
        });
    });

    test("a hunk that starts past the budget is dropped, not shown empty", () => {
        const two = [hunk("1234567"), hunk("x")];
        expect(clipDiff(two, false, { hunks: 3, chars: 7 })).toEqual({
            shown: [two[0]!],
            clipped: true,
        });
    });
});

describe("visibleText", () => {
    test("shows line breaks as a return mark", () => {
        expect(visibleText("a\nb\r\nc")).toBe("a↵b↵c");
    });
});
