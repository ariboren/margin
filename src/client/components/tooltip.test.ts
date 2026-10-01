import { describe, expect, test } from "bun:test";
import { tipShift } from "./tooltip.tsx";

describe("tipShift", () => {
    test("leaves a tip that fits where it is", () => {
        expect(tipShift(100, 300, 1280)).toBe(0);
        expect(tipShift(8, 1272, 1280)).toBe(0);
    });

    test("slides a tip past either edge back inside, 8px from it", () => {
        expect(tipShift(-40, 160, 390)).toBe(48);
        expect(tipShift(200, 420, 390)).toBe(-38);
    });

    test("never slides a tip past the left edge to clear the right", () => {
        expect(tipShift(10, 400, 390)).toBe(-2);
    });
});
