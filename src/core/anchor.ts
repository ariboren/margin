import type { Nodes } from "mdast";
import { docTree, flattenUnits } from "./blocks.ts";
import type { Anchor, ParsedDoc, Range, SourceSplice, Unit } from "./model.ts";

/** Characters of context kept on each side of `exact`. */
export const ANCHOR_CONTEXT = 32;

export function createAnchor(source: string, range: Range): Anchor {
    if (range.start < 0 || range.end > source.length || range.end <= range.start) {
        throw new RangeError(`Cannot anchor [${range.start}, ${range.end})`);
    }
    return {
        exact: source.slice(range.start, range.end),
        prefix: source.slice(Math.max(0, range.start - ANCHOR_CONTEXT), range.start),
        suffix: source.slice(range.end, range.end + ANCHOR_CONTEXT),
        hint: range.start,
    };
}

function contextScore(source: string, at: number, anchor: Anchor): number {
    let score = 0;
    const { prefix, suffix } = anchor;
    while (score < prefix.length && source[at - 1 - score] === prefix[prefix.length - 1 - score]) {
        score++;
    }
    const end = at + anchor.exact.length;
    let after = 0;
    while (after < suffix.length && source[end + after] === suffix[after]) after++;
    return score + after;
}

/**
 * Finds `exact` in `source`: the copy whose prefix and suffix match best, then the one nearest
 * the hint. Null (detached) only when `exact` does not occur at all; stateless, so an anchor
 * re-attaches as soon as its text returns.
 */
export function resolveAnchor(source: string, anchor: Anchor): Range | null {
    const { exact, hint } = anchor;
    if (exact.length === 0) return null;
    let best = -1;
    let bestScore = -1;
    let bestDistance = Infinity;
    for (let at = source.indexOf(exact); at !== -1; at = source.indexOf(exact, at + 1)) {
        const score = contextScore(source, at, anchor);
        const distance = Math.abs(at - hint);
        if (score > bestScore || (score === bestScore && distance < bestDistance)) {
            best = at;
            bestScore = score;
            bestDistance = distance;
        }
    }
    return best === -1 ? null : { start: best, end: best + exact.length };
}

const wordChar = /[\p{L}\p{N}_]/u;

function isWord(char: string | undefined): boolean {
    return char !== undefined && wordChar.test(char);
}

/** Whatever part of the splice's `before` falls in the anchor's window agrees with the window. */
function agreesWithWindow(anchor: Anchor, edit: SourceSplice): boolean {
    const w0 = anchor.hint - anchor.prefix.length;
    const window = anchor.prefix + anchor.exact + anchor.suffix;
    const s = edit.start;
    const lo = Math.max(s, w0);
    const hi = Math.min(s + edit.before.length, w0 + window.length);
    return lo >= hi || edit.before.slice(lo - s, hi - s) === window.slice(lo - w0, hi - w0);
}

/**
 * Re-pins the hint on a copy of `exact` inside the splice's `before`, which is text the source
 * really held at `start`. Any context that also falls inside `before` must agree; the copy
 * nearest the old hint wins. Null when `before` holds no such copy.
 */
function pinToSplice(anchor: Anchor, edit: SourceSplice): Anchor | null {
    const { exact, prefix, suffix } = anchor;
    const { before } = edit;
    let best: number | null = null;
    for (let at = before.indexOf(exact); at !== -1; at = before.indexOf(exact, at + 1)) {
        const head = Math.min(prefix.length, at);
        const tailFrom = at + exact.length;
        const tail = Math.min(suffix.length, before.length - tailFrom);
        if (
            before.slice(at - head, at) !== prefix.slice(prefix.length - head) ||
            before.slice(tailFrom, tailFrom + tail) !== suffix.slice(0, tail)
        ) {
            continue;
        }
        const hint = edit.start + at;
        if (best === null || Math.abs(hint - anchor.hint) < Math.abs(best - anchor.hint)) {
            best = hint;
        }
    }
    return best === null ? null : { ...anchor, hint: best };
}

export interface RebaseOptions {
    /**
     * The splice was made on this anchor's own thread (suggest, accept, revert), so a copy of
     * `exact` inside `before` is the quote itself even when the hint has gone stale.
     */
    own?: boolean;
}

/**
 * Moves an anchor through a known splice. Edits inside the quote rewrite `exact`; a partial
 * overlap keeps the untouched part plus the replacement, widened to whole words; replacing
 * exactly the quote moves the anchor onto the new text. Returns null when the quote is gone:
 * the caller keeps the old anchor and `resolveAnchor` decides.
 *
 * `hint` is only trusted where the splice can confirm it. An unlogged change (an editor save
 * with no daemon) leaves it stale; when `before` disagrees with the anchor's text at the hint,
 * the hint is re-pinned on a copy of the quote inside `before`, or else the anchor comes back
 * unchanged so `resolveAnchor` re-finds it by quote. `exact` is never rebuilt from a stale hint.
 * A pure insertion (empty `before`) cannot be checked and is trusted.
 */
