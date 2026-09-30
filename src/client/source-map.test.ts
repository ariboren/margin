import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Nodes } from "mdast";
import { decodeSource, docTree, parseDoc } from "../core/blocks.ts";
import { valueSpan } from "./source-map.ts";

describe("valueSpan", () => {
    test("plain text maps one to one", () => {
        const source = "Hello world";
        expect(valueSpan(source, "Hello world", 0, 11)).toEqual({ start: 0, end: 11, exact: true });
    });

    test("inline code maps to the text between the backticks", () => {
        const source = "a `code` b";
        expect(valueSpan(source, "code", 2, 8)).toEqual({ start: 3, end: 7, exact: true });
    });

    test("escaped text is inexact and keeps the node's range", () => {
        const source = "a \\* b";
        expect(valueSpan(source, "a * b", 0, 6)).toEqual({ start: 0, end: 6, exact: false });
    });
});

const fixtures = ["edge.md", "edge-bom.md", "edge-crlf.md", "public-sample.md", "private/sample.md"]
    .map((name) => join(import.meta.dir, "../../fixtures", name))
    .filter((path) => existsSync(path));

describe("rendered text maps back into source", () => {
    for (const path of fixtures) {
        test(path.split("/fixtures/")[1]!, () => {
            const source = decodeSource(readFileSync(path));
            const { tree, shift } = docTree(parseDoc(source));
            let total = 0;
            let exact = 0;
            const visit = (node: Nodes) => {
                if (node.type === "text" || node.type === "inlineCode") {
                    total++;
                    const span = valueSpan(
                        source,
                        node.value,
                        node.position!.start.offset! + shift,
                        node.position!.end.offset! + shift,
                    );
                    if (span.exact) {
                        exact++;
                        expect(source.slice(span.start, span.end)).toBe(node.value);
                    }
                }
                if ("children" in node) {
                    node.children.forEach(visit);
                }
            };
            visit(tree);
            expect(total).toBeGreaterThan(0);
            // Only escapes, entities and soft breaks in CRLF text may fall back to edge snapping.
            expect(exact / total).toBeGreaterThan(0.9);
        });
    }
});
