import type { HunkPiece, HunkPieces } from "../core/diff.ts";

/** How much of an edit's diff the card shows before "Show all". */
const SHOWN_HUNKS = 3;
const SHOWN_CHARS = 320;

export interface ClippedDiff {
    shown: HunkPieces[];
    /** Something was left out: more hunks, or the tail of a long one. */
    clipped: boolean;
}

/**
 * The first `hunks` hunks, within `chars` characters of text in all; a hunk cut mid-way keeps
 * its pieces up to the budget and is marked as cut after. The whole diff when `all` is set.
 */
export function clipDiff(
    diff: HunkPieces[],
    all: boolean,
    limits = { hunks: SHOWN_HUNKS, chars: SHOWN_CHARS },
): ClippedDiff {
    if (all) {
        return { shown: diff, clipped: false };
    }
    const shown: HunkPieces[] = [];
    let budget = limits.chars;
    for (const hunk of diff.slice(0, limits.hunks)) {
        const pieces: HunkPiece[] = [];
        let cut = false;
        for (const piece of hunk.pieces) {
            if (budget <= 0) {
                cut = true;
                break;
            }
            if (piece.text.length > budget) {
                pieces.push({ kind: piece.kind, text: piece.text.slice(0, budget) });
                cut = true;
                budget = 0;
                break;
            }
            pieces.push(piece);
            budget -= piece.text.length;
        }
        if (pieces.length > 0) {
            shown.push({ pieces, cutBefore: hunk.cutBefore, cutAfter: cut || hunk.cutAfter });
        }
        if (cut) {
            return { shown, clipped: true };
        }
    }
    return { shown, clipped: shown.length < diff.length };
}

/** Markdown source on one line: line breaks shown as ↵ so a paragraph split stays visible. */
export function visibleText(text: string): string {
    return text.replace(/\r?\n/g, "↵");
}
