import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clampRange, createAnchor, rebaseAnchor, resolveAnchor, snapRange } from "./anchor.ts";
import { decodeSource, flattenUnits, parseDoc, sourceEdit } from "./blocks.ts";
import type { Anchor, Range, SourceSplice } from "./model.ts";
import {
    buildSource,
    checkProperty,
    edgeFixtures,
    snapOffset,
    sourceArb,
    textArb,
} from "./testing.ts";

const fixtures = join(import.meta.dir, "../../fixtures");
const privateSample = join(fixtures, "private/sample.md");

function load(name: string): string {
    return decodeSource(readFileSync(join(fixtures, name)));
}

function apply(source: string, edit: SourceSplice): string {
    return source.slice(0, edit.start) + edit.after + source.slice(edit.start + edit.before.length);
}

function rangeOf(source: string, text: string, from = 0): Range {
    const start = source.indexOf(text, from);
    if (start === -1) throw new Error(`missing ${text}`);
    return { start, end: start + text.length };
}

/** A rebased anchor must describe the new source exactly around its hint. */
function expectConsistent(source: string, anchor: Anchor): void {
    const { hint, exact, prefix, suffix } = anchor;
    expect(source.slice(hint, hint + exact.length)).toBe(exact);
    expect(source.slice(hint - prefix.length, hint)).toBe(prefix);
    expect(source.slice(hint + exact.length, hint + exact.length + suffix.length)).toBe(suffix);
}

/** Whether the anchor's window, placed at `hint`, overlaps the splice's `before`. */
function overlapsWindow(anchor: Anchor, edit: SourceSplice, hint: number): boolean {
    const w0 = hint - anchor.prefix.length;
    const w1 = hint + anchor.exact.length + anchor.suffix.length;
    return Math.max(edit.start, w0) < Math.min(edit.start + edit.before.length, w1);
}

/** Every hint at which the anchor's window overlaps `before` and agrees with it there. */
function agreeingHints(anchor: Anchor, edit: SourceSplice): number[] {
    const window = anchor.prefix + anchor.exact + anchor.suffix;
    const s = edit.start;
    const hints: number[] = [];
    for (let w0 = s - window.length + 1; w0 < s + edit.before.length; w0++) {
        const lo = Math.max(s, w0);
        const hi = Math.min(s + edit.before.length, w0 + window.length);
        if (edit.before.slice(lo - s, hi - s) === window.slice(lo - w0, hi - w0)) {
            hints.push(w0 + anchor.prefix.length);
        }
    }
    return hints;
}

const text =
    "Alpha beta gamma delta. The quick brown fox jumps over the lazy dog. Epsilon zeta eta theta.";

describe("createAnchor", () => {
    test("keeps up to 32 characters of context on each side", () => {
        const anchor = createAnchor(text, rangeOf(text, "brown fox"));
        expect(anchor.exact).toBe("brown fox");
        expect(anchor.prefix).toHaveLength(32);
        expect(anchor.suffix).toHaveLength(32);
        expect(createAnchor(text, rangeOf(text, "Alpha")).prefix).toBe("");
    });

    test("rejects empty and out-of-bounds ranges", () => {
        expect(() => createAnchor(text, { start: 3, end: 3 })).toThrow();
        expect(() => createAnchor(text, { start: 0, end: text.length + 1 })).toThrow();
    });
});

