import { describe, expect, test } from "bun:test";
import { flattenUnits, hashText, parseDoc, spliceEdit } from "../core/blocks.ts";
import type { ParsedDoc, Unit } from "../core/model.ts";
import { mapStartStrict } from "../server/session.ts";
import { follow, type EditorSession } from "./editor-session.ts";
import {
    newReplacement,
    parseReplacements,
    rebase,
    restoreEdit,
    type Replacement,
} from "./replacements.ts";

function open(doc: ParsedDoc, unit: Unit, draft: string): EditorSession {
    return {
        id: 1,
        unit,
        roots: doc.units,
        version: 1,
        before: doc.source.slice(unit.start, unit.end),
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
    expect(source.slice(edit.start, edit.start + edit.before.length)).toBe(edit.before);
    return source.slice(0, edit.start) + edit.after + source.slice(edit.start + edit.before.length);
}

/** An editor on `target` in `from`, the agent's save to `agent`, then Keep mine and its record. */
function keepMine(from: string, target: string, draft: string, agent: string) {
    const doc = parseDoc(from);
    const next = parseDoc(agent);
    const session = follow(open(doc, find(doc, target), draft), next, 2);
    expect(session.theirs).not.toBeNull();
    const edit = { start: session.unit.start, before: session.theirs!, after: draft };
    const source = apply(agent, edit);
    const record = newReplacement({
        id: "r1",
        kind: session.unit.kind,
        snapshot: { doc: parseDoc(source), version: 3 },
        at: edit.start,
        version: 3,
        mine: draft,
        replaced: edit.before,
    })!;
    expect(record).not.toBeNull();
    return { source, record };
}

function step(record: Replacement | null, from: string, to: string): Replacement | null {
    return record && rebase(record, from, to, parseDoc(to));
}

describe("a record is a range, never a text search", () => {
    test("S1: the kept cell edited again drops the record, even with the same text in another cell", () => {
        const { source, record } = keepMine(
            "| a | b |\n| - | - |\n| 1 | 2 |\n",
            "2",
            "1",
            "| a | b |\n| - | - |\n| 1 | 3 |\n",
        );
        expect(source).toBe("| a | b |\n| - | - |\n| 1 | 1 |\n");
        expect(step(record, source, "| a | b |\n| - | - |\n| 1 | 5 |\n")).toBeNull();
    });

    test("S2: kept text that also appears inside a word elsewhere", () => {
        const { source, record } = keepMine(
            "Alpha para.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
            "2",
            "a",
            "Alpha para.\n\n| a | b |\n| - | - |\n| 1 | 3 |\n",
        );
        expect(step(record, source, source.replace("| 1 | a |", "| 1 | zz |"))).toBeNull();
    });

    test("S3: a duplicate paragraph elsewhere never takes the record over", () => {
        const { source, record } = keepMine(
            "TODO\n\nAlpha.\n\nBeta.\n",
            "Beta.",
            "TODO",
            "TODO\n\nAlpha.\n\nBeta, theirs.\n",
        );
        expect(record.start).toBe(source.lastIndexOf("TODO"));
        expect(step(record, source, "TODO\n\nAlpha.\n\nTODO, again.\n")).toBeNull();
        expect(step(record, source, "TODO\n\nAlpha.\n\nDone.\n")).toBeNull();
    });

    test("S9b: text appended to the kept unit drops the record", () => {
        const { source, record } = keepMine(
            "Alpha.\n\nBeta.\n",
            "Beta.",
            "Mine.",
            "Alpha.\n\nBeta, theirs.\n",
        );
        expect(step(record, source, source.replace("Mine.", "Mine. And more."))).toBeNull();
        expect(step(record, source, source.replace("Mine.", "Mine, plus agent."))).toBeNull();
    });

    test("S11: a nested item with the same text is not the kept item", () => {
        const { source, record } = keepMine(
            "- a\n- b\n- c\n\nText.\n\n- q\n  - same\n",
            "- b",
            "- same",
            "- a\n- b 2\n- c\n\nText.\n\n- q\n  - same\n",
        );
        expect(record.start).toBe(source.indexOf("- same"));
        expect(step(record, source, source.replace("- same\n- c", "- other\n- c"))).toBeNull();
    });

    test("edits above, then below, move the card; Restore still names the keep-time range", () => {
        const { source, record } = keepMine(
            "# T\n\nAlpha.\n\nBeta.\n\nGamma.\n",
            "Beta.",
            "Mine.",
            "# T\n\nAlpha.\n\nBeta, theirs.\n\nGamma.\n",
        );
        const above = source.replace("# T", "# Other\n\nNew.");
        const below = above.replace("Gamma.", "Gamma 2.\n\nTail.");
        const moved = step(step(record, source, above), above, below)!;
        expect(moved.start).toBe(below.indexOf("Mine."));
        expect(moved.hash).toBe(hashText(below));
        // The server, not this position, decides: Restore sends where the save landed, and when.
        expect(restoreEdit(moved)).toEqual({
            start: record.keepStart,
            before: "Mine.",
            after: "Beta, theirs.",
            version: 3,
            strict: true,
        });
    });

    test("edits on both sides at once are one region over the range: dropped, not guessed", () => {
        const { source, record } = keepMine(
            "# T\n\nAlpha.\n\nBeta.\n\nGamma.\n",
            "Beta.",
            "Mine.",
            "# T\n\nAlpha.\n\nBeta, theirs.\n\nGamma.\n",
        );
        expect(
            step(record, source, "# Other\n\nAlpha 2.\n\nMine.\n\nGamma 2.\n\nTail.\n"),
        ).toBeNull();
    });

    test("an insertion at the range end that the prefix diff puts past it: kept here, refused by the server", () => {
        const { source, record } = keepMine(
            "Alpha.\n\nBeta.\n\nNext.\n",
            "Beta.",
            "Mine.",
            "Alpha.\n\nBeta, theirs.\n\nNext.\n",
        );
        // Really inserted right at the end of "Mine.": "\n\nNew." Diffed, the shared "\n\nNe"
        // slides the change past the range, so the card stays.
        const end = record.start + "Mine.".length;
        const after = `${source.slice(0, end)}\n\nNew.${source.slice(end)}`;
        expect(step(record, source, after)).not.toBeNull();
        // The server maps the logged splice, which touches the range: Restore is refused.
        const request = restoreEdit(record);
        const logged = { start: end, before: "", after: "\n\nNew." };
        expect(mapStartStrict([logged], request.start, request.before.length).exact).toBe(false);
    });

    test("an emptied cell is a zero-length range; rows added above move it, its own edit drops it", () => {
        const table = "| a | b |\n| - | - |\n| 1 | 2 |\n";
        const { source, record } = keepMine(table, "2", "", "| a | b |\n| - | - |\n| 1 | 3 |\n");
        const shifted = source.replace("| 1 |", "| 0 | 0 |\n| 1 |");
        const moved = step(record, source, shifted)!;
        expect(moved.start).toBe(record.start + "| 0 | 0 |\n".length);
        expect(step(moved, shifted, shifted.replace("| 1 |  |", "| 1 | 9 |"))).toBeNull();
    });

    test("the kept text is recorded as the save wrote it: CRLF line endings, an encoded cell", () => {
        const cases = [
            { source: "A.\r\n\r\nTheirs.\r\n\r\nB.\r\n", target: "Theirs.", draft: "One\ntwo" },
            {
                source: "| k | v |\n| - | - |\n| a | Theirs |\n",
                target: "Theirs",
                draft: "x | y\nz",
            },
        ];
        for (const { source, target, draft } of cases) {
            const doc = parseDoc(source);
            const unit = find(doc, target);
            const saved = spliceEdit(doc, { start: unit.start, before: target, after: draft });
            if (saved.status !== "changed") {
                throw new Error(`save ${saved.status}`);
            }
            expect(saved.edit.after).not.toBe(draft);
            const record = newReplacement({
                id: "r1",
                kind: unit.kind,
                snapshot: { doc: parseDoc(saved.source), version: 3 },
                at: unit.start,
                version: 3,
                mine: draft,
                replaced: target,
            });
            expect(record).not.toBeNull();
            expect(restoreEdit(record!)).toMatchObject({ before: saved.edit.after, after: target });
        }
    });

    test("no record when the settled page is past the save's version: its range means nothing there", () => {
        const kept = "# T\n\n| a | b |\n| - | - |\n| x |  |\n| y |  |\n";
        // A title save queued behind Keep mine, pushed before its response: the x row's empty
        // cell now sits exactly where the y row's was.
        const later = kept.replace("# T\n", "# Txxxxxxxxx\n");
        const at = kept.lastIndexOf("|  |") + 2;
        expect(later.slice(at - 2, at + 2)).toBe("|  |");
        const input = { id: "r1", kind: "tableCell", at, mine: "", replaced: "agent" } as const;
        expect(
            newReplacement({
                ...input,
                snapshot: { doc: parseDoc(later), version: 5 },
                version: 4,
            }),
        ).toBeNull();
        expect(
            newReplacement({ ...input, snapshot: { doc: parseDoc(kept), version: 4 }, version: 4 }),
        ).not.toBeNull();
    });

    test("records survive a reload as data; anything malformed is dropped", () => {
        const { record } = keepMine("A.\n\nB.\n", "B.", "C.", "A.\n\nB 2.\n");
        expect(parseReplacements(JSON.stringify([record, { id: 3 }, "x"]))).toEqual([record]);
        expect(parseReplacements("not json")).toEqual([]);
        expect(parseReplacements(null)).toEqual([]);
    });
});
