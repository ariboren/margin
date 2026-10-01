import { describe, expect, test } from "bun:test";
import type { EditEvent } from "./model.ts";
import { byteLength, formatEdit, hunkPieces, netEdits, pendingEdit, wordHunks } from "./diff.ts";

function words(count: number, from = 0): string {
    return Array.from({ length: count }, (_, i) => `w${from + i}`).join(" ");
}

/** A one-line paragraph of about `chars` characters, with code spans like the samples. */
function paragraph(chars: number): string {
    const parts: string[] = [];
    for (let i = 0; parts.join(" ").length < chars; i++) {
        parts.push(i % 9 === 4 ? `\`call${i}()\`` : `word${i}`);
    }
    return parts.join(" ").slice(0, chars);
}

describe("wordHunks", () => {
    test("identical text has no hunks", () => {
        expect(wordHunks("same text here", "same text here")).toEqual([]);
    });

    test("keeps four words of context each side and marks the cuts", () => {
        const before = words(20);
        const after = before.replace("w10", "changed");
        expect(wordHunks(before, after)).toEqual([
            { text: "…w6 w7 w8 w9 [-w10-]{+changed+} w11 w12 w13 w14…", changedBytes: 10 },
        ]);
    });

    test("no ellipsis where the context reaches the start or end", () => {
        const [hunk] = wordHunks("a b c", "a x c");
        expect(hunk!.text).toBe("a [-b-]{+x+} c");
    });

    test("folds adjacent word changes into one removal and one insertion", () => {
        const [hunk] = wordHunks(words(12), words(12).replace("w5 w6 w7", "one two three"));
        expect(hunk!.text).toBe("…w1 w2 w3 w4 [-w5 w6 w7-]{+one two three+} w8 w9 w10 w11");
    });

    test("changes whose context would overlap share a hunk", () => {
        const before = words(30);
        const after = before.replace("w5", "x").replace("w12", "y");
        expect(wordHunks(before, after)).toHaveLength(1);
    });

    test("changes far apart get separate hunks", () => {
        const before = words(40);
        const after = before.replace("w5", "x").replace("w30", "y");
        const hunks = wordHunks(before, after);
        expect(hunks.map((hunk) => hunk.text)).toEqual([
            "…w1 w2 w3 w4 [-w5-]{+x+} w6 w7 w8 w9…",
            "…w26 w27 w28 w29 [-w30-]{+y+} w31 w32 w33 w34…",
        ]);
    });

    test("pure insertions and deletions", () => {
        expect(wordHunks("a b c", "a b new c")[0]!.text).toBe("a b {+new +}c");
        expect(wordHunks("a b old c", "a b c")[0]!.text).toBe("a b [-old -]c");
        expect(wordHunks("", "all new")[0]!.text).toBe("{+all new+}");
    });

    test("escapes line breaks so a hunk stays on one line", () => {
        const [hunk] = wordHunks("- one\r\n- two", "- one\r\n- three");
        expect(hunk!.text).toBe("- one\\n- [-two-]{+three+}");
    });

    test("keeps code spans intact around a change inside them", () => {
        const [hunk] = wordHunks("call `foo()` here", "call `bar()` here");
        expect(hunk!.text).toBe("call `[-foo-]{+bar+}()` here");
    });

    test("counts changed bytes as UTF-8", () => {
        const [hunk] = wordHunks("a b c", "a é c");
        expect(hunk!.changedBytes).toBe(byteLength("b") + byteLength("é"));
    });
});

describe("hunkPieces", () => {
    test("gives each hunk its pieces and which sides were cut, unescaped", () => {
        const before = `${words(20)}\nmore`;
        const after = before.replace("w10", "changed");
        expect(hunkPieces(before, after)).toEqual([
            {
                pieces: [
                    { kind: "same", text: "w6" },
                    { kind: "same", text: " " },
                    { kind: "same", text: "w7" },
                    { kind: "same", text: " " },
                    { kind: "same", text: "w8" },
                    { kind: "same", text: " " },
                    { kind: "same", text: "w9" },
                    { kind: "same", text: " " },
                    { kind: "del", text: "w10" },
                    { kind: "ins", text: "changed" },
                    { kind: "same", text: " " },
                    { kind: "same", text: "w11" },
                    { kind: "same", text: " " },
                    { kind: "same", text: "w12" },
                    { kind: "same", text: " " },
                    { kind: "same", text: "w13" },
                    { kind: "same", text: " " },
                    { kind: "same", text: "w14" },
                ],
                cutBefore: true,
                cutAfter: true,
            },
        ]);
        expect(hunkPieces("a\nb", "a\nc")[0]!.pieces).toContainEqual({ kind: "same", text: "\n" });
    });
});

