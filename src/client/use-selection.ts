import type { RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";
import { clampRange, snapRange } from "../core/anchor.ts";
import type { ParsedDoc, Range } from "../core/model.ts";
import { domRangeToSource } from "./source-map.ts";

export interface SourceSelection {
    range: Range;
    /** Viewport rect of the selection's first line, for placing the toolbar. */
    rect: { top: number; left: number; width: number; bottom: number };
}

/** The current DOM selection inside `root`, mapped to a source range snapped and clamped to one unit. */
export function useSourceSelection(
    root: RefObject<HTMLElement | null>,
    doc: ParsedDoc,
): SourceSelection | null {
    const [selection, setSelection] = useState<SourceSelection | null>(null);
    useEffect(() => {
        let frame = 0;
        const read = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => setSelection(readSelection(root.current, doc)));
        };
        document.addEventListener("selectionchange", read);
        window.addEventListener("scroll", read, { passive: true });
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener("selectionchange", read);
            window.removeEventListener("scroll", read);
        };
    }, [root, doc]);
    return selection;
}

function readSelection(root: HTMLElement | null, doc: ParsedDoc): SourceSelection | null {
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }
    const domRange = selection.getRangeAt(0);
    if (!root.contains(domRange.startContainer) || !root.contains(domRange.endContainer)) {
        return null;
    }
    if ((domRange.commonAncestorContainer as Element).closest?.(".unit-editor")) {
        return null;
    }
    const mapped = domRangeToSource(root, domRange);
    const clamped = mapped ? clampRange(doc, snapRange(doc, mapped)) : null;
    if (!clamped || clamped.end <= clamped.start) {
        return null;
    }
    const first = domRange.getClientRects()[0] ?? domRange.getBoundingClientRect();
    return {
        range: clamped,
        rect: { top: first.top, left: first.left, width: first.width, bottom: first.bottom },
    };
}
