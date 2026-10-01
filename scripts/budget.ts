// Token budget check (PLAN.md → Token budget). Seeds fixed threads and edits on a temp copy of a
// sample, runs the real CLI (`run` from src/cli/main.ts) for every agent-facing op, and asserts
// each op's stdout bytes against budget.json.
// Output is numbers only, so it is safe to run on the private sample.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import defaultCeilings from "../budget.json";
import { run } from "../src/cli/main.ts";
import { createAnchor } from "../src/core/anchor.ts";
import { applyEdit } from "../src/core/apply.ts";
import { decodeSource, flattenUnits, hashText, parseDoc } from "../src/core/blocks.ts";
import { byteLength, wordHunks } from "../src/core/diff.ts";
import { appendEvents, readLog } from "../src/core/log.ts";
import type {
    ParsedDoc,
    Range,
    ThreadId,
    Unit,
    UnitKind,
    VerdictState,
} from "../src/core/model.ts";
import { createThread, foldLog, unresolvedThreads } from "../src/core/threads.ts";

export type BudgetKey = keyof typeof defaultCeilings;
export type Ceilings = Record<BudgetKey, number>;

/** One agent-facing call and the stdout it printed. */
export interface Op {
    name: string;
    /** Every ceiling this op's output counts toward. */
    keys: BudgetKey[];
    stdout: string;
    /** A user edit: its ceiling adds changed words and a per-hunk allowance to the base. */
    edit?: { changedBytes: number; hunks: number };
}

const root = join(import.meta.dir, "..");
export const samples = {
    public: join(root, "fixtures/public-sample.md"),
    private: join(root, "fixtures/private/sample.md"),
};

// Seeds pick places by structure (Nth unit of a kind, word offsets), never by text, so the same
// seeds run on any sample and nothing from a sample is written into this file.

interface UnitPick {
    kind: UnitKind;
    /** Position among units of this kind, 0 to 1; "longest" picks the longest one. */
    at: number | "longest";
    /** Table cells: the column to pick from (body rows only). */
    column?: number;
}

type QuotePick = { words: [start: number, count: number] } | { codeSpan: true } | { whole: true };

/** How the agent answers the thread in the loop; each answer prints one ack. */
type Answer = { reply: string; resolve?: boolean } | { suggest: string };

interface ThreadSeed {
    id: ThreadId;
    unit: UnitPick;
    quote: QuotePick;
    msg: string;
    answer: Answer;
}

interface EditSeed {
    unit: UnitPick;
    /** Words replaced (start, count) and the replacement text; count 0 inserts. */
    changes: { words: [start: number, count: number]; text: string }[];
}

export const threadSeeds: ThreadSeed[] = [
    {
        id: "c1",
        unit: { kind: "paragraph", at: 0.1 },
        quote: { words: [5, 4] },
        msg: "Is this still true after the last release?",
        answer: { reply: "Yes, checked against the current build." },
    },
    {
        id: "c2",
        unit: { kind: "heading", at: 0.5 },
        quote: { words: [0, 3] },
        msg: "Rename this section so it says what it decides.",
        answer: { reply: "Renamed in the suggestion below once you accept." },
    },
    {
        id: "c3",
        unit: { kind: "listItem", at: 0.3 },
        quote: { words: [3, 5] },
        msg: "Needs a number here, and a source for it.",
        answer: { reply: "Added the number from the staging dashboard." },
    },
    {
        id: "c4",
        unit: { kind: "paragraph", at: 0.4 },
        quote: { codeSpan: true },
        msg: "Wrong name, I think this was renamed.",
        answer: { suggest: "`renamedThing`" },
    },
    {
        id: "c5",
        unit: { kind: "tableCell", at: 0.5, column: 1 },
        quote: { words: [2, 4] },
        msg: "Too long for a table cell. Shorten it.",
        answer: { suggest: "shorter cell text" },
    },
    {
        id: "c6",
        unit: { kind: "paragraph", at: 0.7 },
        quote: { words: [-6, 5] },
        msg: "This ending undercuts the recommendation above it. Either drop it or explain why the risk is acceptable, and link the finding it refers to so a reader can check it.",
        answer: { reply: "Dropped the ending and linked the finding." },
    },
    {
        id: "c7",
        unit: { kind: "paragraph", at: "longest" },
        quote: { whole: true },
        msg: "This whole paragraph is too long. Split it into two or three and lead with the conclusion.",
        answer: { reply: "Split into three, conclusion first." },
    },
    {
        id: "c8",
        unit: { kind: "tableCell", at: 0.2, column: 3 },
        quote: { words: [0, 6] },
        msg: "Who owns this? Add an owner or a team.",
        answer: { reply: "The platform group owns it." },
    },
    {
        id: "c9",
        unit: { kind: "paragraph", at: "longest" },
        quote: { words: [100, 6] },
        msg: "I don't follow this step. What happens between the two stages, and what does the reader need to know to trust the number that follows? One sentence is enough.",
        answer: { reply: "Added one sentence on the hand-off." },
    },
    {
        id: "c10",
        unit: { kind: "tableCell", at: 0.8, column: 2 },
        quote: { words: [1, 3] },
        msg: "Fine as is, thanks.",
        answer: { reply: "Thanks.", resolve: true },
    },
];

