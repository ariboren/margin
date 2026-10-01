import { describe, expect, test } from "bun:test";
import { parsePending, parseWatch } from "./fake-agent.ts";

describe("watch lines", () => {
    test("a doc word is a group with no ids", () => {
        for (const reason of ["approved", "dropped", "reopened"] as const) {
            expect(parseWatch(`${reason}\n`)).toEqual({
                form: "compact",
                groups: [{ reason, ids: [] }],
            });
        }
    });

    test("finish lists the threads handed over, and a doc word sits beside thread groups", () => {
        expect(parseWatch("finish c3 c5\n")?.groups).toEqual([
            { reason: "finish", ids: ["c3", "c5"] },
        ]);
        expect(parseWatch('dropped | new c7 "2. Findings"\n')?.groups).toEqual([
            { reason: "dropped", ids: [] },
            { reason: "new", ids: ["c7"], path: "2. Findings" },
        ]);
    });
});

describe("pending header", () => {
    test("every form parses, alone or above the blocks", () => {
        expect(parsePending("approved\n")).toEqual({
            threads: [],
            edits: [],
            review: { verdict: "approved" },
        });
        expect(parsePending("approved changed: Ship it\\nnow\n").review).toEqual({
            verdict: "approved",
            changed: true,
            note: "Ship it\nnow",
        });
        expect(parsePending("dropped: Later\n").review).toEqual({
            verdict: "dropped",
            note: "Later",
        });
        expect(parsePending("reopened\n").review).toEqual({ reopened: true });
        const finish = parsePending("finish\nc1 working L5 Findings\n  a [[b]] c\n");
        expect(finish.review).toEqual({ finish: true });
        expect(finish.threads.map((thread) => [thread.id, thread.quote])).toEqual([["c1", "b"]]);
    });

    test("an open doc has none", () => {
        expect(parsePending("none\n")).toEqual({ threads: [], edits: [] });
        expect(parsePending("c1 open doc\n  user: Overall?\n").review).toBeUndefined();
    });
});