describe("pendingEdit", () => {
    test("a 3-word change in a 1,600-char paragraph renders under 200 B", () => {
        const before = paragraph(1600);
        expect(before).toHaveLength(1600);
        const target = before.split(" ").slice(120, 123).join(" ");
        const after = before.replace(target, "three new words");
        const edit = pendingEdit({
            before,
            after,
            line: 212,
            headingPath: ["Review", "3. Findings", "3.2 Cache key churn"],
            title: "Review",
        });
        const rendered = formatEdit(edit);
        expect(edit.path).toBe("3. Findings > 3.2 Cache key churn");
        expect(edit.hunks).toHaveLength(1);
        expect(byteLength(rendered)).toBeLessThan(200);
    });

    test("renders a header line and one line per hunk", () => {
        const before = words(40);
        const edit = pendingEdit({
            before,
            after: before.replace("w5", "x").replace("w30", "y"),
            line: 7,
            headingPath: ["1. Scope"],
        });
        expect(formatEdit(edit).split("\n")).toEqual([
            "edit L7 1. Scope",
            `  ${edit.hunks[0]}`,
            `  ${edit.hunks[1]}`,
        ]);
    });
});

describe("netEdits", () => {
    const edit = (seq: number, of?: number, by: "user" | "agent" = "user"): EditEvent => ({
        seq,
        at: new Date(Date.UTC(2026, 8, 30, 12, 0, seq)).toISOString(),
        by,
        type: "edit",
        cause: of === undefined ? (by === "user" ? "user" : "apply") : "undo",
        ...(of === undefined ? {} : { of }),
        start: 0,
        before: seq % 2 ? "a" : "b",
        after: seq % 2 ? "b" : "a",
        line: 1,
        headingPath: [],
    });
    const E = edit(2);
    const U = edit(4, 2);
    const R = edit(6, 4);
    const seqs = (edits: EditEvent[], cursor?: number) => netEdits(edits, cursor).map((e) => e.seq);

    test("an undo cancels its edit, a redo cancels the undo: E, E U, E U R at every cursor", () => {
        expect(seqs([E])).toEqual([2]);
        expect(seqs([E, U])).toEqual([]);
        expect(seqs([E, U, R])).toEqual([6]);
        expect(seqs([E, U, R], 1)).toEqual([6]);
        expect(seqs([E, U, R], 2)).toEqual([]);
        expect(seqs([E, U, R], 3)).toEqual([]);
        expect(seqs([E, U, R], 4)).toEqual([6]);
        expect(seqs([E, U, R], 5)).toEqual([6]);
        expect(seqs([E, U, R], 6)).toEqual([]);
        expect(seqs([E, U], 2)).toEqual([4]);
        expect(seqs([E, U], 3)).toEqual([4]);
    });

    test("edits outside a chain, including an agent's between an undo and its redo, stay", () => {
        const other = edit(5, undefined, "agent");
        const mine = edit(7);
        expect(seqs([E, U, other, R, mine])).toEqual([5, 6, 7]);
        expect(seqs([E, U, other, R, mine], 2)).toEqual([5, 7]);
        expect(seqs([E, U, other, R, mine], 6)).toEqual([7]);
    });

    test("a chain of four is nothing; of five, its last", () => {
        const U2 = edit(8, 6);
        const R2 = edit(10, 8);
        expect(seqs([E, U, R, U2])).toEqual([]);
        expect(seqs([E, U, R, U2, R2])).toEqual([10]);
        expect(seqs([E, U, R, U2, R2], 4)).toEqual([10]);
    });
});