describe("resolveAnchor", () => {
    const anchor = createAnchor(text, rangeOf(text, "brown fox"));

    test("survives edits before and after the quote", () => {
        const before = "Intro sentence. " + text;
        expect(resolveAnchor(before, anchor)).toEqual(rangeOf(before, "brown fox"));
        const after = text.replace("lazy dog", "sleepy cat");
        expect(resolveAnchor(after, anchor)).toEqual(rangeOf(after, "brown fox"));
    });

    test("detaches only when the quote is gone and re-attaches when it returns", () => {
        const gone = text.replace("brown fox", "red fox");
        expect(resolveAnchor(gone, anchor)).toBeNull();
        expect(resolveAnchor(text.replace("quick brown", "slow brown"), anchor)).not.toBeNull();
        expect(resolveAnchor(gone.replace("red fox", "brown fox"), anchor)).toEqual(
            rangeOf(text, "brown fox"),
        );
    });

    test("picks the copy whose context matches, even with a hint at the other copy", () => {
        const doubled = text + " Another brown fox there.";
        const second = rangeOf(doubled, "brown fox", rangeOf(doubled, "Another").start);
        const anchor = {
            ...createAnchor(doubled, second),
            hint: rangeOf(doubled, "brown fox").start,
        };
        const shifted = "Lots of new text up front. ".repeat(4) + doubled;
        const expected = rangeOf(shifted, "brown fox", rangeOf(shifted, "Another").start);
        expect(resolveAnchor(shifted, anchor)).toEqual(expected);
    });

    test("breaks a context tie by the hint", () => {
        const repeated = "x fox x fox x fox";
        const anchor = { exact: "fox", prefix: "", suffix: "", hint: 8 };
        expect(resolveAnchor(repeated, anchor)).toEqual({ start: 8, end: 11 });
    });
});

describe("rebaseAnchor", () => {
    const quote = rangeOf(text, "quick brown fox");
    const anchor = createAnchor(text, quote);

    const cases: [string, SourceSplice, string | null][] = [
        ["insert before", { start: 0, before: "", after: "Hi. " }, "quick brown fox"],
        [
            "edit in prefix",
            { start: quote.start - 4, before: "The", after: "A" },
            "quick brown fox",
        ],
        [
            "edit after",
            { start: quote.end + 1, before: "jumps", after: "leaps" },
            "quick brown fox",
        ],
        [
            "insert at start boundary",
            { start: quote.start, before: "", after: "very " },
            "quick brown fox",
        ],
        [
            "insert at end boundary",
            { start: quote.end, before: "", after: "es" },
            "quick brown fox",
        ],
        ["edit inside", { start: quote.start + 6, before: "brown", after: "red" }, "quick red fox"],
        ["replace exactly", { start: quote.start, before: "quick brown fox", after: "cat" }, "cat"],
        [
            "overlap left",
            { start: quote.start - 4, before: "The quick", after: "A slow" },
            "A slow brown fox",
        ],
        [
            "overlap right",
            { start: quote.start + 12, before: "fox jumps", after: "dog runs" },
            "quick brown dog runs",
        ],
        [
            "cover, quote kept",
            {
                start: quote.start - 4,
                before: "The quick brown fox jumps",
                after: "Yes, the quick brown fox leaps",
            },
            "quick brown fox",
        ],
        [
            "cover, quote gone",
            { start: quote.start - 4, before: "The quick brown fox jumps", after: "Nothing" },
            null,
        ],
        ["delete exactly", { start: quote.start, before: "quick brown fox", after: "" }, null],
        ["delete part inside", { start: quote.start, before: "quick ", after: "" }, "brown fox"],
    ];

    for (const [name, edit, exact] of cases) {
        test(name, () => {
            expect(text.slice(edit.start, edit.start + edit.before.length)).toBe(edit.before);
            const next = apply(text, edit);
            const rebased = rebaseAnchor(anchor, edit);
            if (exact === null) {
                expect(rebased).toBeNull();
                return;
            }
            expect(rebased?.exact).toBe(exact);
            expectConsistent(next, rebased!);
            expect(resolveAnchor(next, rebased!)).toEqual({
                start: rebased!.hint,
                end: rebased!.hint + exact.length,
            });
        });
    }

    test("an outside edit inside the quote survives via sourceEdit", () => {
        const next = text.replace("quick brown fox", "quick, brown fox");
        const rebased = rebaseAnchor(anchor, sourceEdit(text, next)!);
        expect(rebased?.exact).toBe("quick, brown fox");
        expectConsistent(next, rebased!);
    });

    test("property: any splice sequence keeps a rebased anchor consistent with the new source", () => {
        const splice = fc.record({
            near: fc.boolean(),
            at: fc.nat(),
            length: fc.nat({ max: 12 }),
            after: textArb,
        });
        checkProperty(
            fc.property(
                sourceArb(edgeFixtures),
                fc.nat(),
                fc.integer({ min: 1, max: 20 }),
                fc.array(splice, { minLength: 1, maxLength: 8 }),
                (sourceCase, rawStart, length, splices) => {
                    let source = buildSource(sourceCase);
                    const start = snapOffset(source, rawStart % (source.length - length));
                    let current: Anchor | null = createAnchor(source, {
                        start,
                        end: start + length,
                    });
                    for (const step of splices) {
                        if (!current) return;
                        const at = step.near
                            ? Math.min(
                                  source.length,
                                  Math.max(0, current.hint - 40 + (step.at % 100)),
                              )
                            : step.at % (source.length + 1);
                        const edit = {
                            start: at,
                            before: source.slice(
                                at,
                                at + Math.min(step.length, source.length - at),
                            ),
                            after: step.after,
                        };
                        source = apply(source, edit);
                        current = rebaseAnchor(current, edit);
                        if (current) expectConsistent(source, current);
                    }
                },
            ),
            500,
        );
    });
});

