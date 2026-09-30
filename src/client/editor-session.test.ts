import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { flattenUnits, parseDoc } from "../core/blocks.ts";
import { checkProperty, scaledTimeout } from "../core/testing.ts";
import type { ParsedDoc, Unit } from "../core/model.ts";
import {
    beginSession,
    follow,
    nextNudge,
    nudgeFor,
    putBack,
    reinsertEdit,
    restoreStranded,
    strandedRecord,
    type EditorSession,
} from "./editor-session.ts";

const SOURCE = "# Title\n\nAlpha para.\n\nBeta para.\n\nGamma para.\n";

function open(doc: ParsedDoc, unit: Unit, draft: string, version = 1): EditorSession {
    const before = doc.source.slice(unit.start, unit.end);
    return {
        id: 1,
        unit,
        roots: doc.units,
        version,
        before,
        draft,
        theirs: null,
        keptMine: false,
        gone: null,
        draftKey: "k",
    };
}

function find(doc: ParsedDoc, text: string): Unit {
    return flattenUnits(doc.units).find((unit) => doc.source.slice(unit.start, unit.end) === text)!;
}

function apply(source: string, edit: { start: number; before: string; after: string }): string {
    return source.slice(0, edit.start) + edit.after + source.slice(edit.start + edit.before.length);
}

describe("follow", () => {
    test("an edit above moves the unit; the text is untouched, nothing to resolve", () => {
        const doc = parseDoc(SOURCE);
        const session = open(doc, find(doc, "Beta para."), "Beta, rewritten.");
        const next = parseDoc(SOURCE.replace("Alpha para.", "Alpha paragraph, longer."));
        const followed = follow(session, next, 2);
        expect(followed.unit.start).toBe(next.source.indexOf("Beta para."));
        expect(followed).toMatchObject({ version: 2, theirs: null, gone: null, id: 1 });
    });

    test("a change to the unit itself becomes theirs", () => {
        const doc = parseDoc(SOURCE);
        const session = open(doc, find(doc, "Beta para."), "Mine.");
        const next = parseDoc(SOURCE.replace("Beta para.", "Beta, by the agent."));
        expect(follow(session, next, 2).theirs).toBe("Beta, by the agent.");
    });

    test("a deleted unit is gone: no theirs, no offset reused, a place after its neighbour", () => {
        const doc = parseDoc(SOURCE);
        const session = open(doc, find(doc, "Beta para."), "My rewrite.");
        const next = parseDoc(SOURCE.replace("Beta para.\n\n", ""));
        const followed = follow(session, next, 2);
        expect(followed.theirs).toBeNull();
        expect(followed.gone?.place?.after).toBe(find(next, "Alpha para."));
        const edit = reinsertEdit(followed, next)!;
        expect(apply(next.source, edit)).toBe(
            "# Title\n\nAlpha para.\n\nMy rewrite.\n\nGamma para.\n",
        );
    });

    test("the place follows later edits, and is dropped when its neighbour goes too", () => {
        const doc = parseDoc(SOURCE);
        let session = open(doc, find(doc, "Beta para."), "My rewrite.");
        let source = SOURCE.replace("Beta para.\n\n", "");
        session = follow(session, parseDoc(source), 2);
        source = source.replace("# Title", "# A longer title");
        const moved = parseDoc(source);
        session = follow(session, moved, 3);
        expect(session.gone?.place?.after).toBe(find(moved, "Alpha para."));
        expect(apply(source, reinsertEdit(session, moved)!)).toContain(
            "Alpha para.\n\nMy rewrite.\n\nGamma",
        );
        const without = parseDoc(source.replace("Alpha para.\n\n", ""));
        session = follow(session, without, 4);
        expect(session.gone).toEqual({ place: null });
        expect(reinsertEdit(session, without)).toBeNull();
    });

    test("the first unit deleted goes back at the top", () => {
        const doc = parseDoc(SOURCE);
        const session = open(doc, find(doc, "# Title"), "# New title");
        const next = parseDoc(SOURCE.replace("# Title\n\n", ""));
        const followed = follow(session, next, 2);
        expect(followed.gone?.place).toEqual({ after: null });
        expect(apply(next.source, reinsertEdit(followed, next)!)).toBe(
            "# New title\n\nAlpha para.\n\nBeta para.\n\nGamma para.\n",
        );
    });

    test("a deleted table cell is gone with no place, even when a cell now sits at its offset", () => {
        const table = "| a | b |\n| - | - |\n| one | two |\n| three | four |\n";
        const doc = parseDoc(table);
        const cell = find(doc, "one");
        const session = open(doc, cell, "uno");
        const next = parseDoc(table.replace("| one | two |\n", ""));
        expect(find(next, "three").start).toBe(cell.start);
        const followed = follow(session, next, 2);
        expect(followed.gone).toEqual({ place: null });
        expect(followed.unit).toBe(cell);
    });

    test("an empty cell whose row is deleted never turns into a blind insert", () => {
        const table = "| a | b |\n| - | - |\n|  | x |\n| y | z |\n";
        const doc = parseDoc(table);
        const cell = flattenUnits(doc.units).find(
            (unit) => unit.kind === "tableCell" && unit.end === unit.start,
        );
        expect(cell).toBeDefined();
        const session = open(doc, cell!, "filled");
        const next = parseDoc(table.replace("|  | x |\n", ""));
        expect(follow(session, next, 2).gone).not.toBeNull();
    });

    test("unchanged roots return the same session", () => {
        const doc = parseDoc(SOURCE);
        const session = open(doc, find(doc, "Beta para."), "x");
        expect(follow(session, doc, 5)).toBe(session);
    });
});

