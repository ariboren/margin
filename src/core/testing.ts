// Shared fast-check setup for the core property tests. Replay a failure with the seed and path
// it prints: MARGIN_FC_SEED=<seed> MARGIN_FC_PATH=<path> bun test <file>. MARGIN_FC_SCALE=10
// multiplies every run count, for a local soak.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fc from "fast-check";
import { decodeSource } from "./blocks.ts";

const scale = Number(process.env.MARGIN_FC_SCALE ?? "1");

/** A test timeout that grows with MARGIN_FC_SCALE. */
export function scaledTimeout(ms: number): number {
    return Math.max(ms, ms * scale);
}

/** `pinnedSeed` is for a known failure that must fail on every run; the env seed still wins. */
export function checkProperty<Ts extends [unknown, ...unknown[]]>(
    property: fc.IProperty<Ts>,
    numRuns: number,
    pinnedSeed?: number,
): void {
    const envSeed = process.env.MARGIN_FC_SEED;
    const seed = envSeed === undefined ? pinnedSeed : Number(envSeed);
    const path = process.env.MARGIN_FC_PATH;
    fc.assert(property, {
        numRuns: Math.max(1, Math.round(numRuns * scale)),
        ...(seed === undefined ? {} : { seed }),
        ...(path === undefined ? {} : { path }),
    });
}

const fixtures = join(import.meta.dir, "../../fixtures");

const loaded = new Map<string, string>();

export function loadFixture(name: string): string {
    let source = loaded.get(name);
    if (source === undefined) {
        source = decodeSource(readFileSync(join(fixtures, name)));
        loaded.set(name, source);
    }
    return source;
}

export const edgeFixtures = ["edge.md", "edge-crlf.md", "edge-nonl.md", "edge-bom.md"];

/** Pieces the ASCII fixtures lack: multibyte text, both line endings, and markdown syntax. */
const fragments = [
    "a",
    "zq",
    " ",
    ".",
    "é",
    "日本",
    "😀",
    "\n",
    "\r\n",
    "| a | b |",
    "\\|",
    "- item\n  - nested",
    "`code`",
    "**b**",
    "[l](u)",
];

export const fragmentArb = fc.constantFrom(...fragments);

/** Replacement text built from the fragments; may be empty. */
export const textArb = fc.string({ unit: fragmentArb, maxLength: 4 });

/** Moves an offset that would split a surrogate pair back to the pair's start. */
export function snapOffset(source: string, offset: number): number {
    const code = source.charCodeAt(offset);
    return offset > 0 && code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset;
}

export interface SourceCase {
    fixture: string;
    inserts: [number, string][];
}

/** A fixture by name with up to six fragments inserted; counterexamples print the name only. */
export function sourceArb(names: string[]): fc.Arbitrary<SourceCase> {
    return fc.record({
        fixture: fc.constantFrom(...names),
        inserts: fc.array(fc.tuple(fc.nat(), fragmentArb), { maxLength: 6 }),
    });
}

export function buildSource({ fixture, inserts }: SourceCase): string {
    return inserts.reduce((source, [raw, fragment]) => {
        const at = snapOffset(source, raw % (source.length + 1));
        return source.slice(0, at) + fragment + source.slice(at);
    }, loadFixture(fixture));
}
