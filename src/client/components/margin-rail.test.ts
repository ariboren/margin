import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { checkProperty } from "../../core/testing.ts";
import { stackCards, updateLeaving, type RailItem } from "./margin-rail.tsx";

/** Keys in rail order, top to bottom. */
function order(tops: Map<string, number>): string[] {
    return [...tops.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key);
}

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

    test("cards wanting the same spot keep their order, the active one at the anchor", () => {
        const same = [
            { key: "c1", want: 200, height: 60 },
            { key: "new", want: 200, height: 90 },
        ];
        const tops = stackCards(same, "new", 10);
        expect(tops.get("new")).toBe(200);
        expect(tops.get("c1")).toBe(130);
        const idle = stackCards(same, null, 10);
        expect(idle.get("c1")).toBe(200);
        expect(idle.get("new")).toBe(270);
    });

    describe("a card that gives way", () => {
        const edit = { key: "edit", want: 434, height: 109, givesWay: true };

        test("moves up above the thread card whose mark it would otherwise displace", () => {
            const tops = stackCards([edit, { key: "c1", want: 436, height: 216 }], null, 12);
            expect(tops.get("c1")).toBe(436);
            expect(tops.get("edit")).toBe(436 - 109 - 12);
        });

        test("sits at its anchor when nothing is in the way", () => {
            const tops = stackCards([edit, { key: "c1", want: 900, height: 216 }], null, 12);
            expect(tops.get("edit")).toBe(434);
            expect(tops.get("c1")).toBe(900);
        });

        test("takes the gap between two thread cards, as close to its anchor as it fits", () => {
            const tops = stackCards(
                [
                    { key: "c1", want: 100, height: 200 },
                    edit,
                    { key: "c2", want: 500, height: 100 },
                ],
                null,
                12,
            );
            expect(tops.get("c1")).toBe(100);
            expect(tops.get("c2")).toBe(500);
            expect(tops.get("edit")).toBe(500 - 109 - 12);
        });

        test("pushes the cards below it down when there is no room above", () => {
            const tops = stackCards(
                [
                    { key: "c1", want: 0, height: 200 },
                    { key: "edit", want: 180, height: 109, givesWay: true },
                    { key: "c2", want: 300, height: 100 },
                ],
                null,
                12,
            );
            expect(tops.get("c1")).toBe(0);
            expect(tops.get("edit")).toBe(212);
            expect(tops.get("c2")).toBe(212 + 109 + 12);
        });

        test("two cards giving way at one anchor stack upward above the thread card, in order", () => {
            const tops = stackCards(
                [
                    { key: "e1", want: 435, height: 109, givesWay: true },
                    { key: "e2", want: 435, height: 109, givesWay: true },
                    { key: "c1", want: 437, height: 216 },
                ],
                null,
                12,
            );
            expect(tops.get("c1")).toBe(437);
            expect(tops.get("e2")).toBe(437 - 121);
            expect(tops.get("e1")).toBe(437 - 242);
        });

        test("a card that fits at its anchor lends no room to the one above it", () => {
            const tops = stackCards(
                [
                    { key: "e1", want: 90, height: 109, givesWay: true },
                    { key: "e2", want: 100, height: 109, givesWay: true },
                    { key: "c1", want: 900, height: 216 },
                ],
                null,
                12,
            );
            expect(tops.get("e1")).toBe(90);
            expect(tops.get("e2")).toBe(90 + 121);
            expect(tops.get("c1")).toBe(900);
        });

        test("at the top of the rail, in another block, it stays above and pushes the next card down", () => {
            const tops = stackCards(
                [
                    { key: "edit", want: 100, height: 109, givesWay: true },
                    { key: "c1", want: 100, height: 216 },
                ],
                null,
                12,
            );
            expect(tops.get("edit")).toBe(0);
            expect(tops.get("c1")).toBe(121);
        });

        test("a card far below the top overflow keeps its anchor, active or not", () => {
            const cards = [
                { key: "edit", want: 0, height: 60, givesWay: true },
                { key: "c1", want: 40, height: 100 },
                { key: "far", want: 3000, height: 100 },
            ];
            for (const activeKey of [null, "far", "c1"]) {
                const tops = stackCards(cards, activeKey, 12);
                expect(tops.get("edit")).toBe(0);
                expect(tops.get("c1")).toBe(72);
                expect(tops.get("far")).toBe(3000);
            }
        });

        test("in the thread's block it goes after the thread card, which keeps its mark", () => {
            const tops = stackCards(
                [
                    { key: "edit", want: 434, height: 109, givesWay: true, block: "p1" },
                    { key: "c1", want: 436, height: 216, block: "p1" },
                ],
                null,
                12,
            );
            expect(tops.get("c1")).toBe(436);
            expect(tops.get("edit")).toBe(436 + 216 + 12);
        });

        test("at the top of the rail, in the thread's block, it goes below the thread card", () => {
            const tops = stackCards(
                [
                    { key: "edit", want: 100, height: 109, givesWay: true, block: "p1" },
                    { key: "c1", want: 100, height: 216, block: "p1" },
                    { key: "c2", want: 900, height: 71, block: "p2" },
                ],
                null,
                12,
            );
            expect(order(tops)).toEqual(["c1", "edit", "c2"]);
            expect(tops.get("c1")).toBe(100);
            expect(tops.get("edit")).toBe(328);
        });

        test("a card growing never changes the order of the cards below it", () => {
            const rail = (activeHeight: number) => [
                { key: "c5", want: 100, height: activeHeight },
                { key: "c3", want: 300, height: 100 },
                { key: "e1", want: 320, height: 109, givesWay: true },
                { key: "e2", want: 330, height: 109, givesWay: true },
            ];
            expect(order(stackCards(rail(120), "c5", 12))).toEqual(["c5", "c3", "e1", "e2"]);
            expect(order(stackCards(rail(210), "c5", 12))).toEqual(["c5", "c3", "e1", "e2"]);
        });

        test("the active card keeps its anchor whatever is in the way", () => {
            const tops = stackCards([edit, { key: "c1", want: 436, height: 216 }], "c1", 12);
            expect(tops.get("c1")).toBe(436);
            expect(tops.get("edit")).toBe(436 - 109 - 12);
        });

        test("never passes a firm card, whatever the free space", () => {
            const tops = stackCards(
                [
                    { key: "c1", want: 100, height: 400 },
                    { key: "edit", want: 520, height: 109, givesWay: true },
                    { key: "c2", want: 530, height: 100 },
                    { key: "c3", want: 2000, height: 100 },
                ],
                null,
                12,
            );
            expect(order(tops)).toEqual(["c1", "edit", "c2", "c3"]);
            expect(tops.get("c1")).toBe(100);
            expect(tops.get("c2")).toBe(100 + 400 + 12 + 109 + 12);
        });
    });

    test("rail order is block order, threads first within a block, for any heights", () => {
        const cardArb = fc.record({
            want: fc.integer({ min: 0, max: 3000 }),
            height: fc.integer({ min: 20, max: 400 }),
            givesWay: fc.boolean(),
            block: fc.option(fc.nat(3), { nil: undefined }),
        });
        checkProperty(
            fc.property(
                fc.array(cardArb, { minLength: 1, maxLength: 8 }),
                fc.option(fc.nat(7), { nil: null }),
                (cards, activeIndex) => {
                    const measured = cards.map((card, i) => ({ ...card, key: `k${i}` }));
                    const activeKey =
                        activeIndex === null ? null : (measured[activeIndex]?.key ?? null);
                    const tops = stackCards(measured, activeKey, 12);
                    const blockOf = (item: (typeof measured)[number]) => item.block ?? item.key;
                    const position = (item: (typeof measured)[number]) =>
                        Math.min(
                            ...measured
                                .filter((other) => blockOf(other) === blockOf(item))
                                .map((other) => other.want),
                        );
                    const byWant = [...measured]
                        .sort(
                            (a, b) =>
                                position(a) - position(b) ||
                                (blockOf(a) === blockOf(b)
                                    ? Number(a.givesWay) - Number(b.givesWay)
                                    : 0) ||
                                a.want - b.want,
                        )
                        .map((item) => item.key);
                    expect(order(tops)).toEqual(byWant);
                    for (let i = 1; i < byWant.length; i++) {
                        const above = measured.find((item) => item.key === byWant[i - 1])!;
                        expect(tops.get(byWant[i]!)!).toBeGreaterThanOrEqual(
                            tops.get(above.key)! + above.height + 12,
                        );
                    }
                    if (activeKey !== null) {
                        const active = measured.find((item) => item.key === activeKey)!;
                        expect(tops.get(activeKey)!).toBeGreaterThanOrEqual(active.want);
                    }
                },
            ),
            300,
        );
    });
});

describe("updateLeaving", () => {
    const item = (key: string, fade?: boolean): RailItem => ({
        key,
        anchor: () => null,
        node: null,
        ...(fade === undefined ? {} : { fade }),
    });

    test("a fading item that left is kept; one without fade is dropped", () => {
        const next = updateLeaving([item("a", true), item("b")], [], new Map());
        expect([...next.keys()]).toEqual(["a"]);
    });

    test("items still fading from before stay until they are shown again", () => {
        const fading = new Map([["a", item("a", true)]]);
        expect([...updateLeaving([item("b", true)], [item("b", true)], fading).keys()]).toEqual([
            "a",
        ]);
        expect(updateLeaving([], [item("a", true)], fading).size).toBe(0);
    });

    test("the node kept is the one from the last render", () => {
        const previous = { ...item("a", true), node: "last" };
        const next = updateLeaving([previous], [], new Map([["a", item("a", true)]]));
        expect(next.get("a")?.node).toBe(null);
        const fresh = updateLeaving([previous], [], new Map());
        expect(fresh.get("a")?.node).toBe("last");
    });
});