describe("put it back", () => {
    test("next to a heading that abuts the next paragraph, a blank line on both sides", () => {
        const source = "## Setup\nX para.\n\nY para.\n";
        const doc = parseDoc(source);
        const session = open(doc, find(doc, "X para."), "My X.");
        // X goes, and the heading now abuts Y by one line ending.
        const now = "## Setup\nY para.\n";
        const next = parseDoc(now);
        const followed = follow(session, next, 2);
        const result = apply(now, reinsertEdit(followed, next)!);
        expect(result).toBe("## Setup\n\nMy X.\n\nY para.\n");
        expect(parseDoc(result).units.map((unit) => result.slice(unit.start, unit.end))).toEqual([
            "## Setup",
            "My X.",
            "Y para.",
        ]);
    });

    test("next to a closing fence that abuts the next paragraph", () => {
        const source = "```\ncode\n```\n\nX para.\n\nY para.\n";
        const doc = parseDoc(source);
        const session = open(doc, find(doc, "X para."), "My X.");
        const now = "```\ncode\n```\nY para.\n";
        const next = parseDoc(now);
        const result = apply(now, reinsertEdit(follow(session, next, 2), next)!);
        expect(result).toBe("```\ncode\n```\n\nMy X.\n\nY para.\n");
        expect(parseDoc(result).units.map((unit) => unit.kind)).toEqual([
            "code",
            "paragraph",
            "paragraph",
        ]);
    });

    test("with CRLF line endings, and at the end of the doc", () => {
        const source = "# T\r\n\r\nA.\r\n\r\nB.\r\n";
        const doc = parseDoc(source);
        const session = open(doc, find(doc, "B."), "My B.");
        const now = "# T\r\n\r\nA.\r\n";
        const next = parseDoc(now);
        expect(apply(now, reinsertEdit(follow(session, next, 2), next)!)).toBe(
            "# T\r\n\r\nA.\r\n\r\nMy B.\r\n",
        );
    });

    test("a second click while the first is in flight inserts nothing", async () => {
        const doc = parseDoc(SOURCE);
        const session = open(doc, find(doc, "Beta para."), "My rewrite.");
        const next = parseDoc(SOURCE.replace("Beta para.\n\n", ""));
        const gone = follow(session, next, 2);
        const calls: unknown[] = [];
        const settle = Promise.withResolvers<void>();
        const save = async (edit: unknown) => {
            calls.push(edit);
            await settle.promise;
            return { ok: true as const };
        };
        const first = putBack(gone, next, save);
        const second = await putBack(gone, next, save);
        expect(second).toBeNull();
        settle.resolve();
        expect(await first).toEqual({ ok: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ before: "", version: 2 });
    });
});

