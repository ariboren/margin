import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    decodeSource,
    encodeCellText,
    flattenUnits,
    parseDoc,
    sourceEdit,
    spliceEdit,
    unitAt,
} from "./blocks.ts";
import type { ParsedDoc, Unit } from "./model.ts";
import { checkProperty, textArb } from "./testing.ts";

const fixtures = join(import.meta.dir, "../../fixtures");
const edgeFixtures = ["edge.md", "edge-crlf.md", "edge-nonl.md", "edge-bom.md"];
const privateSample = join(fixtures, "private/sample.md");
const hasPrivate = existsSync(privateSample);

function load(name: string): { bytes: Buffer; source: string } {
    const bytes = readFileSync(join(fixtures, name));
    return { bytes, source: decodeSource(bytes) };
}

function loadAll(): { name: string; bytes: Buffer; source: string }[] {
    const docs = edgeFixtures.map((name) => ({ name, ...load(name) }));
    if (hasPrivate) docs.push({ name: "private sample", ...load("private/sample.md") });
    return docs;
}

function expectNested(units: Unit[], parent: { start: number; end: number }): void {
    let cursor = parent.start;
    for (const unit of units) {
        expect(unit.start).toBeGreaterThanOrEqual(cursor);
        if (unit.kind === "tableCell") {
            expect(unit.end).toBeGreaterThanOrEqual(unit.start);
        } else {
            expect(unit.end).toBeGreaterThan(unit.start);
        }
        expect(unit.end).toBeLessThanOrEqual(parent.end);
        expectNested(unit.children, unit);
        cursor = unit.end;
    }
}