describe("snapRange", () => {
    const source = load("edge.md");
    const doc = parseDoc(source);

    test("takes a whole code span when the selection ends inside it", () => {
        const range = {
            start: rangeOf(source, "with `inline").start,
            end: rangeOf(source, "inline code").start + 3,
        };
        expect(snapRange(doc, range)).toEqual({
            start: range.start,
            end: rangeOf(source, "`inline code`").end,
        });
    });

    test("widens both ends over cut emphasis", () => {
        const range = { start: rangeOf(source, "old**").start, end: rangeOf(source, "emph").end };
        expect(snapRange(doc, range)).toEqual({
            start: rangeOf(source, "**bold**").start,
            end: rangeOf(source, "_emphasis_").end,
        });
    });

    test("leaves a selection inside one node alone", () => {
        const range = rangeOf(source, "bold**").start + 1;
        expect(snapRange(doc, { start: range, end: range + 2 })).toEqual({
            start: range,
            end: range + 2,
        });
        const plain = rangeOf(source, "A paragraph with");
        expect(snapRange(doc, plain)).toEqual(plain);
    });

    test("snaps a link cut in its label", () => {
        const range = {
            start: rangeOf(source, "a [link]").start,
            end: rangeOf(source, "link]").start + 2,
        };
        expect(snapRange(doc, range).end).toBe(rangeOf(source, "[link](https://example.com)").end);
    });
});

describe("clampRange", () => {
    const source = load("edge.md");
    const doc = parseDoc(source);

    test("clamps a selection across units to the unit holding its start", () => {
        const first = rangeOf(source, "soft break inside one paragraph.");
        const range = { start: first.start, end: rangeOf(source, "## Code fences").end };
        expect(clampRange(doc, range)).toEqual(first);
    });

    test("clamps to a table cell and to a nested list item", () => {
        const one = rangeOf(source, "one", rangeOf(source, "| one").start);
        expect(clampRange(doc, { start: one.start, end: one.start + 12 })).toEqual(one);
        const item = rangeOf(source, "1. third level ordered");
        expect(clampRange(doc, { start: item.start + 3, end: item.end + 30 })).toEqual({
            start: item.start + 3,
            end: item.end,
        });
    });

    test("moves a start between units to the next unit, or gives null", () => {
        const heading = rangeOf(source, "## Code fences");
        expect(clampRange(doc, { start: heading.start - 1, end: heading.end })).toEqual(heading);
        expect(clampRange(doc, { start: heading.start - 1, end: heading.start })).toBeNull();
    });
});

