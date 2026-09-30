// User-edit feed for `pending`: word-diff hunks instead of a unified diff, because sample paragraphs
// are single long lines and a unified hunk would repeat the whole paragraph twice.
import { diffWordsWithSpace } from "diff";
import { byteLength, formatPath } from "./context.ts";
import type { PendingEdit } from "./model.ts";

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

function render(piece: Piece): string {
    const text = escapeLines(piece.text);
    if (piece.kind === "del") return `[-${text}-]`;
    if (piece.kind === "ins") return `{+${text}+}`;
    return text;
}

/**
 * Word-level hunks between two versions of a unit: each run of changes with up to `context`
 * words either side, `…` where the text was cut. Changes whose context would overlap share a hunk.
 */
export function wordHunks(before: string, after: string, context = CONTEXT_WORDS): Hunk[] {
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
        let text = list.slice(0, start).some(isWord) ? "…" : "";
        let changedBytes = 0;
        for (let i = start; i < end; i++) {
            const piece = list[i]!;
            if (piece.kind !== "same") changedBytes += byteLength(piece.text);
            text += render(piece);
        }
        if (list.slice(end).some(isWord)) text += "…";
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