export function rebaseAnchor(
    anchor: Anchor,
    edit: SourceSplice,
    options: RebaseOptions = {},
): Anchor | null {
    const pinned = options.own ? pinToSplice(anchor, edit) : null;
    if (pinned) return rebaseAt(pinned, edit);
    if (agreesWithWindow(anchor, edit)) return rebaseAt(anchor, edit);
    const repinned = pinToSplice(anchor, edit);
    return repinned ? rebaseAt(repinned, edit) : anchor;
}

/** `rebaseAnchor` for an anchor whose hint is right for the pre-splice source. */
function rebaseAt(anchor: Anchor, edit: SourceSplice): Anchor | null {
    const { exact, prefix, suffix } = anchor;
    const q0 = anchor.hint;
    const q1 = q0 + exact.length;
    const s = edit.start;
    const e = s + edit.before.length;
    const delta = edit.after.length - edit.before.length;

    let start: number;
    let end: number;
    let widen: "start" | "end" | undefined;
    if (e <= q0) {
        start = q0 + delta;
        end = q1 + delta;
    } else if (s >= q1) {
        start = q0;
        end = q1;
    } else if (s >= q0 && e <= q1) {
        start = q0;
        end = q1 + delta;
    } else if (s <= q0 && e >= q1) {
        // The splice swallowed the quote; keep it only if the replacement still holds it.
        const at = nearestIndex(edit.after, exact, q0 - s);
        if (at === -1) return null;
        start = s + at;
        end = start + exact.length;
    } else if (s < q0) {
        start = s;
        end = q1 + delta;
        widen = "start";
    } else {
        start = q0;
        end = s + edit.after.length;
        widen = "end";
    }
    if (end <= start) return null;

    // Rebuild the text we know around the quote: its old context window with the splice applied.
    const w0 = q0 - prefix.length;
    const w1 = q1 + suffix.length;
    const window = prefix + exact + suffix;
    let known: string;
    let knownStart: number;
    if (e < w0) {
        known = window;
        knownStart = w0 + delta;
    } else if (s > w1) {
        known = window;
        knownStart = w0;
    } else {
        const left = s >= w0 ? window.slice(0, s - w0) : "";
        const right = e <= w1 ? window.slice(e - w0) : "";
        known = left + edit.after + right;
        knownStart = s >= w0 ? w0 : s;
    }
    let from = start - knownStart;
    let to = end - knownStart;
    // A splice edge that lands mid-word would leave a word fragment at the quote's edge.
    if (widen === "start") {
        while (from > 0 && isWord(known[from - 1]) && isWord(known[from])) from--;
    } else if (widen === "end") {
        while (to < known.length && isWord(known[to - 1]) && isWord(known[to])) to++;
    }
    return {
        exact: known.slice(from, to),
        prefix: known.slice(Math.max(0, from - ANCHOR_CONTEXT), from),
        suffix: known.slice(to, to + ANCHOR_CONTEXT),
        hint: knownStart + from,
    };
}

function nearestIndex(text: string, needle: string, target: number): number {
    let best = -1;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        if (best === -1 || Math.abs(at - target) < Math.abs(best - target)) best = at;
    }
    return best;
}

/** Block containers whose children are inline (phrasing) content. */
const phrasingParents = new Set(["paragraph", "heading", "tableCell"]);

function inlineRanges(doc: ParsedDoc, range: Range): Range[] {
    const { tree, shift } = docTree(doc);
    const out: Range[] = [];
    const visit = (node: Nodes, inline: boolean) => {
        const position = node.position;
        if (!position) return;
        const start = position.start.offset! + shift;
        const end = position.end.offset! + shift;
        if (end <= range.start || start >= range.end) return;
        if (inline && node.type !== "text") out.push({ start, end });
        if ("children" in node) {
            const childInline = inline || phrasingParents.has(node.type);
            for (const child of node.children) visit(child, childInline);
        }
    };
    visit(tree, false);
    return out;
}

/**
 * Widens a source range so it never cuts inline markup: when one end falls inside an inline
 * node (emphasis, link, code span…) and the other outside, the range takes the whole node.
 */
export function snapRange(doc: ParsedDoc, range: Range): Range {
    let { start, end } = range;
    const nodes = inlineRanges(doc, range);
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of nodes) {
            const startInside = node.start < start && start < node.end;
            const endInside = node.start < end && end < node.end;
            if (startInside && !endInside) {
                start = node.start;
                changed = true;
            } else if (endInside && !startInside) {
                end = node.end;
                changed = true;
            }
        }
    }
    return { start, end };
}

function deepestAt(units: Unit[], offset: number): Unit | undefined {
    for (const unit of units) {
        if (unit.start <= offset && offset < unit.end) {
            return deepestAt(unit.children, offset) ?? unit;
        }
    }
    return undefined;
}

/**
 * v1 keeps a selection inside one unit: the smallest unit holding its start (or the first unit
 * after it, when the start sits between units). Null when the range covers no unit text.
 */
export function clampRange(doc: ParsedDoc, range: Range): Range | null {
    let start = range.start;
    let unit = deepestAt(doc.units, start);
    if (!unit) {
        const next = flattenUnits(doc.units).find((candidate) => candidate.start >= start);
        if (!next || next.start >= range.end) return null;
        start = next.start;
        unit = deepestAt(doc.units, start);
        if (!unit) return null;
    }
    const end = Math.min(range.end, unit.end);
    return end > start ? { start, end } : null;
}
