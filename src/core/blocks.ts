import type { Nodes, Parents, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import type { ParsedDoc, Range, SourceSplice, Unit, UnitKind } from "./model.ts";

const BOM = "﻿";

export type SpliceResult =
    | { status: "changed"; source: string; edit: SourceSplice }
    | { status: "unchanged" }
    | { status: "conflict" };

/** Fatal on invalid UTF-8 (a lossy decode could not round-trip); keeps the BOM so offsets cover every byte. */
export function decodeSource(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function hashText(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

interface ParsedTree {
    tree: Root;
    /** Added to every mdast offset to get a source offset (1 when a BOM leads). */
    shift: number;
}

const trees = new WeakMap<ParsedDoc, ParsedTree>();

function parseTree(source: string): ParsedTree {
    // micromark drops a leading BOM and reports offsets without it.
    const shift = source.startsWith(BOM) ? BOM.length : 0;
    const tree = fromMarkdown(source.slice(shift), {
        extensions: [gfm(), frontmatter(["yaml", "toml"])],
        mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml", "toml"])],
    });
    return { tree, shift };
}

/** The mdast tree behind a parsed doc, reparsed when the doc did not come from `parseDoc`. */
export function docTree(doc: ParsedDoc): ParsedTree {
    let parsed = trees.get(doc);
    if (!parsed) {
        parsed = parseTree(doc.source);
        trees.set(doc, parsed);
    }
    return parsed;
}

/** Containers whose descendants can be units without being units themselves. */
const passThrough = new Set(["list", "table", "tableRow", "blockquote"]);

function hasChildren(node: Nodes): node is Parents {
    return "children" in node && node.children.length > 0;
}

/**
 * mdast lets a container run past its last child (a list inside a blockquote swallows the
 * following `>` markers), so containers end where their last child ends.
 */
function nodeEnd(node: Nodes): number {
    if ((passThrough.has(node.type) || node.type === "listItem") && hasChildren(node)) {
        const last = node.children[node.children.length - 1]!;
        if (last.position) {
            return Math.min(node.position!.end.offset!, nodeEnd(last));
        }
    }
    return node.position!.end.offset!;
}

function cellRange(source: string, node: Nodes, shift: number): Range {
    if (hasChildren(node)) {
        const first = node.children[0]!;
        const last = node.children[node.children.length - 1]!;
        return { start: first.position!.start.offset! + shift, end: nodeEnd(last) + shift };
    }
    // Empty cell: a zero-width unit just inside the pipe and one space of padding.
    let at = node.position!.start.offset! + shift;
    const end = node.position!.end.offset! + shift;
    if (source[at] === "|") at++;
    if (at < end && source[at] === " ") at++;
    return { start: at, end: at };
}

interface BuildContext {
    source: string;
    shift: number;
    headingPath: string[];
}

function buildUnit(node: Nodes, context: BuildContext, cell?: Unit["cell"]): Unit {
    const { source, shift } = context;
    const range =
        node.type === "tableCell"
            ? cellRange(source, node, shift)
            : { start: node.position!.start.offset! + shift, end: nodeEnd(node) + shift };
    const unit: Unit = {
        kind: node.type as UnitKind,
        start: range.start,
        end: range.end,
        line: node.position!.start.line,
        headingPath: context.headingPath,
        hash: hashText(source.slice(range.start, range.end)),
        children: node.type === "tableCell" ? [] : childUnits(node, context),
    };
    if (cell) unit.cell = cell;
    return unit;
}

/** Smallest enclosing wins: list items, table cells and blockquote children nest inside their unit. */
function childUnits(node: Nodes, context: BuildContext): Unit[] {
    if (!(passThrough.has(node.type) || node.type === "listItem") || !hasChildren(node)) {
        return [];
    }
    const units: Unit[] = [];
    if (node.type === "table") {
        node.children.forEach((row, rowIndex) => {
            row.children.forEach((cellNode, column) => {
                if (cellNode.position) {
                    units.push(buildUnit(cellNode, context, { row: rowIndex, column }));
                }
            });
        });
        return units;
    }
    for (const child of node.children) {
        if (!child.position) continue;
        if (child.type === "listItem" || node.type === "blockquote") {
            units.push(buildUnit(child, context));
        } else if (passThrough.has(child.type)) {
            units.push(...childUnits(child, context));
        }
    }
    return units;
}

export function parseDoc(source: string): ParsedDoc {
    const parsed = parseTree(source);
    const units: Unit[] = [];
    const headings: { depth: number; text: string }[] = [];
    for (const node of parsed.tree.children) {
        if (!node.position) continue;
        if (node.type === "heading") {
            while (headings.length > 0 && headings[headings.length - 1]!.depth >= node.depth) {
                headings.pop();
            }
            headings.push({ depth: node.depth, text: toString(node) });
        }
        const headingPath = headings.map((heading) => heading.text);
        units.push(buildUnit(node, { source, shift: parsed.shift, headingPath }));
    }

    const crlf = source.match(/\r\n/g)?.length ?? 0;
    const lf = source.match(/\n/g)?.length ?? 0;
    const doc: ParsedDoc = {
        source,
        units,
        bom: parsed.shift > 0,
        eol: crlf > lf - crlf ? "\r\n" : "\n",
        finalNewline: source.endsWith("\n"),
    };
    trees.set(doc, parsed);
    return doc;
}

/** Every unit, parents before their children, in source order. */
export function flattenUnits(units: Unit[]): Unit[] {
    const out: Unit[] = [];
    const visit = (list: Unit[]) => {
        for (const unit of list) {
            out.push(unit);
            visit(unit.children);
        }
    };
    visit(units);
    return out;
}

/** The smallest unit whose range contains `range` (a zero-width cell contains its own offset). */
export function unitAt(units: Unit[], range: Range): Unit | undefined {
    for (const unit of units) {
        if (unit.start <= range.start && range.end <= unit.end) {
            return unitAt(unit.children, range) ?? unit;
        }
    }
    return undefined;
}

/** Makes text safe inside one GFM table cell: unescaped pipes escaped, newlines as `<br>`. */
export function encodeCellText(text: string): string {
    return text
        .replace(/(\\*)\|/g, (match, slashes: string) =>
            slashes.length % 2 === 1 ? match : `${slashes}\\|`,
        )
        .replace(/\r?\n/g, "<br>");
}

/**
 * Compare-and-swap splice: replaces `before` at `start` and leaves every other byte alone.
 * `after` gets the doc's line ending, or cell encoding when the range sits in a table cell.
 */
export function spliceEdit(doc: ParsedDoc, edit: SourceSplice): SpliceResult {
    const { source } = doc;
    const end = edit.start + edit.before.length;
    if (edit.start < 0 || end > source.length || source.slice(edit.start, end) !== edit.before) {
        return { status: "conflict" };
    }
    const target = unitAt(doc.units, { start: edit.start, end });
    const encode =
        target?.kind === "tableCell"
            ? encodeCellText
            : (text: string) => text.replace(/\r?\n/g, doc.eol);
    const after = encode(edit.after);
    // An editor round trip normalizes line endings; that alone is not a change.
    if (edit.after === edit.before || after === encode(edit.before)) {
        return { status: "unchanged" };
    }
    return {
        status: "changed",
        source: source.slice(0, edit.start) + after + source.slice(end),
        edit: { start: edit.start, before: edit.before, after },
    };
}

/** 1-based line number of a source offset. */
export function lineAt(source: string, offset: number): number {
    let line = 1;
    for (let i = source.indexOf("\n"); i !== -1 && i < offset; i = source.indexOf("\n", i + 1)) {
        line++;
    }
    return line;
}

function isLowSurrogate(code: number): boolean {
    return code >= 0xdc00 && code <= 0xdfff;
}

/** The single minimal splice turning `oldSource` into `newSource`, or null when they are equal. */
export function sourceEdit(oldSource: string, newSource: string): SourceSplice | null {
    if (oldSource === newSource) return null;
    const limit = Math.min(oldSource.length, newSource.length);
    let head = 0;
    while (head < limit && oldSource.charCodeAt(head) === newSource.charCodeAt(head)) head++;
    // Never split a surrogate pair.
    if (head > 0 && isLowSurrogate(oldSource.charCodeAt(head))) head--;
    let tail = 0;
    while (
        tail < limit - head &&
        oldSource.charCodeAt(oldSource.length - 1 - tail) ===
            newSource.charCodeAt(newSource.length - 1 - tail)
    ) {
        tail++;
    }
    if (tail > 0 && isLowSurrogate(oldSource.charCodeAt(oldSource.length - tail))) tail--;
    return {
        start: head,
        before: oldSource.slice(head, oldSource.length - tail),
        after: newSource.slice(head, newSource.length - tail),
    };
}
