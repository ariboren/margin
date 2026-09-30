import { encodeCellText, flattenUnits, hashText } from "../core/blocks.ts";
import type { DocSnapshot, Offset, ParsedDoc, Unit } from "../core/model.ts";

/**
 * What a "keep mine" overwrote. Pairing an editor with the agent's version of its unit can be
 * wrong in shapes no rule sees (a sibling moved into the slot and edited in the same save), so the
 * agent's text is kept here, with Restore, until the kept unit changes or the user dismisses it.
 *
 * The record is a range, never a text search. Restore sends the range and version the save landed
 * at, strictly, so the server maps them through the splices really logged since and refuses if
 * any touched the range: that is what decides whether Restore lands. The client's own position
 * (`start`, followed by diffing snapshots) only places the card and drops it early.
 */
export interface Replacement {
    id: string;
    kind: Unit["kind"];
    /** Where the kept text landed, in the doc as of `keepVersion` (null: a host with no versions). */
    keepStart: Offset;
    keepVersion: number | null;
    /** Where the card thinks the kept text is now, in the source hashed as `hash`. */
    start: Offset;
    hash: string;
    /** The text the user kept, as saved. */
    mine: string;
    /** The agent's text it replaced. */
    replaced: string;
    /** Restore was refused: the card stays only to show the texts and offer Copy. */
    refused?: boolean;
}

export function replacementsKey(path: string): string {
    return `margin:replaced:${path}`;
}

/**
 * Follows a record from `from` to `to` (consecutive sources the page saw) by their common prefix
 * and suffix: one region covers every change between them. The record survives only if its range
 * sits strictly inside the unchanged prefix or suffix, not touching the region, and a unit of its
 * kind still spans exactly that range in `doc` (a merge or split drops it). Anything else, null.
 */
export function rebase(
    replacement: Replacement,
    from: string,
    to: string,
    doc: ParsedDoc,
): Replacement | null {
    if (from === to) {
        return replacement;
    }
    const limit = Math.min(from.length, to.length);
    let prefix = 0;
    while (prefix < limit && from[prefix] === to[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < limit - prefix &&
        from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
    ) {
        suffix++;
    }
    const { start } = replacement;
    const end = start + replacement.mine.length;
    let moved: Offset;
    if (end < prefix) {
        moved = start;
    } else if (start > from.length - suffix) {
        moved = start + to.length - from.length;
    } else {
        return null;
    }
    const spans = flattenUnits(doc.units).some(
        (unit) =>
            unit.kind === replacement.kind &&
            unit.start === moved &&
            unit.end === moved + replacement.mine.length,
    );
    return spans ? { ...replacement, start: moved, hash: hashText(to) } : null;
}

/** The strict save that puts the agent's text back, where the server knows the kept text to be. */
export function restoreEdit(replacement: Replacement): {
    start: Offset;
    before: string;
    after: string;
    version?: number;
    strict: true;
} {
    return {
        start: replacement.keepVersion === null ? replacement.start : replacement.keepStart,
        before: replacement.mine,
        after: replacement.replaced,
        ...(replacement.keepVersion === null ? {} : { version: replacement.keepVersion }),
        strict: true,
    };
}

export function parseReplacements(stored: string | null): Replacement[] {
    if (!stored) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed.filter(isReplacement) : [];
    } catch {
        return [];
    }
}

function isReplacement(entry: unknown): entry is Replacement {
    if (typeof entry !== "object" || entry === null) {
        return false;
    }
    const record = entry as Record<string, unknown>;
    return (
        ["id", "kind", "hash", "mine", "replaced"].every(
            (key) => typeof record[key] === "string",
        ) &&
        typeof record.start === "number" &&
        typeof record.keepStart === "number" &&
        (record.keepVersion === null || typeof record.keepVersion === "number")
    );
}

/**
 * The record for a Keep mine save that landed `mine` at `at`, as of the save's response `version`
 * (null where the host has none). `snapshot` is the page's doc once the save settled; a later save
 * pushed before the response can put it past `version`, where `at` means nothing, so then there
 * is no record. `mine` is the draft as typed; the record keeps it as the save wrote it (the doc's
 * line ending, or cell encoding). Null too when the doc does not show the kept text there as a
 * whole unit, so the card would have nothing sure to point at.
 */
export function newReplacement(input: {
    id: string;
    kind: Unit["kind"];
    snapshot: Pick<DocSnapshot, "doc" | "version">;
    at: Offset;
    version: number | null;
    mine: string;
    replaced: string;
}): Replacement | null {
    const { at } = input;
    const { doc } = input.snapshot;
    if (input.version !== null && input.snapshot.version !== input.version) {
        return null;
    }
    const mine =
        input.kind === "tableCell"
            ? encodeCellText(input.mine)
            : input.mine.replace(/\r?\n/g, doc.eol);
    const end = at + mine.length;
    const spans =
        doc.source.slice(at, end) === mine &&
        flattenUnits(doc.units).some(
            (unit) => unit.kind === input.kind && unit.start === at && unit.end === end,
        );
    return spans
        ? {
              id: input.id,
              kind: input.kind,
              keepStart: at,
              keepVersion: input.version,
              start: at,
              hash: hashText(doc.source),
              mine,
              replaced: input.replaced,
          }
        : null;
}
