import { flattenUnits } from "../src/core/blocks.ts";
import type { ParsedDoc, Range, Unit } from "../src/core/model.ts";
import { proposeEdit } from "./agent.ts";
import type { SeedEdit, SeedThread } from "./memory-store.ts";

export const editable = (text: string) => proposeEdit(text) !== null;

const plainRun = /[A-Za-z][^`*_[\]|<>\\\n#]{24,}/g;

/** A run of plain prose (no markup) inside `unit`, cut at word edges to at most `max` chars. */
export function plainPhrase(
    source: string,
    unit: Unit,
    max: number,
    accept: (text: string) => boolean = () => true,
): Range | null {
    const text = source.slice(unit.start, unit.end);
    for (const match of text.matchAll(plainRun)) {
        let phrase = match[0];
        if (phrase.length > max) {
            phrase = phrase.slice(0, phrase.lastIndexOf(" ", max));
        }
        phrase = phrase.trimEnd();
        if (phrase.length >= 24 && accept(phrase)) {
            const start = unit.start + match.index;
            return { start, end: start + phrase.length };
        }
    }
    return null;
}

const minute = 60_000;

/**
 * Seeds a thread in every state from the doc's own structure. Messages are generic; quotes are
 * whatever prose sits at the chosen offsets, so nothing from the sample is written down here.
 */
export function planSeeds(doc: ParsedDoc): { threads: SeedThread[]; edits: SeedEdit[] } {
    const { source } = doc;
    const paragraphs = doc.units.filter(
        (unit) => unit.kind === "paragraph" && unit.end - unit.start > 160,
    );
    const used = new Set<Unit>();
    const pick = (
        fraction: number,
        max: number,
        accept?: (text: string) => boolean,
    ): Range | null => {
        const from = Math.floor(fraction * paragraphs.length);
        for (let i = 0; i < paragraphs.length; i++) {
            const unit = paragraphs[(from + i) % paragraphs.length]!;
            if (used.has(unit)) {
                continue;
            }
            const range = plainPhrase(source, unit, max, accept);
            if (range) {
                used.add(unit);
                return range;
            }
        }
        return null;
    };
    const quote = (range: Range) => source.slice(range.start, range.end);

    const threads: SeedThread[] = [];
    const add = (range: Range | null, spec: Omit<SeedThread, "range">) => {
        if (range) {
            threads.push({ range, ...spec });
        }
    };

    add(pick(0.02, 70), {
        state: "open",
        createdBy: "user",
        messages: [{ by: "user", text: "Is this still accurate as of this week?" }],
        agoMs: 3 * minute,
    });
    const suggested = pick(0.08, 180, editable);
    add(suggested, {
        state: "replied",
        createdBy: "user",
        messages: [
            { by: "user", text: "Could this be shorter?" },
            { by: "agent", text: "Here's a tighter version." },
        ],
        suggestion: suggested
            ? { by: "agent", replace: proposeEdit(quote(suggested))! }
            : undefined,
        agoMs: 9 * minute,
    });
    add(pick(0.16, 60), {
        state: "working",
        createdBy: "user",
        messages: [{ by: "user", text: "Can you add where this figure comes from?" }],
        agoMs: 20_000,
    });
    add(pick(0.24, 80), {
        state: "replied",
        createdBy: "user",
        messages: [
            { by: "user", text: "Why is this listed before the others?" },
            {
                by: "agent",
                text: "It follows the order used elsewhere in the doc. Happy to reorder if you prefer another.",
            },
        ],
        agoMs: 26 * minute,
    });
    add(pick(0.32, 50), {
        state: "resolved",
        createdBy: "user",
        messages: [
            { by: "user", text: "Typo here?" },
            { by: "agent", text: "Fixed." },
        ],
        agoMs: 48 * minute,
    });
    const lost = pick(0.4, 60);
    add(lost, {
        state: "open",
        createdBy: "user",
        messages: [{ by: "user", text: "This sentence reads oddly." }],
        detachedExact: lost ? `${quote(lost)} and more` : undefined,
        agoMs: 64 * minute,
    });
    const applied = pick(0.5, 180, editable);
    add(applied, {
        state: "replied",
        createdBy: "user",
        messages: [
            { by: "user", text: "Go ahead and tighten this." },
            { by: "agent", text: "Applied directly. Revert if it reads worse." },
        ],
        applied: applied ? proposeEdit(quote(applied))! : undefined,
        agoMs: 6 * minute,
    });
    add(pick(0.62, 70), {
        state: "working",
        createdBy: "user",
        messages: [{ by: "user", text: "Double-check this against the table below." }],
        agoMs: 14 * minute,
    });

    const cells = flattenUnits(doc.units).filter(
        (unit) =>
            unit.kind === "tableCell" && (unit.cell?.row ?? 0) > 1 && unit.end - unit.start > 30,
    );
    const rotated = [...cells.slice(Math.floor(cells.length / 3)), ...cells];
    const cellRange = rotated
        .map((unit) => plainPhrase(source, unit, 50))
        .find((range) => range !== null);
    add(cellRange ?? null, {
        state: "open",
        createdBy: "user",
        messages: [{ by: "user", text: "Is this cell up to date?" }],
        agoMs: 12 * minute,
    });

    const items = flattenUnits(doc.units).filter(
        (unit) => unit.kind === "listItem" && unit.end - unit.start > 80,
    );
    const item = items[Math.floor(items.length / 2)];
    const itemRange = item ? plainPhrase(source, item, 160, editable) : null;
    add(itemRange, {
        state: "open",
        createdBy: "user",
        messages: [{ by: "user", text: "Suggested wording." }],
        suggestion: itemRange ? { by: "user", replace: proposeEdit(quote(itemRange))! } : undefined,
        agoMs: 2 * minute,
    });

    const edits: SeedEdit[] = [];
    const edited = pick(0.72, 180, editable);
    if (edited) {
        edits.push({ range: edited, after: proposeEdit(quote(edited))!, agoMs: 4 * minute });
    }
    return { threads, edits };
}
