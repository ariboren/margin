// DOM point <-> source offset. Every rendered text span carries its source range (`data-s`, `data-e`);
// `data-x` marks spans whose text is not a verbatim copy of the source (escapes, entities, dedented
// code), where a point can only map to one of the span's edges.
import type { Offset, Range } from "../core/model.ts";

export interface SourceSpan {
    start: Offset;
    end: Offset;
    /** `value` equals `source.slice(start, end)`, so offsets inside it map one to one. */
    exact: boolean;
}

/** Where a node's rendered `value` sits in the source, given the node's own range. */
export function valueSpan(
    source: string,
    value: string,
    nodeStart: Offset,
    nodeEnd: Offset,
): SourceSpan {
    if (source.slice(nodeStart, nodeEnd) === value) {
        return { start: nodeStart, end: nodeEnd, exact: true };
    }
    if (value.length > 0) {
        const at = source.indexOf(value, nodeStart);
        if (at >= 0 && at + value.length <= nodeEnd) {
            return { start: at, end: at + value.length, exact: true };
        }
    }
    return { start: nodeStart, end: nodeEnd, exact: false };
}

interface SpanAttributes {
    "data-s": number;
    "data-e": number;
    "data-x"?: "";
}

export function spanAttributes(span: SourceSpan): SpanAttributes {
    return span.exact
        ? { "data-s": span.start, "data-e": span.end }
        : { "data-s": span.start, "data-e": span.end, "data-x": "" };
}

type Bias = "start" | "end";

function readSpan(element: Element): SourceSpan {
    return {
        start: Number(element.getAttribute("data-s")),
        end: Number(element.getAttribute("data-e")),
        exact: !element.hasAttribute("data-x"),
    };
}

/**
 * Map a DOM boundary point to a source offset. Points inside a span map exactly (or to the nearer
 * edge of an inexact span); points between spans map to the next span's start (`bias: "start"`) or
 * the previous span's end (`bias: "end"`).
 */
function domPointToOffset(root: Element, node: Node, offset: number, bias: Bias): Offset | null {
    if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (parent?.hasAttribute("data-s") && root.contains(parent)) {
            const span = readSpan(parent);
            if (span.exact) {
                return Math.min(span.start + offset, span.end);
            }
            return offset * 2 <= (node.textContent?.length ?? 0) ? span.start : span.end;
        }
    }
    const spans = root.querySelectorAll("[data-s]");
    const point = document.createRange();
    point.setStart(node, offset);
    if (bias === "start") {
        for (const element of spans) {
            if (point.comparePoint(element, 0) >= 0) {
                return readSpan(element).start;
            }
        }
        return null;
    }
    let found: Offset | null = null;
    for (const element of spans) {
        if (point.comparePoint(element, element.childNodes.length) > 0) {
            break;
        }
        found = readSpan(element).end;
    }
    return found;
}

export function domRangeToSource(root: Element, range: globalThis.Range): Range | null {
    const start = domPointToOffset(root, range.startContainer, range.startOffset, "start");
    const end = domPointToOffset(root, range.endContainer, range.endOffset, "end");
    if (start === null || end === null || end <= start) {
        return null;
    }
    return { start, end };
}