describe("pairing with a neighbour", () => {
    test("one save deleting the edited unit and rewriting a later one detaches, never pairs", () => {
        const source = "Alpha.\n\nBeta.\n\nGamma.\n\nOmega.\n";
        const doc = parseDoc(source);
        const session = open(doc, find(doc, "Beta."), "My beta rewrite.");
        const next = parseDoc("Alpha.\n\nGamma, by the agent.\n\nOmega.\n");
        const followed = follow(session, next, 2);
        expect(followed.theirs).toBeNull();
        expect(followed.gone?.place?.after).toBe(find(next, "Alpha."));
        // Nothing can save over the agent's rewrite: the editor is out of the doc.
        expect(followed.unit).toBe(session.unit);
    });

    test("an edit to the unit alone, or to it and a neighbour, pairs when no other reading exists", () => {
        const source = "Alpha.\n\nBeta.\n\nGamma.\n";
        const doc = parseDoc(source);
        const session = open(doc, find(doc, "Beta."), "Mine.");
        const alone = follow(session, parseDoc(source.replace("Beta.", "Beta, theirs.")), 2);
        expect(alone).toMatchObject({ theirs: "Beta, theirs.", gone: null });
        const both = follow(
            session,
            parseDoc(source.replace("Beta.", "Beta, theirs.").replace("Gamma.", "Gamma 2.")),
            2,
        );
        // Two rewrites side by side: the only shortest reading keeps each in its place.
        expect(both).toMatchObject({ theirs: "Beta, theirs.", gone: null });
    });
});

describe("a waiting draft", () => {
    test("blocks opening another unit", () => {
        const doc = parseDoc(SOURCE);
        const session = open(doc, find(doc, "Beta para."), "My rewrite.");
        const gone = follow(session, parseDoc(SOURCE.replace("Beta para.\n\n", "")), 2);
        const fresh = open(doc, find(doc, "Alpha para."), "Alpha para.");
        expect(beginSession(gone, fresh)).toBe(gone);
        expect(beginSession(session, fresh)).toBe(fresh);
        expect(beginSession(null, fresh)).toBe(fresh);
    });

    test("comes back after a reload from its record, with copy and discard only", () => {
        const doc = parseDoc(SOURCE);
        const unit = find(doc, "Beta para.");
        const restored = restoreStranded(
            strandedRecord({ unit, draft: "My rewrite." }),
            doc,
            9,
            4,
        )!;
        expect(restored).toMatchObject({
            id: 4,
            draft: "My rewrite.",
            gone: { place: null },
            version: 9,
        });
        expect(restored.unit.kind).toBe("paragraph");
        expect(reinsertEdit(restored, doc)).toBeNull();
        expect(restoreStranded("not json", doc, 1, 1)).toBeNull();
        expect(restoreStranded(null, doc, 1, 1)).toBeNull();
    });
});

