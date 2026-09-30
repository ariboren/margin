import { alignUnits } from "../core/align.ts";
import type { Offset, ParsedDoc, SaveResult, Unit } from "../core/model.ts";

/** Where a deleted unit's draft can go back: after this root unit, or before the first (`null`). */
export interface Place {
    after: Unit | null;
}

/** An open unit editor, followed across every snapshot. */
export interface EditorSession {
    /** Keys the editor, so a unit moving under it (an edit above) does not remount it. */
    id: number;
    unit: Unit;
    /** Root units of the doc `unit` belongs to, to follow it across reparses. */
    roots: Unit[];
    /** Version of the snapshot `unit` comes from; saves send it so the daemon maps the offset. */
    version: number;
    before: string;
    draft: string;
    /** The unit's text after someone else changed it under the open editor. */
    theirs: string | null;
    /** "Keep mine" was chosen over their text: the save records what it replaced, with Restore. */
    keptMine: boolean;
    /**
     * Set once the unit was deleted under the editor. Its offset then points at some other unit,
     * so the draft is shown on its own and only goes back in at `place` when the user says so;
     * `place` is null for a nested unit, or once the unit before it is gone too.
     */
    gone: { place: Place | null } | null;
    /** Fixed when the editor opens, so a unit changing underneath does not orphan the draft. */
    draftKey: string;
}

function successors(prev: Unit[], next: Unit[]): Map<Unit, Unit> {
    const out = new Map<Unit, Unit>();
    for (const [after, before] of alignUnits(prev, next)) {
        out.set(before, after);
    }
    return out;
}

/** The re-insert point for a root unit that vanished: after the nearest root before it that survived. */
function placeFor(unit: Unit, roots: Unit[], moved: Map<Unit, Unit>): Place | null {
    const index = roots.indexOf(unit);
    if (index < 0) {
        return null;
    }
    for (let i = index - 1; i >= 0; i--) {
        const survivor = moved.get(roots[i]!);
        if (survivor) {
            return { after: survivor };
        }
    }
    return { after: null };
}

/** Where `unit` sits: its parent (null at the root) and its index among its siblings. */
function locate(
    units: Unit[],
    unit: Unit,
    parent: Unit | null = null,
): { parent: Unit | null; list: Unit[]; index: number } | null {
    const index = units.indexOf(unit);
    if (index >= 0) {
        return { parent, list: units, index };
    }
    for (const candidate of units) {
        const found = locate(candidate.children, unit, candidate);
        if (found) {
            return found;
        }
    }
    return null;
}

/**
 * Past this many sibling pairs (500 x 500 units) the pairing check is not computed and the session
 * detaches: two edit-distance tables that size take a few milliseconds on the render path, and a
 * table of thousands of cells would take seconds.
 */
export const MAX_PAIRING_CELLS = 250_000;

/**
 * Fewest unit inserts, deletes and rewrites turning `a` into `b` (lists of text hashes); with
 * `apart`, the fewest among readings that do not turn `a[apart[0]]` into `b[apart[1]]`.
 */
export function editDistance(a: string[], b: string[], apart?: [number, number]): number {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) {
            const across =
                apart && apart[0] === i - 1 && apart[1] === j - 1
                    ? Number.POSITIVE_INFINITY
                    : row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
            next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, across);
        }
        row = next;
    }
    return row[b.length]!;
}

/**
 * A changed unit's successor, only when there is no doubt: every shortest edit of its sibling list
 * turns it into that successor, and the successor's text was not already an old sibling's (that
 * would be a moved unit, not a rewrite of this one). Anything else returns null: a guess could let
 * "keep mine" overwrite text the user never started from. A nested unit's parent must be
 * unchanged or pass the same test. Only the sibling lists count, so repeats elsewhere in the doc
 * (a second "## Notes", `---` breaks) change nothing.
 *
 * By design, a merge or split of the edited unit (a rewrite plus an adjacent insert or delete) and
 * a whole-doc regeneration that changes the unit count detach too: the draft waits in the removed-
 * text panel, nothing is lost. Shapes the rule cannot see (a sibling moved into the unit's slot and
 * edited in the same save) are why "keep mine" records what it replaced, with Restore.
 */
function soleSuccessor(
    unit: Unit,
    roots: Unit[],
    nextRoots: Unit[],
    moved: Map<Unit, Unit>,
): Unit | null {
    const where = locate(roots, unit);
    const candidate = moved.get(unit);
    if (!where || !candidate) {
        return null;
    }
    let list = nextRoots;
    if (where.parent) {
        const parentNow = moved.get(where.parent);
        const parent =
            parentNow && parentNow.hash === where.parent.hash
                ? parentNow
                : soleSuccessor(where.parent, roots, nextRoots, moved);
        if (!parent) {
            return null;
        }
        list = parent.children;
    }
    const at = list.indexOf(candidate);
    const before = where.list.map((sibling) => sibling.hash);
    const after = list.map((sibling) => sibling.hash);
    const count = (hashes: string[], hash: string) => hashes.filter((h) => h === hash).length;
    if (
        at < 0 ||
        before.length * after.length > MAX_PAIRING_CELLS ||
        // The candidate's text was an old sibling's: a moved unit, not a rewrite of this one.
        before.includes(candidate.hash) ||
        // This unit's own text survives among the new siblings: it moved intact, and the
        // candidate is someone else's. Counted, so an edited empty cell still pairs when another
        // empty cell stays empty.
        count(after, unit.hash) > count(before, unit.hash) - 1
    ) {
        return null;
    }
    return editDistance(before, after, [where.index, at]) > editDistance(before, after)
        ? candidate
        : null;
}

