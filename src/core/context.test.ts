import { describe, expect, test } from "bun:test";
import { parseDoc } from "./blocks.ts";
import {
    clipHead,
    clipQuote,
    clipTail,
    docTitle,
    formatPath,
    QUOTE_CAP,
    SIDE_CAP,
    threadContext,
} from "./context.ts";
import { byteLength } from "./diff.ts";

function words(count: number, word = "word"): string {
    return Array.from({ length: count }, (_, i) => `${word}${i}`).join(" ");
}

function rangeOf(source: string, quote: string): { start: number; end: number } {
    const start = source.indexOf(quote);
    if (start === -1) throw new Error("quote not in source");
    return { start, end: start + quote.length };
}

describe("clipping", () => {
    test("text within the cap is unchanged", () => {
        expect(clipHead("short text", 240)).toBe("short text");
        expect(clipTail("short text", 240)).toBe("short text");
        expect(clipQuote("short text")).toBe("short text");
    });

    test("head and tail cut at whitespace and mark the cut", () => {
        const text = words(100);
        const head = clipHead(text, SIDE_CAP);
        const tail = clipTail(text, SIDE_CAP);
        expect(byteLength(head)).toBeLessThanOrEqual(SIDE_CAP);
        expect(byteLength(tail)).toBeLessThanOrEqual(SIDE_CAP);
        expect(head.endsWith("…")).toBe(true);
        expect(tail.startsWith("…")).toBe(true);
        expect(text.startsWith(head.slice(0, -1))).toBe(true);
        expect(text.endsWith(tail.slice(1))).toBe(true);
        expect(
            head
                .slice(0, -1)
                .split(" ")
                .every((word) => /^word\d+$/.test(word)),
        ).toBe(true);
        expect(
            tail
                .slice(1)
                .split(" ")
                .every((word) => /^word\d+$/.test(word)),
        ).toBe(true);
    });

    test("a long quote keeps its head and tail within the cap", () => {
        const text = words(300);
        const quote = clipQuote(text);
        expect(byteLength(quote)).toBeLessThanOrEqual(QUOTE_CAP);
        const [head, tail] = quote.split("…");
        expect(text.startsWith(head!)).toBe(true);
        expect(text.endsWith(tail!)).toBe(true);
    });

    test("caps count UTF-8 bytes and never split a code point", () => {
        const text = words(200, "é🙂");
        for (const clipped of [clipHead(text, 240), clipTail(text, 240), clipQuote(text)]) {
            expect(clipped).not.toContain("�");
            expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped)).toBe(false);
            expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clipped)).toBe(false);
        }
        expect(byteLength(clipHead(text, 240))).toBeLessThanOrEqual(240);
        expect(byteLength(clipQuote(text))).toBeLessThanOrEqual(QUOTE_CAP);
    });
});

describe("threadContext", () => {
    test("short paragraph: whole unit around the quote, nothing from its neighbours", () => {
        const source =
            "# Title\n\n## 1. Scope\n\nFirst paragraph here.\n\nThe quick brown fox jumps.\n\nLast one.\n";
        const context = threadContext(parseDoc(source), rangeOf(source, "brown fox"));
        expect(context).toEqual({
            path: "1. Scope",
            line: 7,
            quote: "brown fox",
            before: "The quick ",
            after: " jumps.",
        });
    });

    test("long paragraph: each side capped", () => {
        const body = words(400);
        const source = `# T\n\n${body}\n`;
        const context = threadContext(parseDoc(source), rangeOf(source, "word200 word201"));
        expect(byteLength(context.before)).toBeLessThanOrEqual(SIDE_CAP);
        expect(byteLength(context.after)).toBeLessThanOrEqual(SIDE_CAP);
        expect(context.before.startsWith("…")).toBe(true);
        expect(context.after.endsWith("…")).toBe(true);
        expect(context.before.endsWith("word199 ")).toBe(true);
        expect(context.after.startsWith(" word202")).toBe(true);
    });

    test("a quote over the cap is capped, and a quote past its unit is clipped to it", () => {
        const body = words(400);
        const source = `${body}\n\nNext paragraph.\n`;
        const context = threadContext(parseDoc(source), { start: 0, end: source.length });
        expect(byteLength(context.quote)).toBeLessThanOrEqual(QUOTE_CAP);
        expect(context.quote.endsWith(body.slice(-20))).toBe(true);
        expect(context.before).toBe("");
        expect(context.after).toBe("");
    });

    test("list item: context stays inside the item", () => {
        const source = "- first item text\n- second item has the quote in it\n- third item\n";
        const context = threadContext(parseDoc(source), rangeOf(source, "the quote"));
        expect(context.before).toBe("- second item has ");
        expect(context.after).toBe(" in it");
        expect(context.line).toBe(2);
    });

    test("table cell: the cell, its column header and the row's first cell", () => {
        const source = [
            "## Risks",
            "",
            "| Risk | Impact | Mitigation |",
            "| ---- | ------ | ---------- |",
            "| R1   | Slow first loads for low zoom tiles | Reserve one worker |",
            "| R2   | Garbled labels                       | Validate checksums |",
            "",
        ].join("\n");
        const context = threadContext(parseDoc(source), rangeOf(source, "first loads"));
        expect(context).toEqual({
            path: "Risks",
            line: 5,
            quote: "first loads",
            before: "Slow ",
            after: " for low zoom tiles",
            cell: { header: "Impact", row: "R1" },
        });
    });

    test("header row cells carry no cell context", () => {
        const source = "| Risk | Impact |\n| --- | --- |\n| R1 | Slow |\n";
        const context = threadContext(parseDoc(source), rangeOf(source, "Impact"));
        expect(context.cell).toBeUndefined();
        expect(context.before).toBe("");
    });
});

describe("paths", () => {
    test("a title shared by every unit is left out", () => {
        const doc = parseDoc("# Title\n\nIntro.\n\n## 1. Scope\n\nText.\n");
        expect(docTitle(doc)).toBe("Title");
        expect(formatPath(["Title", "1. Scope"], "Title")).toBe("1. Scope");
    });

    test("a multi-line setext heading renders on one line", () => {
        const doc = parseDoc("# Title\n\nFindings\nand  more\n--------\n\nText.\n");
        const heading = doc.units[1]!.headingPath;
        expect(heading).toEqual(["Title", "Findings\nand  more"]);
        expect(formatPath(heading, docTitle(doc))).toBe("Findings and more");
    });

    test("no title when top-level headings differ", () => {
        const doc = parseDoc("# One\n\nText.\n\n# Two\n\nText.\n");
        expect(docTitle(doc)).toBeUndefined();
        expect(formatPath(["One"], docTitle(doc))).toBe("One");
    });
});