/** Watch batches: each wakes `watch` once, then goes through `pending`. */
export const batches: ThreadId[][] = [
    ["c1", "c2"],
    ["c3", "c4", "c5"],
    ["c6", "c7", "c8", "c9", "c10"],
];

const editSeeds: EditSeed[] = [
    {
        unit: { kind: "paragraph", at: "longest" },
        changes: [{ words: [60, 3], text: "three fresh words" }],
    },
    {
        unit: { kind: "paragraph", at: 0.25 },
        changes: [
            { words: [10, 1], text: "replaced" },
            { words: [30, 0], text: "two inserted" },
        ],
    },
    {
        unit: { kind: "tableCell", at: 0.6, column: 2 },
        changes: [{ words: [1, 2], text: "shorter wording" }],
    },
];

export function pickUnit(doc: ParsedDoc, pick: UnitPick, label: string): Unit {
    const candidates = flattenUnits(doc.units).filter(
        (unit) =>
            unit.kind === pick.kind &&
            unit.end > unit.start &&
            (pick.column === undefined ||
                (unit.cell !== undefined && unit.cell.row > 0 && unit.cell.column === pick.column)),
    );
    if (candidates.length === 0) throw new Error(`${label}: no ${pick.kind} unit to seed on`);
    if (pick.at === "longest") {
        return candidates.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    }
    return candidates[Math.floor(pick.at * (candidates.length - 1))]!;
}

export function wordRanges(source: string, unit: Unit): Range[] {
    const text = source.slice(unit.start, unit.end);
    return Array.from(text.matchAll(/\S+/g), (match) => ({
        start: unit.start + match.index,
        end: unit.start + match.index + match[0].length,
    }));
}

export function pickWords(source: string, unit: Unit, [start, count]: [number, number]): Range {
    const words = wordRanges(source, unit);
    const from = Math.max(0, Math.min(start < 0 ? words.length + start : start, words.length - 1));
    const to = Math.min(words.length, from + Math.max(count, 1)) - 1;
    return { start: words[from]!.start, end: words[to]!.end };
}

