// Capped context for a thread in `pending`: a whole table or a long paragraph would cost thousands
// of tokens per thread, so the quote and each side are capped and clipped to the enclosing unit.
import { lineAt } from "./blocks.ts";
import type { ParsedDoc, Range, Unit } from "./model.ts";

export const QUOTE_CAP = 600;
export const SIDE_CAP = 240;

const ELLIPSIS = "…";
/** How far back a cut may move to land on whitespace before it keeps the hard cut. */
const SNAP_WINDOW = 40;

export interface ThreadContext {
    /** Heading path joined with " > ", without the doc title. */
    path: string;
    /** 1-based line of the quote's start. */
    line: number;
    quote: string;
    before: string;
    after: string;
    /** Set for a table cell below the header row. */
    cell?: { header: string; row: string };
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
    return encoder.encode(text).length;
}

/** Length in UTF-16 units of the longest prefix within `maxBytes` UTF-8 bytes, whole code points only. */
function prefixFitting(text: string, maxBytes: number): number {
    let bytes = 0;
    let index = 0;
    for (const char of text) {
        const size = byteLength(char);
        if (bytes + size > maxBytes) break;
        bytes += size;
        index += char.length;
    }
    return index;
}

function suffixFitting(text: string, maxBytes: number): number {
    const chars = Array.from(text);
    let bytes = 0;
    let index = text.length;
    for (let i = chars.length - 1; i >= 0; i--) {
        const size = byteLength(chars[i]!);
        if (bytes + size > maxBytes) break;
        bytes += size;
        index -= chars[i]!.length;
    }
    return index;
}

/** The start of `text` within `maxBytes`, cut at whitespace when one is near, `…` appended when cut. */
export function clipHead(text: string, maxBytes: number): string {
    if (byteLength(text) <= maxBytes) return text;
    let end = prefixFitting(text, maxBytes - byteLength(ELLIPSIS));
    const space = text.slice(0, end + 1).search(/\s\S*$/);
    if (space > 0 && end - space <= SNAP_WINDOW) end = space;
    return text.slice(0, end).trimEnd() + ELLIPSIS;
}

/** The end of `text` within `maxBytes`, cut at whitespace when one is near, `…` prepended when cut. */
export function clipTail(text: string, maxBytes: number): string {
    if (byteLength(text) <= maxBytes) return text;
    let start = suffixFitting(text, maxBytes - byteLength(ELLIPSIS));
    const space = text.slice(start - 1).search(/\s/);
    if (space >= 0 && space <= SNAP_WINDOW) start += space;
    return ELLIPSIS + text.slice(start).trimStart();
}

/** A quote over the cap keeps its head and tail, so the agent still sees where it starts and ends. */
export function clipQuote(text: string, maxBytes = QUOTE_CAP): string {
    if (byteLength(text) <= maxBytes) return text;
    const half = Math.floor((maxBytes - byteLength(ELLIPSIS)) / 2);
    const head = text.slice(0, prefixFitting(text, half));
    const tail = text.slice(suffixFitting(text, half));
    return head + ELLIPSIS + tail;
}

/** The chain of units from the root to the smallest one containing `range.start`. */
export function unitChain(units: Unit[], range: Range): Unit[] {
    const chain: Unit[] = [];
    let level = units;
    for (;;) {
        const unit = level.find((candidate) => {
            if (candidate.start === candidate.end) return candidate.start === range.start;
            return candidate.start <= range.start && range.start < candidate.end;
        });
        if (!unit) return chain;
        chain.push(unit);
        level = unit.children;
    }
}

function cellText(source: string, unit: Unit | undefined): string {
    return unit ? clipHead(source.slice(unit.start, unit.end), SIDE_CAP) : "";
}

function tableCell(source: string, chain: Unit[]): ThreadContext["cell"] {
    const cell = chain[chain.length - 1];
    const table = chain.findLast((unit) => unit.kind === "table");
    if (!cell?.cell || !table || cell.cell.row === 0) return undefined;
    const cells = (units: Unit[]): Unit[] =>
        units.flatMap((unit) => (unit.kind === "tableCell" ? [unit] : cells(unit.children)));
    const all = cells(table.children);
    const { row, column } = cell.cell;
    return {
        header: cellText(
            source,
            all.find((u) => u.cell?.row === 0 && u.cell.column === column),
        ),
        row: cellText(
            source,
            all.find((u) => u.cell?.row === row && u.cell.column === 0),
        ),
    };
}

/**
 * The heading every unit sits under, when there is one (a single top-level title). It repeats in
 * every path and tells the agent nothing, so agent-facing paths leave it out.
 */
export function docTitle(doc: ParsedDoc): string | undefined {
    const paths = doc.units.map((unit) => unit.headingPath).filter((path) => path.length > 0);
    const title = paths[0]?.[0];
    if (title === undefined || !paths.every((path) => path[0] === title)) return undefined;
    return paths.some((path) => path.length > 1) ? title : undefined;
}

/**
 * Agent-facing heading path: " > " joined, without the doc title. Whitespace runs collapse to
 * one space: a setext heading can span lines, and every rendering of the path is one line.
 */
export function formatPath(headingPath: string[], title?: string): string {
    const path =
        title !== undefined && headingPath[0] === title ? headingPath.slice(1) : headingPath;
    return path.map((heading) => heading.replace(/\s+/g, " ").trim()).join(" > ");
}

/**
 * Context for a thread whose quote sits at `range`: the quote up to `QUOTE_CAP` bytes, then up
 * to `SIDE_CAP` bytes each side, never crossing the smallest enclosing unit. A table cell also
 * carries its column header and its row's first cell.
 */
export function threadContext(doc: ParsedDoc, range: Range): ThreadContext {
    const { source } = doc;
    const chain = unitChain(doc.units, range);
    const unit = chain[chain.length - 1];
    const bounds = unit ?? { start: 0, end: source.length, headingPath: [] };
    const end = Math.min(range.end, bounds.end);
    const context: ThreadContext = {
        path: formatPath(bounds.headingPath, docTitle(doc)),
        line: lineAt(source, range.start),
        quote: clipQuote(source.slice(range.start, end)),
        before: clipTail(source.slice(bounds.start, range.start), SIDE_CAP),
        after: clipHead(source.slice(end, bounds.end), SIDE_CAP),
    };
    const cell = tableCell(source, chain);
    if (cell) context.cell = cell;
    return context;
}