describe("pairing at the end of a sibling list", () => {
    test("(a) the edited unit's next neighbour is last, and one save deletes it and rewrites that neighbour", () => {
        const doc = parseDoc("# T\n\nAlpha.\n\nBeta.\n\nGamma.\n");
        const session = open(doc, find(doc, "Beta."), "My beta rewrite.");
        const next = parseDoc("# T\n\nAlpha.\n\nGamma by agent.\n");
        const followed = follow(session, next, 2);
        expect(followed.theirs).toBeNull();
        expect(followed.gone?.place?.after).toBe(find(next, "Alpha."));
    });

    test("(b) the edited unit is last, and one save inserts a paragraph above it and rewrites it", () => {
        const doc = parseDoc("# T\n\nBeta.\n");
        const session = open(doc, find(doc, "Beta."), "My beta rewrite.");
        const followed = follow(session, parseDoc("# T\n\nNew agent para.\n\nBeta by agent.\n"), 2);
        expect(followed.theirs).toBeNull();
        expect(followed.gone).not.toBeNull();
    });

    test("ordinary cases still pair or follow", () => {
        const source = "# T\n\nAlpha.\n\nBeta.\n\nGamma.\n";
        const doc = parseDoc(source);
        const session = open(doc, find(doc, "Beta."), "Mine.");
        const outcome = (text: string) => {
            const next = parseDoc(text);
            const followed = follow(session, next, 2);
            return followed.gone
                ? "gone"
                : (followed.theirs ??
                      `followed ${next.source.slice(followed.unit.start, followed.unit.end)}`);
        };
        expect(outcome("# T\n\nAlpha.\n\nBeta 2.\n\nGamma.\n")).toBe("Beta 2.");
        expect(outcome("# T\n\nAlpha 2.\n\nBeta 2.\n\nGamma.\n")).toBe("Beta 2.");
        expect(outcome("# T\n\nAlpha.\n\nNew.\n\nBeta.\n\nGamma.\n")).toBe("followed Beta.");
        expect(outcome("# T\n\nNew.\n\nAlpha.\n\nBeta 2.\n\nGamma.\n")).toBe("Beta 2.");
        // The last unit edited alone, and the first, still pair.
        const last = open(doc, find(doc, "Gamma."), "Mine.");
        expect(follow(last, parseDoc(source.replace("Gamma.", "Gamma 2.")), 2).theirs).toBe(
            "Gamma 2.",
        );
        const first = open(doc, find(doc, "# T"), "# Mine");
        expect(follow(first, parseDoc(source.replace("# T", "# T 2")), 2).theirs).toBe("# T 2");
    });
});

describe("nudges", () => {
    test("count per removed session and start over for the next one", () => {
        let nudge = nextNudge(null, 3);
        nudge = nextNudge(nudge, 3);
        expect(nudgeFor(nudge, 3)).toBe(2);
        expect(nudgeFor(nudge, 4)).toBe(0);
        expect(nextNudge(nudge, 4)).toEqual({ id: 4, count: 1 });
        expect(nudgeFor(null, 3)).toBe(0);
    });
});

describe("pairing when neighbours shift together (fix pass 4)", () => {
    const outcome = (source: string, target: string, after: string) => {
        const doc = parseDoc(source);
        const followed = follow(open(doc, find(doc, target), "MINE."), parseDoc(after), 2);
        return followed.gone ? "gone" : (followed.theirs ?? "followed");
    };

    test("delete the unit and rewrite the next two: detaches", () => {
        expect(
            outcome(
                "# T\n\nAlpha.\n\nBeta.\n\nGamma.\n\nDelta.\n",
                "Beta.",
                "# T\n\nAlpha.\n\nGamma 2.\n\nDelta 2.\n",
            ),
        ).toBe("gone");
    });

    test("insert above the unit and rewrite it and the next: detaches", () => {
        expect(
            outcome(
                "# T\n\nAlpha.\n\nBeta.\n\nGamma.\n",
                "Beta.",
                "# T\n\nAlpha.\n\nNew.\n\nBeta 2.\n\nGamma 2.\n",
            ),
        ).toBe("gone");
    });

    test("the same at the start of a list and among list items", () => {
        expect(outcome("Beta.\n\nGamma.\n\nDelta.\n", "Beta.", "Gamma 2.\n\nDelta 2.\n")).toBe(
            "gone",
        );
        expect(outcome("- a\n- b\n- c\n- d\n", "- b", "- a\n- c 2\n- d 2\n")).toBe("gone");
        // A list item edited alone still pairs, through its unchanged neighbours.
        expect(outcome("- a\n- b\n- c\n", "- b", "- a\n- b 2\n- c\n")).toBe("- b 2");
    });
});