export function pickQuote(doc: ParsedDoc, unit: Unit, pick: QuotePick): Range {
    if ("whole" in pick) return { start: unit.start, end: unit.end };
    if ("codeSpan" in pick) {
        const match = /`[^`\n]+`/.exec(doc.source.slice(unit.start, unit.end));
        if (match) {
            const start = unit.start + match.index;
            return { start, end: start + match[0].length };
        }
        return pickWords(doc.source, unit, [0, 3]);
    }
    return pickWords(doc.source, unit, pick.words);
}

// A world is a temp dir holding a copy of the sample and its own daemon state dir.

interface World {
    dir: string;
    doc: string;
}

async function inWorld<T>(source: string, fn: (world: World) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "margin-budget-"));
    try {
        const doc = join(dir, "doc.md");
        writeFileSync(doc, new TextEncoder().encode(source));
        return await fn({ dir, doc });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** Runs one `margin` command in the world and returns its stdout. */
async function cli(world: World, stdin: string, ...argv: string[]): Promise<string> {
    let stdout = "";
    const code = await run(argv, {
        cwd: world.dir,
        env: { MARGIN_STATE_DIR: join(world.dir, "state"), MARGIN_DEBOUNCE_MS: "0" },
        isTTY: false,
        write: (text) => {
            stdout += text;
        },
        stdin: async () => stdin,
        signal: AbortSignal.timeout(10_000),
    });
    // The command name only: arguments and output may quote the sample.
    if (code !== 0 || stdout === "") throw new Error(`margin ${argv[0]} failed (exit ${code})`);
    return stdout;
}

function readDoc(world: World): ParsedDoc {
    return parseDoc(decodeSource(readFileSync(world.doc)));
}

type EditSize = NonNullable<Op["edit"]>;

/** User edits land first, through the same write path the UI uses, so anchors seed on the result. */
async function seedEdits(world: World): Promise<EditSize[]> {
    const sizes: EditSize[] = [];
    for (const [index, spec] of editSeeds.entries()) {
        const doc = readDoc(world);
        const unit = pickUnit(doc, spec.unit, `edit ${index + 1}`);
        const before = doc.source.slice(unit.start, unit.end);
        const words = wordRanges(doc.source, unit);
        let after = before;
        const splices = spec.changes
            .map((change) => {
                const [start, count] = change.words;
                const at = Math.min(start, words.length - 1);
                const from = words[at]!.start - unit.start;
                if (count === 0) return { from, to: from, text: `${change.text} ` };
                const to = words[Math.min(words.length, at + count) - 1]!.end - unit.start;
                return { from, to, text: change.text };
            })
            .sort((a, b) => b.from - a.from);
        for (const splice of splices) {
            after = after.slice(0, splice.from) + splice.text + after.slice(splice.to);
        }
        const result = await applyEdit(world.doc, {
            start: unit.start,
            before,
            after,
            cause: "user",
            by: "user",
        });
        if (!result.ok) throw new Error(`edit ${index + 1}: ${result.reason}`);
        const hunks = wordHunks(before, after);
        sizes.push({
            changedBytes: hunks.reduce((sum, hunk) => sum + hunk.changedBytes, 0),
            hunks: hunks.length,
        });
    }
    return sizes;
}

async function seedComments(world: World, ids: ThreadId[]): Promise<void> {
    const doc = readDoc(world);
    for (const spec of threadSeeds.filter((seed) => ids.includes(seed.id))) {
        const unit = pickUnit(doc, spec.unit, spec.id);
        const anchor = createAnchor(doc.source, pickQuote(doc, unit, spec.quote));
        const { id } = await createThread(world.doc, (next) => [
            { type: "comment", by: "user", id: next, anchor, text: spec.msg, draft: false },
        ]);
        if (id !== spec.id) throw new Error(`seeded ${id}, expected ${spec.id}`);
    }
}

const allIds = threadSeeds.map((seed) => seed.id);

// The verdict and the finish request are the user's, written by the page; no CLI command logs
// either, so they are seeded as events.

async function seedVerdict(world: World, state: VerdictState, closed?: ThreadId[]): Promise<void> {
    const hash = hashText(readDoc(world).source);
    await appendEvents(world.doc, [
        { type: "verdict", by: "user", state, hash, ...(closed?.length ? { closed } : {}) },
    ]);
}

async function unresolvedIds(world: World): Promise<ThreadId[]> {
    const state = foldLog((await readLog(world.doc)).events);
    return unresolvedThreads(state).map((thread) => thread.id);
}

/** Hands every unresolved thread to the agent, as the page's "ask the agent to finish" does. */
async function seedFinish(world: World): Promise<ThreadId[]> {
    const ids = await unresolvedIds(world);
    await appendEvents(world.doc, [{ type: "finish", by: "user", ids }]);
    return ids;
}

/** Top-level lines start a block (a thread or an edit); indented lines belong to it. */
export function pendingBlocks(stdout: string): string[] {
    const blocks: string[][] = [];
    for (const line of stdout.replace(/\n$/, "").split("\n")) {
        if (!line.startsWith("  ") || blocks.length === 0) blocks.push([line]);
        else blocks[blocks.length - 1]!.push(line);
    }
    return blocks.map((lines) => lines.join("\n"));
}

/** A thread block without its messages, which the per-thread ceiling excludes. */
function withoutMessages(block: string): string {
    const lines = block.split("\n");
    while (lines.length > 2 && /^ {2}(user|agent): /.test(lines[lines.length - 1]!)) lines.pop();
    return lines.join("\n");
}

export interface Measured {
    ops: Op[];
    /** `pending` for all seeded threads and edits, as `--json` and as plain text. */
    pendingBytes: { json: number; text: number };
    /** The line `watch` printed for each batch. */
    lines: string[];
    /** The lines `watch` printed for the doc's status and for finish requests. */
    statusLines: string[];
    /** The `pending` reads that open with the review header. */
    headed: string[];
    /** Thread blocks in the full `pending` that carry table-cell context. */
    cellThreads: number;
}

export async function measure(source: string): Promise<Measured> {
    const ops: Op[] = [];

    const full = await inWorld(source, async (world) => {
        const edits = await seedEdits(world);
        await seedComments(world, allIds);
        return { edits, stdout: await cli(world, "", "pending", "doc.md") };
    });
    const blocks = pendingBlocks(full.stdout);
    const threadBlocks = blocks.filter((block) => /^c\d+ /.test(block));
    const editBlocks = blocks.filter((block) => block.startsWith("edit "));
    for (const block of threadBlocks) {
        ops.push({
            name: `pending thread ${block.slice(0, block.indexOf(" "))}`,
            keys: ["pendingThreadMedian", "pendingThreadMax"],
            stdout: `${withoutMessages(block)}\n`,
        });
    }
    editBlocks.forEach((block, index) => {
        ops.push({
            name: `pending edit ${index + 1}`,
            keys: ["pendingEditBase"],
            stdout: `${block}\n`,
            edit: full.edits[index]!,
        });
    });
    const json = await inWorld(source, async (world) => {
        await seedEdits(world);
        await seedComments(world, allIds);
        return await cli(world, "", "pending", "doc.md", "--json");
    });

    ops.push({
        name: "agent-help",
        keys: ["agentHelp"],
        stdout: await inWorld(source, (world) => cli(world, "", "agent-help")),
    });

    // The full loop: each batch wakes watch once, then one pending call reads its threads (the
    // first also carries the user edits), then one ack per thread.
    const lines: string[] = [];
    const statusLines: string[] = [];
    const headed: string[] = [];
    await inWorld(source, async (world) => {
        await seedEdits(world);
        for (const [index, ids] of batches.entries()) {
            await seedComments(world, ids);
            const line = await cli(world, "", "watch", "doc.md", "--once");
            lines.push(line);
            ops.push({
                name: `watch batch ${index + 1}`,
                keys: ["watch", "fullLoopTenThreads"],
                stdout: line,
            });
            ops.push({
                name: `pending batch ${index + 1}`,
                keys: ["fullLoopTenThreads"],
                stdout: await cli(world, "", "pending", "doc.md"),
            });
            for (const id of ids) {
                ops.push({
                    name: `ack ${id}`,
                    keys: ["ack", "fullLoopTenThreads"],
                    stdout: await answer(world, id),
                });
            }
        }

        // The loop ends with the user approving as is: one status line, and the header a fresh
        // session reads from `pending`.
        await seedVerdict(world, "approved", await unresolvedIds(world));
        const line = await cli(world, "", "watch", "doc.md", "--once");
        statusLines.push(line);
        ops.push({ name: "watch approved", keys: ["watch", "fullLoopTenThreads"], stdout: line });
        const read = await cli(world, "", "pending", "doc.md");
        headed.push(read);
        ops.push({ name: "pending approved", keys: ["fullLoopTenThreads"], stdout: read });
    });

    // The widest status lines: a doc word beside all ten threads, then all ten handed over. A
    // finish request leaves `reopened` out, so no line carries both. The finish pass reads every
    // thread again, so it is a second loop with a ceiling of its own (the watch line, the `pending`
    // read and ten acks) and stays out of the first one's total.
    await inWorld(source, async (world) => {
        await seedComments(world, allIds);
        const status = async (name: string, ...keys: BudgetKey[]): Promise<void> => {
            const line = await cli(world, "", "watch", "doc.md", "--once");
            statusLines.push(line);
            ops.push({ name: `watch ${name}`, keys: ["watch", ...keys], stdout: line });
        };
        await seedVerdict(world, "declined");
        await status("declined with ten threads");
        const handed = await seedFinish(world);
        await status("finish with ten threads", "finishTenThreads");
        const read = await cli(world, "", "pending", "doc.md");
        headed.push(read);
        ops.push({ name: "pending finish", keys: ["finishTenThreads"], stdout: read });
        for (const id of handed) {
            ops.push({
                name: `finish ack ${id}`,
                keys: ["ack", "finishTenThreads"],
                stdout: await cli(world, "", "resolve", id),
            });
        }
        await seedVerdict(world, "approved");
        await status("approved");
        await seedVerdict(world, "open");
        await status("reopened");
    });

    return {
        ops,
        pendingBytes: { json: byteLength(json), text: byteLength(full.stdout) },
        lines,
        statusLines,
        headed,
        cellThreads: threadBlocks.filter((block) => block.includes("\n  header: ")).length,
    };
}

async function answer(world: World, id: ThreadId): Promise<string> {
    const spec = threadSeeds.find((seed) => seed.id === id)!.answer;
    if ("suggest" in spec) {
        return await cli(world, `${spec.suggest}\n`, "suggest", id, "--replace", "-");
    }
    return await cli(world, "", "reply", id, spec.reply, ...(spec.resolve ? ["--resolve"] : []));
}

export interface Row {
    key: BudgetKey;
    bytes?: number;
    ceiling: number;
    over: boolean;
}

export interface Report {
    rows: Row[];
    breached: boolean;
    pendingBytes: Measured["pendingBytes"];
    shape: SampleShape;
}

/** Keys that parameterise another ceiling rather than cap an op of their own. */
const PARAMETERS: BudgetKey[] = ["pendingEditExtraHunk"];

/** "200 B + 60 B per extra hunk + changed words": bytes an edit may use on top of the base. */
export function editAllowance(op: Op, ceilings: Ceilings): number {
    if (!op.edit) return 0;
    return op.edit.changedBytes + Math.max(0, op.edit.hunks - 1) * ceilings.pendingEditExtraHunk;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function reduce(key: BudgetKey, values: number[]): number {
    if (key === "pendingThreadMedian") return median(values);
    if (key === "fullLoopTenThreads" || key === "finishTenThreads") {
        return values.reduce((sum, value) => sum + value, 0);
    }
    return Math.max(...values);
}

/** Structure of a sample, numbers only: used to check the public sample matches the private one. */
export interface SampleShape {
    bytes: number;
    paragraphs: number;
    paragraphMean: number;
    paragraphMax: number;
    tableRows: number;
    tableRowMean: number;
    codeSpans: number;
    fences: number;
}

export function shape(source: string): SampleShape {
    const units = flattenUnits(parseDoc(source).units);
    const lengths = (kind: UnitKind) =>
        units.filter((unit) => unit.kind === kind).map((unit) => unit.end - unit.start);
    const paragraphs = lengths("paragraph");
    const rows = units
        .filter((unit) => unit.kind === "table")
        .flatMap((unit) => source.slice(unit.start, unit.end).split(/\r?\n/))
        .map((row) => row.length);
    const mean = (values: number[]) =>
        values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
    return {
        bytes: byteLength(source),
        paragraphs: paragraphs.length,
        paragraphMean: mean(paragraphs),
        paragraphMax: Math.max(0, ...paragraphs),
        tableRows: rows.length,
        tableRowMean: mean(rows),
        codeSpans: source.match(/`[^`\n]+`/g)?.length ?? 0,
        fences: lengths("code").length,
    };
}