describe.skipIf(!existsSync(privateSample))("private sample", () => {
    test("anchors in every paragraph and cell survive edits before and after them", () => {
        const source = decodeSource(readFileSync(privateSample));
        const doc = parseDoc(source);
        const units = flattenUnits(doc.units).filter(
            (unit) =>
                (unit.kind === "paragraph" || unit.kind === "tableCell") &&
                unit.end - unit.start >= 12,
        );
        expect(units.length).toBeGreaterThan(20);
        const firstStart = doc.units[1]!.start;
        const insert = { start: firstStart, before: "", after: "New opening paragraph.\n\n" };
        const inserted = apply(source, insert);
        for (const unit of units) {
            const mid = Math.floor((unit.start + unit.end) / 2);
            const anchor = createAnchor(source, { start: mid - 5, end: mid + 5 });
            const rebased = rebaseAnchor(anchor, insert)!;
            expectConsistent(inserted, rebased);
            expect(resolveAnchor(inserted, anchor)).toEqual({
                start: rebased.hint,
                end: rebased.hint + 10,
            });
            const tail = { start: source.length, before: "", after: "\nAppendix.\n" };
            expect(resolveAnchor(apply(source, tail), anchor)).toEqual({
                start: mid - 5,
                end: mid + 5,
            });
        }
    });
});

