import { describe, expect, test } from "bun:test";
import { initialSeen } from "./doc-notes.tsx";

describe("initialSeen", () => {
    test("nothing stored means everything so far is seen, so a fresh tab shows no dot", () => {
        expect(initialSeen(null, 9)).toBe(9);
        expect(initialSeen(null, 0)).toBe(0);
    });

    test("a stored seq is used; garbage falls back to seen", () => {
        expect(initialSeen("4", 9)).toBe(4);
        expect(initialSeen("x", 9)).toBe(9);
    });
});
