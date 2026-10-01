import { describe, expect, test } from "bun:test";
import type { Range, Thread, ThreadId } from "../core/model.ts";
import { docClickRoute, nextInOverlap, visibleThreads } from "./app.tsx";

function thread(id: ThreadId, state: Thread["state"]): Thread {
    return { id, state } as Thread;
}

describe("visibleThreads", () => {
    const threads = [thread("c1", "open"), thread("c2", "resolved"), thread("c3", "replied")];

    test("hides resolved threads unless asked for or active", () => {
        expect(visibleThreads(threads, false, null).map((t) => t.id)).toEqual(["c1", "c3"]);
        expect(visibleThreads(threads, true, null).map((t) => t.id)).toEqual(["c1", "c2", "c3"]);
        expect(visibleThreads(threads, false, "c2").map((t) => t.id)).toEqual(["c1", "c2", "c3"]);
    });

    test("holds back threads born during a send", () => {
        const known = new Set<ThreadId>(["c1", "c3"]);
        const during = [...threads, thread("c4", "open")];
        expect(visibleThreads(during, false, null, known).map((t) => t.id)).toEqual(["c1", "c3"]);
        expect(visibleThreads(during, false, null).map((t) => t.id)).toEqual(["c1", "c3", "c4"]);
    });
});

describe("nextInOverlap", () => {
    const ranges = new Map<ThreadId, Range>([
        ["c1", { start: 0, end: 40 }],
        ["c2", { start: 10, end: 20 }],
        ["c3", { start: 5, end: 30 }],
    ]);

    test("starts with the smallest range, whatever the mark lists first", () => {
        expect(nextInOverlap(["c1", "c2", "c3"], ranges, null)).toBe("c2");
        expect(nextInOverlap(["c1", "c2", "c3"], ranges, "c9")).toBe("c2");
    });

    test("repeated clicks cycle outward and round again", () => {
        expect(nextInOverlap(["c1", "c2", "c3"], ranges, "c2")).toBe("c3");
        expect(nextInOverlap(["c1", "c2", "c3"], ranges, "c3")).toBe("c1");
        expect(nextInOverlap(["c1", "c2", "c3"], ranges, "c1")).toBe("c2");
    });

    test("a single thread stays selected; ids listed twice count once", () => {
        expect(nextInOverlap(["c1"], ranges, "c1")).toBe("c1");
        expect(nextInOverlap(["c2", "c1", "c2"], ranges, "c2")).toBe("c1");
        expect(nextInOverlap([], ranges, null)).toBeUndefined();
    });
});

describe("docClickRoute", () => {
    test("single click: a click selects or edits, a double click adds nothing", () => {
        expect(docClickRoute("click", "click", 1)).toEqual({ select: true, edit: true });
        expect(docClickRoute("click", "click", 2)).toEqual({ select: true, edit: true });
        expect(docClickRoute("click", "dblclick", 2)).toEqual({ select: false, edit: false });
    });

    test("double click: the first click only selects, the double click only edits", () => {
        expect(docClickRoute("dblclick", "click", 1)).toEqual({ select: true, edit: false });
        expect(docClickRoute("dblclick", "click", 0)).toEqual({ select: true, edit: false });
        expect(docClickRoute("dblclick", "dblclick", 2)).toEqual({ select: false, edit: true });
    });

    test("double click: the click completing a double click leaves the picked thread alone", () => {
        expect(docClickRoute("dblclick", "click", 2)).toEqual({ select: false, edit: false });
        expect(docClickRoute("dblclick", "click", 3)).toEqual({ select: false, edit: false });
    });
});