function goneFrom(
    base: EditorSession,
    session: EditorSession,
    moved: Map<Unit, Unit>,
): EditorSession {
    return { ...base, theirs: null, gone: { place: placeFor(session.unit, session.roots, moved) } };
}

/**
 * The session as of `doc`. The unit follows its successor while its text is unchanged. When its
 * text changed, it pairs (the change is `theirs`) only if every shortest edit of its sibling list
 * rewrites it into that successor, which is not a moved old sibling; anything else, and a unit
 * with no successor, is gone.
 */
export function follow(session: EditorSession, doc: ParsedDoc, version: number): EditorSession {
    if (session.roots === doc.units) {
        return session;
    }
    const moved = successors(session.roots, doc.units);
    const base = { ...session, roots: doc.units, version };
    if (session.gone) {
        const after = session.gone.place?.after;
        const place =
            after === undefined
                ? null
                : after === null
                  ? { after: null }
                  : moved.has(after)
                    ? { after: moved.get(after)! }
                    : null;
        return { ...base, gone: { place } };
    }
    const next = moved.get(session.unit);
    if (!next) {
        return goneFrom(base, session, moved);
    }
    const text = doc.source.slice(next.start, next.end);
    const followed = { ...base, unit: next };
    if (text === session.before) {
        return followed;
    }
    if (text === session.draft) {
        return { ...followed, before: text };
    }
    if (soleSuccessor(session.unit, session.roots, doc.units, moved) !== next) {
        return goneFrom(base, session, moved);
    }
    return { ...followed, theirs: text };
}

/**
 * The splice that puts a gone unit's draft back as its own block at its place, with a blank line
 * on both sides: a heading or closing fence may abut the next block by one line ending, and the
 * draft must not run into it.
 */
export function reinsertEdit(
    session: EditorSession,
    doc: ParsedDoc,
): { start: Offset; before: ""; after: string } | null {
    const place = session.gone?.place;
    if (!place || session.draft.trim() === "") {
        return null;
    }
    const { eol } = doc;
    const gap = `${eol}${eol}`;
    if (place.after) {
        const rest = doc.source.slice(place.after.end);
        const tail =
            rest.trim() === "" || rest.startsWith(gap) ? "" : rest.startsWith(eol) ? eol : gap;
        return { start: place.after.end, before: "", after: `${gap}${session.draft}${tail}` };
    }
    const first = doc.units[0];
    if (first) {
        return { start: first.start, before: "", after: `${session.draft}${gap}` };
    }
    return {
        start: doc.source.length,
        before: "",
        after: `${session.draft}${doc.finalNewline ? doc.eol : ""}`,
    };
}

/** One per doc: a deleted unit's draft, kept across reloads until it is put back or discarded. */
export function strandedKey(path: string): string {
    return `margin:stranded:${path}`;
}

export function strandedRecord(session: Pick<EditorSession, "unit" | "draft">): string {
    return JSON.stringify({ kind: session.unit.kind, draft: session.draft });
}

/**
 * The removed-text panel after a reload, from its stored record. Its unit is only a kind (for the
 * editor's font); it matches nothing in the doc and has no place, so it offers copy and discard.
 */
export function restoreStranded(
    record: string | null,
    doc: ParsedDoc,
    version: number,
    id: number,
): EditorSession | null {
    if (!record) {
        return null;
    }
    let parsed: { kind?: unknown; draft?: unknown };
    try {
        parsed = JSON.parse(record) as { kind?: unknown; draft?: unknown };
    } catch {
        return null;
    }
    if (typeof parsed.kind !== "string" || typeof parsed.draft !== "string") {
        return null;
    }
    const unit: Unit = {
        kind: parsed.kind as Unit["kind"],
        start: 0,
        end: 0,
        line: 1,
        headingPath: [],
        hash: "",
        children: [],
    };
    return {
        id,
        unit,
        roots: doc.units,
        version,
        before: "",
        draft: parsed.draft,
        theirs: null,
        keptMine: false,
        gone: { place: null },
        draftKey: "",
    };
}

/**
 * Opening another unit while a removed unit's draft waits is refused: that draft lives only in
 * this session and its stored record, and a new session would push it out of sight.
 */
export function beginSession(
    current: EditorSession | null,
    fresh: EditorSession,
): EditorSession | null {
    return current?.gone ? current : fresh;
}

const puttingBack = new Set<number>();

/**
 * Puts a gone unit's draft back, once: the save resolves only after its snapshot arrives, and a
 * second click in that window would insert the draft again (a pure insertion always applies).
 * Resolves null when there is nothing to do or a put-back for this session is already in flight.
 */
export async function putBack(
    session: EditorSession,
    doc: ParsedDoc,
    save: (edit: {
        start: Offset;
        before: string;
        after: string;
        version: number;
    }) => Promise<SaveResult>,
): Promise<SaveResult | null> {
    const edit = reinsertEdit(session, doc);
    if (!edit || puttingBack.has(session.id)) {
        return null;
    }
    puttingBack.add(session.id);
    try {
        return await save({ ...edit, version: session.version });
    } finally {
        puttingBack.delete(session.id);
    }
}

/** Refused tries to open another unit, counted for the removed session they happened under. */
export interface Nudge {
    id: number;
    count: number;
}

export function nextNudge(current: Nudge | null, id: number): Nudge {
    return { id, count: current?.id === id ? current.count + 1 : 1 };
}

/** A removed session's own count: another session's tries never carry over to it. */
export function nudgeFor(nudge: Nudge | null, id: number): number {
    return nudge?.id === id ? nudge.count : 0;
}