describe("rebaseAnchor with a stale hint", () => {
    const quote = rangeOf(text, "quick brown fox");
    const anchor = createAnchor(text, quote);
    const replace = { start: quote.start, before: "quick brown fox", after: "slow brown fox" };

    for (const shift of [4, 20, 60]) {
        test(`an own splice follows the replacement after an unlogged ${shift}-char insert`, () => {
            const moved = "x".repeat(shift) + text;
            const edit = { ...replace, start: replace.start + shift };
            const next = apply(moved, edit);
            const rebased = rebaseAnchor(anchor, edit, { own: true });
            expect(rebased?.exact).toBe("slow brown fox");
            expectConsistent(next, rebased!);
        });
    }

    for (const shift of [4, 20]) {
        test(`a splice holding the quote re-pins after an unlogged ${shift}-char insert`, () => {
            const moved = "x".repeat(shift) + text;
            const edit = {
                start: quote.start - 4 + shift,
                before: "The quick brown fox jumps",
                after: "The quick brown fox leaps",
            };
            expect(moved.slice(edit.start, edit.start + edit.before.length)).toBe(edit.before);
            const rebased = rebaseAnchor(anchor, edit);
            expect(rebased?.exact).toBe("quick brown fox");
            expectConsistent(apply(moved, edit), rebased!);
            expect(rebaseAnchor(anchor, { ...replace, start: replace.start + shift })?.exact).toBe(
                "slow brown fox",
            );
        });
    }

    test("a splice that disagrees with the stale window leaves the anchor as it was", () => {
        const moved = "xxxx" + text;
        const edit = { start: quote.end + 4 + 1, before: "jumps", after: "leaps" };
        expect(moved.slice(edit.start, edit.start + 5)).toBe("jumps");
        const next = apply(moved, edit);
        expect(rebaseAnchor(anchor, edit)).toBe(anchor);
        expect(resolveAnchor(next, anchor)).toEqual(rangeOf(next, "quick brown fox"));
    });

    // Known bug, issue #6: the splice agrees with the window at both alignments.
    test.failing(
        "a stale hint on repeated characters does not rebuild exact from the wrong offset",
        () => {
            const stale = { exact: "--", prefix: "x", suffix: "", hint: 0 };
            const edit = { start: 1, before: "-", after: "zq" };
            const next = apply("x--", edit);
            for (const own of [false, true]) {
                const rebased = rebaseAnchor(stale, edit, { own });
                if (rebased && rebased.exact !== stale.exact) {
                    expect(next.slice(rebased.hint, rebased.hint + rebased.exact.length)).toBe(
                        rebased.exact,
                    );
                }
            }
        },
    );

    test("property: a splice that disagrees with a stale hint's window re-pins or leaves the anchor, never fabricates", () => {
        checkProperty(
            fc.property(
                sourceArb(edgeFixtures),
                fc.nat(),
                fc.integer({ min: 1, max: 20 }),
                fc.integer({ min: -20, max: 20 }).filter((drift) => drift !== 0),
                fc.integer({ min: -30, max: 49 }),
                fc.integer({ min: 1, max: 12 }),
                textArb,
                (sourceCase, rawStart, length, drift, offset, cut, after) => {
                    const base = buildSource(sourceCase);
                    const start = snapOffset(base, rawStart % (base.length - length));
                    const real = createAnchor(base, { start, end: start + length });
                    const stale = { ...real, hint: Math.max(0, real.hint + drift) };
                    const at = Math.max(0, Math.min(base.length - 1, start + offset));
                    const edit = { start: at, before: base.slice(at, at + cut), after };
                    // Unambiguous only: `before` overlaps the window at the stale hint, and the real
                    // hint is the one alignment where they agree (issue #6 is the rest).
                    const agreeing = agreeingHints(stale, edit);
                    fc.pre(
                        overlapsWindow(stale, edit, stale.hint) &&
                            agreeing.every((hint) => hint === real.hint),
                    );
                    const rebased = rebaseAnchor(stale, edit);
                    if (rebased && rebased !== stale) expectConsistent(apply(base, edit), rebased);
                },
            ),
            1000,
        );
    });

    // Known bug, issue #6. The seed is pinned because a random one misses it in about 1 run in 10.
    test.failing("property: a splice over a stale hint never fabricates exact", () => {
        checkProperty(
            fc.property(
                sourceArb(edgeFixtures),
                fc.nat(),
                fc.integer({ min: 1, max: 20 }),
                fc.integer({ min: -20, max: 20 }),
                fc.integer({ min: -30, max: 49 }),
                fc.integer({ min: 1, max: 12 }),
                textArb,
                (sourceCase, rawStart, length, drift, offset, cut, after) => {
                    const base = buildSource(sourceCase);
                    const start = snapOffset(base, rawStart % (base.length - length));
                    const real = createAnchor(base, { start, end: start + length });
                    const stale = { ...real, hint: Math.max(0, real.hint + drift) };
                    const at = Math.max(0, Math.min(base.length - 1, start + offset));
                    const edit = { start: at, before: base.slice(at, at + cut), after };
                    const next = apply(base, edit);
                    const rebased = rebaseAnchor(stale, edit);
                    if (rebased && rebased.exact !== stale.exact) {
                        expect(next.slice(rebased.hint, rebased.hint + rebased.exact.length)).toBe(
                            rebased.exact,
                        );
                    }
                },
            ),
            1000,
            2087513591,
        );
    });
});

describe("rebaseAnchor across a word cut", () => {
    const quote = rangeOf(text, "quick brown fox");
    const anchor = createAnchor(text, quote);

    test("an overlap ending mid-word widens the quote to the whole word", () => {
        const edit = { start: quote.start + 8, before: "own fox ju", after: "X" };
        const next = apply(text, edit);
        const rebased = rebaseAnchor(anchor, edit)!;
        expect(rebased.exact).toBe("quick brXmps");
        expectConsistent(next, rebased);
    });

    test("an overlap starting mid-word widens the quote back to the word start", () => {
        const at = rangeOf(text, "lta. The qu");
        const edit = { start: at.start, before: "lta. The qu", after: "LTA, qu" };
        const next = apply(text, edit);
        const rebased = rebaseAnchor(anchor, edit)!;
        expect(rebased.exact).toBe("deLTA, quick brown fox");
        expectConsistent(next, rebased);
    });
});