describe("moves and repeats (fix pass 5)", () => {
    const outcome = (source: string, target: string, after: string) => {
        const doc = parseDoc(source);
        const followed = follow(open(doc, find(doc, target), "MINE."), parseDoc(after), 2);
        return followed.gone ? "gone" : (followed.theirs ?? "followed");
    };

    test("a unit moved into the edited unit's slot is not its rewrite", () => {
        // One save moves Gamma below Beta and deletes Alpha: Keep mine must not replace Gamma.
        expect(
            outcome("# T\n\nGamma.\n\nBeta.\n\nAlpha.\n", "Alpha.", "# T\n\nBeta.\n\nGamma.\n"),
        ).toBe("gone");
        expect(outcome("- g\n- b\n- a\n", "- a", "- b\n- g\n")).toBe("gone");
        expect(
            outcome(
                "# T\n\nGamma.\n\nBeta.\n\nAlpha.\n\nOmega.\n",
                "Alpha.",
                "# T\n\nBeta.\n\nGamma.\n\nOmega.\n",
            ),
        ).toBe("gone");
        expect(outcome("Alpha.\n\nBeta.\n\nGamma.\n", "Alpha.", "Gamma.\n\nBeta.\n")).toBe("gone");
    });

    test("regression: the property's counterexample for seed 1577698754, path 2297", () => {
        expect(outcome("Echo.\n\nGamma.\n\nBeta.\n\nAlpha.\n", "Alpha.", "Beta.\n\nGamma.\n")).toBe(
            "gone",
        );
    });

    test("repeats elsewhere in the doc do not detach a unit edited alone", () => {
        expect(
            outcome(
                "## Notes\n\nAlpha.\n\n## Notes\n\nBeta.\n\nGamma.\n",
                "Beta.",
                "## Notes\n\nAlpha.\n\n## Notes\n\nBeta 2.\n\nGamma.\n",
            ),
        ).toBe("Beta 2.");
        expect(
            outcome(
                "Alpha.\n\n---\n\nBeta.\n\n---\n\nGamma.\n",
                "Beta.",
                "Alpha.\n\n---\n\nBeta 2.\n\n---\n\nGamma.\n",
            ),
        ).toBe("Beta 2.");
        expect(
            outcome(
                "Same.\n\nAlpha.\n\nBeta.\n\nGamma.\n\nSame.\n",
                "Beta.",
                "Same.\n\nAlpha.\n\nBeta 2.\n\nGamma.\n\nSame.\n",
            ),
        ).toBe("Beta 2.");
        expect(outcome("- x\n- a\n- b\n- c\n- x\n", "- b", "- x\n- a\n- b 2\n- c\n- x\n")).toBe(
            "- b 2",
        );
    });

    test("a list item edited alone pairs when the agent also edits a paragraph outside the list", () => {
        expect(
            outcome(
                "Intro.\n\n- a\n- b\n- c\n\nOutro.\n",
                "- b",
                "Intro 2.\n\n- a\n- b 2\n- c\n\nOutro.\n",
            ),
        ).toBe("- b 2");
        expect(
            outcome(
                "# T\n\nA.\n\nB.\n\nC.\n\nD.\n\nE.\n",
                "B.",
                "# T\n\nA.\n\nB 2.\n\nC.\n\nD 2.\n\nE.\n",
            ),
        ).toBe("B 2.");
    });

    test("other shapes that still pair: nested item, table cell, CRLF, the only unit", () => {
        expect(outcome("- a\n  - x\n  - y\n- b\n", "- y", "- a\n  - x\n  - y 2\n- b\n")).toBe(
            "- y 2",
        );
        expect(
            outcome("| a | b |\n| - | - |\n| 1 | 2 |\n", "2", "| a | b |\n| - | - |\n| 1 | 3 |\n"),
        ).toBe("3");
        expect(
            outcome(
                "# T\r\n\r\nAlpha.\r\n\r\nBeta.\r\n\r\nGamma.\r\n",
                "Beta.",
                "# T\r\n\r\nAlpha.\r\n\r\nBeta 2.\r\n\r\nGamma.\r\n",
            ),
        ).toBe("Beta 2.");
        expect(outcome("Alpha.\n", "Alpha.", "Alpha 2.\n")).toBe("Alpha 2.");
    });
});

