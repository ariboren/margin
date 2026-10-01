// User-edit feed for `pending`: word-diff hunks instead of a unified diff, because sample paragraphs
// are single long lines and a unified hunk would repeat the whole paragraph twice.
import { diffWordsWithSpace } from "diff";
import { byteLength, formatPath } from "./context.ts";
import type { EditEvent, PendingEdit } from "./model.ts";

export { byteLength };

export const CONTEXT_WORDS = 4;

export interface Hunk {
    /** Context and changes, git word-diff style: `…a b [-old-]{+new+} c d…`. */
    text: string;
    /** UTF-8 bytes of the removed and added text inside this hunk. */
    changedBytes: number;
}

type Piece =
    | { kind: "same"; text: string; word: boolean }
    | { kind: "del"; text: string }
    | { kind: "ins"; text: string };

/** Hunks are one line each, and the agent needs no carriage returns. */
function escapeLines(text: string): string {
    return text.replace(/\r?\n/g, "\\n");
}

function tokens(before: string, after: string): Piece[] {
    const out: Piece[] = [];
    for (const change of diffWordsWithSpace(before, after)) {
        if (change.added || change.removed) {
            out.push({ kind: change.added ? "ins" : "del", text: change.value });
            continue;
        }
        for (const token of change.value.split(/(\s+)/)) {
            if (token !== "") out.push({ kind: "same", text: token, word: /\S/.test(token) });
        }
    }
    return out;
}

/** Folds changes split only by whitespace into one removal and one insertion: `[-a b-]{+c d+}`. */
function pieces(before: string, after: string): Piece[] {
    const list = tokens(before, after);
    const out: Piece[] = [];
    for (let i = 0; i < list.length; i++) {
        if (list[i]!.kind === "same") {
            out.push(list[i]!);
            continue;
        }
        let del = "";
        let ins = "";
        let j = i;
        for (; j < list.length; j++) {
            const piece = list[j]!;
            if (piece.kind === "del") del += piece.text;
            else if (piece.kind === "ins") ins += piece.text;
            else if (!piece.word && list[j + 1] && list[j + 1]!.kind !== "same") {
                del += piece.text;
                ins += piece.text;
            } else break;
        }
        if (del) out.push({ kind: "del", text: del });
        if (ins) out.push({ kind: "ins", text: ins });
        i = j - 1;
    }
    return out;
}

function isWord(piece: Piece | undefined): boolean {
    return piece?.kind === "same" && piece.word;
}

/** Index of the first piece of `words` words of context before `from`. */
function contextStart(list: Piece[], from: number, words: number): number {
    let count = 0;
    for (let i = from - 1; i >= 0; i--) {
        if (list[i]!.kind !== "same") return i + 1;
        if (isWord(list[i]) && ++count === words) return i;
    }
    return 0;
}

/** Index one past the last piece of `words` words of context after `from`. */
function contextEnd(list: Piece[], from: number, words: number): number {
    let count = 0;
    for (let i = from + 1; i < list.length; i++) {
        if (list[i]!.kind !== "same") return i;
        if (isWord(list[i]) && ++count === words) return i + 1;
    }
    return list.length;
}

function wordsBetween(list: Piece[], from: number, to: number): number {
    let count = 0;
    for (let i = from + 1; i < to; i++) if (isWord(list[i])) count++;
    return count;
}

function render(piece: HunkPiece): string {
    const text = escapeLines(piece.text);
    if (piece.kind === "del") return `[-${text}-]`;
    if (piece.kind === "ins") return `{+${text}+}`;
    return text;
}

export interface HunkPiece {
    kind: "same" | "del" | "ins";
    text: string;
}

/** One hunk before rendering: its pieces in order, and whether text was cut on either side. */
export interface HunkPieces {
    pieces: HunkPiece[];
    cutBefore: boolean;
    cutAfter: boolean;
}

/**
 * Word-level hunks between two versions of a unit, as pieces: each run of changes with up to
 * `context` words either side. Changes whose context would overlap share a hunk.
 */
export function hunkPieces(before: string, after: string, context = CONTEXT_WORDS): HunkPieces[] {
    const list = pieces(before, after);
    const changed = list.flatMap((piece, i) => (piece.kind === "same" ? [] : [i]));
    const groups: { first: number; last: number }[] = [];
    for (const i of changed) {
        const group = groups[groups.length - 1];
        if (group && wordsBetween(list, group.last, i) <= 2 * context) {
            group.last = i;
        } else {
            groups.push({ first: i, last: i });
        }
    }
    return groups.map(({ first, last }) => {
        let start = contextStart(list, first, context);
        let end = contextEnd(list, last, context);
        while (start < first && !isWord(list[start])) start++;
        while (end > last + 1 && !isWord(list[end - 1])) end--;
        return {
            pieces: list.slice(start, end).map(({ kind, text }) => ({ kind, text })),
            cutBefore: list.slice(0, start).some(isWord),
            cutAfter: list.slice(end).some(isWord),
        };
    });
}

/** `hunkPieces` rendered one line each, git word-diff style, with `…` where the text was cut. */
export function wordHunks(before: string, after: string, context = CONTEXT_WORDS): Hunk[] {
    return hunkPieces(before, after, context).map((hunk) => {
        let text = hunk.cutBefore ? "…" : "";
        let changedBytes = 0;
        for (const piece of hunk.pieces) {
            if (piece.kind !== "same") changedBytes += byteLength(piece.text);
            text += render(piece);
        }
        if (hunk.cutAfter) text += "…";
        return { text, changedBytes };
    });
}

export interface EditInput {
    before: string;
    after: string;
    line: number;
    headingPath: string[];
    /** The doc title to leave out of the path (`docTitle`). */
    title?: string;
}

export function pendingEdit(edit: EditInput): PendingEdit {
    return {
        path: formatPath(edit.headingPath, edit.title),
        line: edit.line,
        hunks: wordHunks(edit.before, edit.after).map((hunk) => hunk.text),
    };
}

/** Plain-text rendering of one user edit in `pending`: a header line, then one line per hunk. */
export function formatEdit(edit: PendingEdit): string {
    return [`edit L${edit.line} ${edit.path}`, ...edit.hunks.map((hunk) => `  ${hunk}`)].join("\n");
}

/**
 * The edits worth showing after `cursor`: an undo cancels the edit it inverts and a redo the undo,
 * so of each chain only the last unread member shows, and only when the unread part has odd length
 * (its diff is then the net change since the cursor). Edits outside any chain show as they are.
 */
export function netEdits(edits: readonly EditEvent[], cursor = 0): EditEvent[] {
    const chainOf = new Map<number, number>();
    for (const edit of edits) {
        const root = edit.of === undefined ? undefined : chainOf.get(edit.of);
        chainOf.set(edit.seq, root ?? edit.of ?? edit.seq);
    }
    const unread = new Map<number, EditEvent[]>();
    for (const edit of edits) {
        if (edit.seq <= cursor) {
            continue;
        }
        const root = chainOf.get(edit.seq) ?? edit.seq;
        unread.set(root, [...(unread.get(root) ?? []), edit]);
    }
    const shown = new Set<EditEvent>();
    for (const chain of unread.values()) {
        if (chain.length % 2 === 1) {
            shown.add(chain[chain.length - 1]!);
        }
    }
    return edits.filter((edit) => shown.has(edit));
}
