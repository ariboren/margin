import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alignUnits, carryKeys } from "./align.ts";
import { decodeSource, flattenUnits, parseDoc } from "./blocks.ts";
import type { ParsedDoc, Unit } from "./model.ts";

const fixtures = join(import.meta.dir, "../../fixtures");
const privateSample = join(fixtures, "private/sample.md");

function load(name: string): string {
    return decodeSource(readFileSync(join(fixtures, name)));
}

const textOf = (doc: ParsedDoc, unit: Unit) => doc.source.slice(unit.start, unit.end);

function insertAt(source: string, offset: number, text: string): string {
    return source.slice(0, offset) + text + source.slice(offset);
}

/**
 * Every old unit is matched and `extra` new units are not. Leaf units keep their text; containers
 * of the insert change text but keep identity.
 */
function expectAllKept(prev: ParsedDoc, next: ParsedDoc, extra: number): void {
    const map = alignUnits(prev.units, next.units);
    const nextUnits = flattenUnits(next.units);
    const matched = nextUnits.filter((unit) => map.has(unit));
    expect(matched).toHaveLength(flattenUnits(prev.units).length);
    expect(nextUnits.length - matched.length).toBe(extra);
    for (const unit of matched.filter((candidate) => candidate.children.length === 0)) {
        expect(textOf(next, unit)).toBe(textOf(prev, map.get(unit)!));
    }
    expect(new Set(map.values()).size).toBe(map.size);
}

describe("alignUnits", () => {
    const source = load("edge.md");
    const prev = parseDoc(source);

    test("an insert keeps identity for every unchanged unit", () => {
        const at = source.indexOf("## Table");
        const next = parseDoc(insertAt(source, at, "An inserted paragraph.\n\n"));
        expectAllKept(prev, next, 1);
    });

    test("a nested list item insert keeps its siblings and parents", () => {
        const at = source.indexOf("    - back to second");
        const next = parseDoc(insertAt(source, at, "    - inserted item\n"));
        expectAllKept(prev, next, 1);
    });

    test("an edited unit keeps its identity between unchanged neighbours", () => {
        const next = parseDoc(source.replace("Final paragraph", "Last paragraph"));
        const map = alignUnits(prev.units, next.units);
        const edited = next.units.find((unit) => textOf(next, unit).startsWith("Last paragraph"))!;
        expect(textOf(prev, map.get(edited)!)).toStartWith("Final paragraph");
        expect(map.size).toBe(flattenUnits(next.units).length);
    });

    test("an edited cell keeps the table and every cell", () => {
        const next = parseDoc(source.replace("| three ", "| 3     "));
        const map = alignUnits(prev.units, next.units);
        const table = next.units.find((unit) => unit.kind === "table")!;
        const oldTable = map.get(table)!;
        expect(oldTable.kind).toBe("table");
        table.children.forEach((cell, index) => {
            expect(map.get(cell)).toBe(oldTable.children[index]!);
        });
    });

    test("a deletion leaves the rest matched", () => {
        const next = parseDoc(source.replace("<!-- an HTML comment -->\n\n", ""));
        const map = alignUnits(prev.units, next.units);
        expect(map.size).toBe(flattenUnits(next.units).length);
        for (const [after, before] of map) expect(textOf(next, after)).toBe(textOf(prev, before));
    });
});

describe("carryKeys", () => {
    test("keeps keys for aligned units and mints fresh ones for new units", () => {
        const source = load("edge.md");
        const prev = parseDoc(source);
        let counter = 0;
        const mint = () => `k${++counter}`;
        const prevKeys = carryKeys(new Map(), [], prev.units, mint);
        expect(prevKeys.size).toBe(flattenUnits(prev.units).length);

        const next = parseDoc(insertAt(source, source.indexOf("## Table"), "Inserted.\n\n"));
        const nextKeys = carryKeys(prevKeys, prev.units, next.units, mint);
        const carried = [...nextKeys.values()].filter((key) =>
            [...prevKeys.values()].includes(key),
        );
        expect(carried).toHaveLength(prevKeys.size);
        expect(new Set(nextKeys.values()).size).toBe(nextKeys.size);
    });
});

describe.skipIf(!existsSync(privateSample))("private sample", () => {
    test("an insert mid-document keeps identity for every other unit", () => {
        const source = load("private/sample.md");
        const prev = parseDoc(source);
        const middle = prev.units[Math.floor(prev.units.length / 2)]!;
        const next = parseDoc(insertAt(source, middle.start, "Inserted paragraph.\n\n"));
        expectAllKept(prev, next, 1);
    });
});