export function report(
    measured: Measured,
    source: string,
    ceilings: Ceilings = defaultCeilings,
): Report {
    const values = new Map<BudgetKey, number[]>();
    for (const op of measured.ops) {
        const bytes = byteLength(op.stdout);
        for (const key of op.keys) {
            const value = key === "pendingEditBase" ? bytes - editAllowance(op, ceilings) : bytes;
            values.set(key, [...(values.get(key) ?? []), value]);
        }
    }
    const keys = (Object.keys(ceilings) as BudgetKey[]).filter((key) => !PARAMETERS.includes(key));
    const rows = keys.map((key): Row => {
        const list = values.get(key);
        const bytes = list ? reduce(key, list) : undefined;
        return {
            key,
            bytes,
            ceiling: ceilings[key],
            over: bytes !== undefined && bytes > ceilings[key],
        };
    });
    return {
        rows,
        breached: rows.some((row) => row.over),
        pendingBytes: measured.pendingBytes,
        shape: shape(source),
    };
}

export async function runBudget(
    source: string,
    ceilings: Ceilings = defaultCeilings,
): Promise<Report> {
    return report(await measure(source), source, ceilings);
}

function flag(name: string): string | undefined {
    const args = process.argv.slice(2);
    const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
    if (index === -1) return undefined;
    const arg = args[index]!;
    return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
}