describe("fix pass 6 shapes", () => {
    const outcome = (source: string, target: string, after: string) => {
        const doc = parseDoc(source);
        const followed = follow(open(doc, find(doc, target), "MINE."), parseDoc(after), 2);
        return followed.gone ? "gone" : (followed.theirs ?? "followed");
    };

    test("the edited unit moved intact while a new unit takes its slot: detaches", () => {
        expect(outcome("A.\n\nB.\n\nC.\n", "B.", "A.\n\nX.\n\nC.\n\nB.\n")).toBe("gone");
        expect(outcome("A.\n\nB.\n\nC.\n\nD.\n", "B.", "A.\n\nX.\n\nC.\n\nD.\n\nB.\n")).toBe(
            "gone",
        );
        expect(outcome("- a\n- b\n- c\n- d\n", "- b", "- a\n- x\n- c\n- d\n- b\n")).toBe("gone");
        expect(
            outcome("# T\n\nA.\n\nB.\n\nC.\n\nD.\n", "B.", "# T\n\nA.\n\nX.\n\nC.\n\nD.\n\nB.\n"),
        ).toBe("gone");
        expect(outcome("> A.\n>\n> B.\n>\n> C.\n", "B.", "> A.\n>\n> X.\n>\n> C.\n>\n> B.\n")).toBe(
            "gone",
        );
    });

    test("moved up instead, the unit follows itself", () => {
        expect(outcome("A.\n\nB.\n\nC.\n", "B.", "B.\n\nA.\n\nX.\n\nC.\n")).not.toBe("X.");
        expect(outcome("A.\n\nB.\n\nC.\n\nD.\n", "B.", "B.\n\nA.\n\nX.\n\nC.\n\nD.\n")).not.toBe(
            "X.",
        );
    });

    test("an edited empty cell still pairs when another empty cell stays empty", () => {
        const table = "| a | b | c |\n| - | - | - |\n|  | x |  |\n";
        const doc = parseDoc(table);
        const cell = flattenUnits(doc.units).find(
            (unit) => unit.kind === "tableCell" && unit.end === unit.start,
        )!;
        const next = parseDoc("| a | b | c |\n| - | - | - |\n| filled | x |  |\n");
        expect(follow(open(doc, cell, "mine"), next, 2).theirs).toBe("filled");
    });

    test("a sibling moved into the deleted slot and edited still pairs: Restore covers it", () => {
        // The rule cannot tell this from a rewrite (see replacements.test.ts for the safety net).
        expect(
            outcome("# T\n\nGamma.\n\nBeta.\n\nAlpha.\n", "Alpha.", "# T\n\nBeta.\n\nGamma 2.\n"),
        ).toBe("Gamma 2.");
        expect(outcome("- g\n- b\n- a\n", "- a", "- b\n- g 2\n")).toBe("- g 2");
    });

    test("past the size cap the check is not computed: the session detaches", () => {
        const many = Array.from({ length: 501 }, (_, i) => `Para ${i}.`).join("\n\n") + "\n";
        const doc = parseDoc(many);
        const next = parseDoc(many.replace("Para 250.", "Para 250, theirs."));
        const followed = follow(open(doc, find(doc, "Para 250."), "MINE."), next, 2);
        expect(followed.gone).not.toBeNull();
        const under = Array.from({ length: 499 }, (_, i) => `Para ${i}.`).join("\n\n") + "\n";
        const small = parseDoc(under);
        expect(
            follow(
                open(small, find(small, "Para 250."), "MINE."),
                parseDoc(under.replace("Para 250.", "Para 250, theirs.")),
                2,
            ).theirs,
        ).toBe("Para 250, theirs.");
    });
});

type Op =
    | { kind: "insert"; at: number }
    | { kind: "delete"; at: number }
    | { kind: "rewrite"; at: number }
    | { kind: "move"; at: number; to: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant("insert" as const), at: fc.nat(8) }),
    fc.record({ kind: fc.constant("delete" as const), at: fc.nat(8) }),
    fc.record({ kind: fc.constant("rewrite" as const), at: fc.nat(8) }),
    fc.record({ kind: fc.constant("move" as const), at: fc.nat(8), to: fc.nat(8) }),
);