function expectWellFormed(doc: ParsedDoc, bytes: Buffer): void {
    expectNested(doc.units, { start: 0, end: doc.source.length });
    expect(Buffer.from(doc.source).equals(bytes)).toBe(true);
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

describe("fixtures keep their bytes", () => {
    test("edge-crlf.md uses CRLF only", () => {
        const { source } = load("edge-crlf.md");
        expect(source).toContain("\r\n");
        expect(source.replaceAll("\r\n", "")).not.toContain("\n");
    });

    test("edge-nonl.md has no trailing newline", () => {
        const { bytes } = load("edge-nonl.md");
        expect(bytes.at(-1)).not.toBe(0x0a);
    });

    test("edge-bom.md starts with a BOM", () => {
        const { bytes } = load("edge-bom.md");
        expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    });
});

describe("parseDoc", () => {
    for (const name of edgeFixtures) {
        test(`${name}: ordered, in-bounds, nested units`, () => {
            const { bytes, source } = load(name);
            const doc = parseDoc(source);
            expect(doc.units.length).toBeGreaterThan(10);
            expectWellFormed(doc, bytes);
        });
    }

    test("all edge variants yield the same unit kinds and lines at every depth", () => {
        const shape = (name: string) =>
            flattenUnits(parseDoc(load(name).source).units).map(
                (unit) => `${unit.kind}@${unit.line}`,
            );
        const base = shape("edge.md");
        for (const name of edgeFixtures) {
            expect(shape(name)).toEqual(base);
        }
    });

    test("BOM offsets point at the same text as without it", () => {
        const plain = parseDoc(load("edge.md").source);
        const bom = parseDoc(load("edge-bom.md").source);
        expect(bom.bom).toBe(true);
        const texts = (doc: ParsedDoc) =>
            flattenUnits(doc.units).map((u) => doc.source.slice(u.start, u.end));
        expect(texts(bom)).toEqual(texts(plain));
    });

    test("reports line endings and final newline", () => {
        expect(parseDoc(load("edge.md").source)).toMatchObject({ eol: "\n", finalNewline: true });
        expect(parseDoc(load("edge-crlf.md").source)).toMatchObject({
            eol: "\r\n",
            finalNewline: true,
        });
        expect(parseDoc(load("edge-nonl.md").source).finalNewline).toBe(false);
    });

    test("covers frontmatter, fences, lists, table, html and heading paths", () => {
        const doc = parseDoc(load("edge.md").source);
        const kinds = new Set<string>(doc.units.map((unit) => unit.kind));
        for (const kind of ["yaml", "heading", "code", "list", "table", "blockquote", "html"]) {
            expect(kinds).toContain(kind);
        }
        const table = doc.units.find((unit) => unit.kind === "table");
        expect(table?.headingPath).toEqual(["Edge cases", "Table"]);
        expect(table?.children[0]?.headingPath).toEqual(["Edge cases", "Table"]);
    });

    test("nests list items at every depth", () => {
        const doc = parseDoc(load("edge.md").source);
        const text = (unit: Unit | undefined) => doc.source.slice(unit!.start, unit!.end);
        const list = doc.units.find((unit) => unit.kind === "list")!;
        expect(list.children.map((unit) => unit.kind)).toEqual(["listItem", "listItem"]);
        const second = list.children[0]!.children;
        expect(second.map(text)).toEqual([
            expect.stringMatching(/^- second level/),
            "- back to second",
        ]);
        const third = second[0]!.children;
        expect(third.map((unit) => unit.line)).toEqual([third[0]!.line, third[0]!.line + 1]);
        expect(text(third[0])).toBe("1. third level ordered");
        expect(third.every((unit) => unit.children.length === 0)).toBe(true);
    });

    test("table cells are trimmed interiors with coordinates", () => {
        const doc = parseDoc(load("edge-crlf.md").source);
        const table = doc.units.find((unit) => unit.kind === "table")!;
        const cells = table.children;
        expect(cells).toHaveLength(9);
        expect(cells.map((cell) => doc.source.slice(cell.start, cell.end))).toEqual([
            "Column A",
            "Column `B`",
            "Escaped \\| pipe",
            "one",
            "`two`",
            "three",
            "four",
            "",
            "six",
        ]);
        expect(cells.map((cell) => cell.cell)).toContainEqual({ row: 2, column: 1 });
        const empty = cells[7]!;
        expect(doc.source.slice(empty.start - 2, empty.start)).toBe("| ");
    });

    test("blockquote children are units and a list ends at its last item", () => {
        const doc = parseDoc(load("edge.md").source);
        const quote = doc.units.find((unit) => unit.kind === "blockquote")!;
        expect(quote.children.map((unit) => unit.kind)).toEqual([
            "paragraph",
            "list",
            "blockquote",
        ]);
        const list = quote.children[1]!;
        expect(list.end).toBe(list.children.at(-1)!.end);
        expect(doc.source.slice(list.start, list.end)).toBe("- item one\n> - item two");
    });

    test("unitAt picks the smallest enclosing unit", () => {
        const doc = parseDoc(load("edge.md").source);
        const at = doc.source.indexOf("third level ordered");
        expect(unitAt(doc.units, { start: at, end: at + 5 })?.line).toBe(
            doc.source.slice(0, at).split("\n").length,
        );
        expect(unitAt(doc.units, { start: at, end: at + 5 })?.kind).toBe("listItem");
        const cell = doc.source.indexOf("three");
        expect(unitAt(doc.units, { start: cell, end: cell + 5 })?.kind).toBe("tableCell");
        expect(unitAt(doc.units, { start: cell - 3, end: cell + 5 })?.kind).toBe("table");
    });
});

describe("spliceEdit", () => {
    for (const { name, bytes, source } of loadAll()) {
        test(`${name}: re-saving every unit's own text writes nothing`, () => {
            const doc = parseDoc(source);
            for (const unit of flattenUnits(doc.units)) {
                const text = source.slice(unit.start, unit.end);
                expect(spliceEdit(doc, { start: unit.start, before: text, after: text })).toEqual({
                    status: "unchanged",
                });
            }
            expect(Buffer.from(doc.source).equals(bytes)).toBe(true);
        });

        test(`${name}: an edit changes only its unit's bytes`, () => {
            const doc = parseDoc(source);
            const units = flattenUnits(doc.units);
            expect(units.length).toBeGreaterThan(0);
            for (const unit of units) {
                const text = source.slice(unit.start, unit.end);
                const result = spliceEdit(doc, {
                    start: unit.start,
                    before: text,
                    after: `X${text}Y`,
                });
                if (result.status !== "changed") throw new Error(`no change at ${unit.start}`);
                const out = Buffer.from(result.source);
                const head = byteLength(source.slice(0, unit.start));
                const tail = byteLength(source.slice(unit.end));
                expect(out.subarray(0, head).equals(bytes.subarray(0, head))).toBe(true);
                expect(
                    out.subarray(out.length - tail).equals(bytes.subarray(bytes.length - tail)),
                ).toBe(true);
                expect(out.length).toBe(bytes.length + 2);
            }
        });
    }

    test("property: a splice anywhere in a unit changes only its range, and re-saving is a no-op", () => {
        const names = [...edgeFixtures, "public-sample.md"];
        const docs = new Map(
            names.map((name) => {
                const { bytes, source } = load(name);
                const doc = parseDoc(source);
                return [name, { bytes, doc, units: flattenUnits(doc.units) }];
            }),
        );
        checkProperty(
            fc.property(
                fc.constantFrom(...names),
                fc.nat(),
                fc.nat(),
                fc.nat(),
                textArb,
                (name, rawUnit, rawStart, rawLength, after) => {
                    const { bytes, doc, units } = docs.get(name)!;
                    const { source } = doc;
                    const unit = units[rawUnit % units.length]!;
                    const start = unit.start + (rawStart % (unit.end - unit.start + 1));
                    const end = start + (rawLength % (unit.end - start + 1));
                    const before = source.slice(start, end);
                    expect(spliceEdit(doc, { start, before, after: before })).toEqual({
                        status: "unchanged",
                    });
                    const result = spliceEdit(doc, { start, before, after });
                    if (result.status === "unchanged") return;
                    if (result.status !== "changed") throw new Error(`conflict at ${start}`);
                    expect(result.edit).toMatchObject({ start, before });
                    expect(result.source).toBe(
                        source.slice(0, start) + result.edit.after + source.slice(end),
                    );
                    const out = Buffer.from(result.source);
                    const head = byteLength(source.slice(0, start));
                    const tail = byteLength(source.slice(end));
                    expect(out.subarray(0, head).equals(bytes.subarray(0, head))).toBe(true);
                    expect(
                        out.subarray(out.length - tail).equals(bytes.subarray(bytes.length - tail)),
                    ).toBe(true);
                    const inCell = unitAt(doc.units, { start, end })?.kind === "tableCell";
                    if (inCell) expect(result.edit.after).not.toContain("\n");
                    else if (doc.eol === "\r\n") expect(result.edit.after).not.toMatch(/(?<!\r)\n/);
                    else expect(result.edit.after).not.toContain("\r\n");
                },
            ),
            1000,
        );
    });

    test("BOM and missing final newline survive edits at either end", () => {
        const bom = parseDoc(load("edge-bom.md").source);
        const first = bom.units[0]!;
        const result = spliceEdit(bom, {
            start: first.start,
            before: bom.source.slice(first.start, first.end),
            after: "---\ntitle: New\n---",
        });
        expect(result.status === "changed" && result.source.startsWith("﻿---\ntitle: New")).toBe(
            true,
        );

        const nonl = parseDoc(load("edge-nonl.md").source);
        const last = nonl.units.at(-1)!;
        const edited = spliceEdit(nonl, {
            start: last.start,
            before: nonl.source.slice(last.start, last.end),
            after: "[ref]: https://example.org",
        });
        expect(edited.status === "changed" && edited.source.endsWith("https://example.org")).toBe(
            true,
        );
    });

    test("new lines take the doc's line ending; an LF round trip of CRLF text is unchanged", () => {
        const doc = parseDoc(load("edge-crlf.md").source);
        const paragraph = doc.units.find((unit) => unit.kind === "paragraph")!;
        const text = doc.source.slice(paragraph.start, paragraph.end);
        expect(text).toContain("\r\n");
        expect(
            spliceEdit(doc, {
                start: paragraph.start,
                before: text,
                after: text.replaceAll("\r\n", "\n"),
            }).status,
        ).toBe("unchanged");
        const result = spliceEdit(doc, { start: paragraph.start, before: text, after: "a\nb" });
        expect(result).toMatchObject({ status: "changed", edit: { after: "a\r\nb" } });
    });

    test("refuses when `before` is not at `start`", () => {
        const doc = parseDoc(load("edge.md").source);
        const unit = doc.units[1]!;
        expect(spliceEdit(doc, { start: unit.start + 1, before: "# Edge", after: "x" })).toEqual({
            status: "conflict",
        });
        expect(spliceEdit(doc, { start: doc.source.length, before: "x", after: "" })).toEqual({
            status: "conflict",
        });
    });

    test("cell edits are encoded and keep the table's shape", () => {
        const doc = parseDoc(load("edge.md").source);
        const table = doc.units.find((unit) => unit.kind === "table")!;
        const empty = table.children[7]!;
        const result = spliceEdit(doc, { start: empty.start, before: "", after: "a|b\nc" });
        if (result.status !== "changed") throw new Error("expected a change");
        expect(result.edit.after).toBe("a\\|b<br>c");
        const reparsed = parseDoc(result.source).units.find((unit) => unit.kind === "table")!;
        expect(reparsed.children).toHaveLength(9);
        const cell = reparsed.children[7]!;
        expect(result.source.slice(cell.start, cell.end)).toBe("a\\|b<br>c");
    });
});

describe("encodeCellText", () => {
    test("escapes bare pipes only and turns newlines into <br>", () => {
        expect(encodeCellText("a|b")).toBe("a\\|b");
        expect(encodeCellText("a\\|b")).toBe("a\\|b");
        expect(encodeCellText("a\\\\|b")).toBe("a\\\\\\|b");
        expect(encodeCellText("one\r\ntwo\nthree")).toBe("one<br>two<br>three");
        expect(encodeCellText(encodeCellText("x|y"))).toBe("x\\|y");
    });
});

describe("sourceEdit", () => {
    const apply = (source: string, edit: { start: number; before: string; after: string }) =>
        source.slice(0, edit.start) + edit.after + source.slice(edit.start + edit.before.length);

    test("returns null for equal sources", () => {
        expect(sourceEdit("same", "same")).toBeNull();
    });

    test("returns the minimal single splice", () => {
        expect(sourceEdit("the quick fox", "the slow fox")).toEqual({
            start: 4,
            before: "quick",
            after: "slow",
        });
        expect(sourceEdit("aaa", "aaaa")).toEqual({ start: 3, before: "", after: "a" });
        expect(sourceEdit("abc", "")).toEqual({ start: 0, before: "abc", after: "" });
    });

    test("never splits a surrogate pair", () => {
        const edit = sourceEdit("x\u{1F600}y", "x\u{1F601}y")!;
        expect(edit).toEqual({ start: 1, before: "\u{1F600}", after: "\u{1F601}" });
        // Same low surrogate, different high surrogate: the shared suffix must not start mid-pair.
        expect(sourceEdit("\u{1F600}b", "\u{2F600}b")).toEqual({
            start: 0,
            before: "\u{1F600}",
            after: "\u{2F600}",
        });
    });

    test("round trips edits across the edge fixtures", () => {
        const base = load("edge-crlf.md").source;
        const changed = base.replace("third level", "3rd level").replace("six", "seven");
        const edit = sourceEdit(base, changed)!;
        expect(apply(base, edit)).toBe(changed);
    });
});