async function main(): Promise<void> {
    const which = flag("sample") ?? "public";
    if (which !== "public" && which !== "private") {
        console.error("--sample must be public or private");
        process.exit(2);
    }
    const path = samples[which];
    if (!existsSync(path)) {
        console.log(`${which} sample not found; nothing measured`);
        return;
    }
    const ceilingsPath = flag("ceilings");
    const ceilings: Ceilings = ceilingsPath
        ? JSON.parse(readFileSync(ceilingsPath, "utf8"))
        : defaultCeilings;
    const result = await runBudget(decodeSource(readFileSync(path)), ceilings);

    console.log(`sample: ${which}`);
    for (const row of result.rows) {
        const status = row.bytes === undefined ? "not measured" : row.over ? "OVER" : "ok";
        console.log(
            `${row.key.padEnd(20)} ${String(row.bytes ?? "-").padStart(6)} / ${String(row.ceiling).padStart(5)} B  ${status}`,
        );
    }
    const { json, text } = result.pendingBytes;
    console.log(
        `pending --json ${json} B, plain text ${text} B (${text <= json ? "text" : "json"} smaller)`,
    );
    console.log(
        `shape: ${Object.entries(result.shape)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")}`,
    );
    if (result.breached) process.exit(1);
}

if (import.meta.main) await main();