interface Traced {
    text: string;
    /** The old index this unit came from, or -1 for an insert. */
    from: number;
    rewritten: boolean;
}

/**
 * Applies the save and keeps its trace. Every text is unique (old units `P0`…, each insert or
 * rewrite a fresh `N<op>`), so which unit went where is known, not inferred.
 */
function applyTraced(count: number, ops: Op[]): Traced[] {
    const out: Traced[] = Array.from({ length: count }, (_, from) => ({
        text: `P${from}.`,
        from,
        rewritten: false,
    }));
    ops.forEach((op, index) => {
        const fresh = `N${index}.`;
        if (op.kind === "insert") {
            out.splice(op.at % (out.length + 1), 0, { text: fresh, from: -1, rewritten: false });
        } else if (out.length > 0 && op.kind === "delete") {
            out.splice(op.at % out.length, 1);
        } else if (out.length > 0 && op.kind === "rewrite") {
            const at = op.at % out.length;
            out[at] = { ...out[at]!, text: fresh, rewritten: true };
        } else if (out.length > 0 && op.kind === "move") {
            const [unit] = out.splice(op.at % out.length, 1);
            out.splice(op.to % (out.length + 1), 0, unit!);
        }
    });
    return out;
}

/** Paragraphs, or the items of one list: the same kind at one level, as the property asks. */
function render(texts: string[], asList: boolean): string {
    return asList
        ? texts.map((text) => `- ${text}\n`).join("")
        : texts.map((text) => `${text}\n`).join("\n");
}

describe("pairing property", () => {
    test(
        "judged by the save's own trace: a pairing is never wrong where the trace allows one answer",
        () => {
            checkProperty(
                fc.property(
                    fc.integer({ min: 1, max: 8 }),
                    fc.nat(7),
                    fc.array(opArb, { minLength: 1, maxLength: 3 }),
                    fc.boolean(),
                    (count, pick, ops, asList) => {
                        const k = pick % count;
                        const texts = Array.from({ length: count }, (_, i) => `P${i}.`);
                        const doc = parseDoc(render(texts, asList));
                        const units = asList ? doc.units[0]!.children : doc.units;
                        const session = open(doc, units[k]!, "MINE.");
                        const after = applyTraced(count, ops);
                        if (after.length === 0) {
                            return;
                        }
                        const next = parseDoc(
                            render(
                                after.map((entry) => entry.text),
                                asList,
                            ),
                        );
                        const followed = follow(session, next, 2);
                        if (followed.gone) {
                            return;
                        }
                        const nextUnits = asList ? next.units[0]!.children : next.units;
                        const j = nextUnits.indexOf(followed.unit);
                        const paired = after[j]!;
                        const survivor = after.findIndex((entry) => entry.from === k);
                        const fresh = after.filter((entry) => entry.text.startsWith("N"));
                        const verdict = (() => {
                            if (followed.theirs === null) {
                                // Followed unchanged text: with unique texts, only the unit itself.
                                return paired.from === k && !paired.rewritten;
                            }
                            if (survivor >= 0 && !after[survivor]!.rewritten) {
                                // It survives intact elsewhere: pairing with another unit is wrong.
                                return false;
                            }
                            if (survivor < 0) {
                                // Deleted. With no new text anywhere, nothing can be its rewrite;
                                // with some, a rewrite is one reading of the save: no single answer.
                                return fresh.length > 0 ? "skip" : false;
                            }
                            // Rewritten: the answer is clear when its new text is the only new text.
                            return fresh.length === 1 ? j === survivor : "skip";
                        })();
                        expect({ count, k, ops, asList, j, verdict }).not.toMatchObject({
                            verdict: false,
                        });
                    },
                ),
                500,
            );
        },
        scaledTimeout(20_000),
    );
});
