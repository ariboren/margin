import { describe, expect, test } from "bun:test";
import { stackCards } from "./margin-rail.tsx";

describe("stackCards", () => {
    const cards = [
        { key: "a", want: 100, height: 80 },
        { key: "b", want: 120, height: 80 },
        { key: "c", want: 500, height: 40 },
    ];

    test("pushes overlapping cards down in anchor order", () => {
        const tops = stackCards(cards, null, 10);
        expect(tops.get("a")).toBe(100);
        expect(tops.get("b")).toBe(190);
        expect(tops.get("c")).toBe(500);
    });

    test("the active card sits at its anchor and earlier cards move up", () => {
        const tops = stackCards(cards, "b", 10);
        expect(tops.get("b")).toBe(120);
        expect(tops.get("a")).toBe(30);
    });

    test("never places a card above the rail", () => {
        const tops = stackCards(
            [
                { key: "a", want: 0, height: 50 },
                { key: "b", want: 10, height: 50 },
            ],
            "b",
            10,
        );
        expect(Math.min(...tops.values())).toBe(0);
        expect(tops.get("b")! - tops.get("a")!).toBe(60);
    });
});
