// Runs the suite once with line coverage and a junit report, prints test counts and line coverage of
// src/ per directory, and fails when a directory in FLOORS drops below its floor. In CI the same
// table goes to the job summary. Bun's own coverageThreshold applies per file, so each directory is
// summed here from lcov.
import { existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whole percent per directory, each set at its measured level rounded down (cli 94.16%, core
 * 99.12%, server 89.72% at v0.2.0). Bun only counts files a test loads, so one floor on the total
 * moved whenever a client test imported a component: the client's unit tests load app.tsx and the
 * components for their pure helpers, and every render path they leave unrun lands in the
 * denominator. The UI is covered by browser checks and e2e, not unit line coverage, so src/client
 * is reported with no floor, and the logic layers keep a floor each that a client import can't move.
 */
export const FLOORS: Readonly<Record<string, number>> = {
    "src/cli": 94,
    "src/core": 99,
    "src/server": 89,
};

/** Dev and test helpers in src/ that the package never ships. */
const HELPERS = new Set(["src/cli/testing.ts", "src/core/testing.ts", "src/server/dev-open.ts"]);

export interface FileCoverage {
    path: string;
    found: number;
    hit: number;
}

export interface TestCounts {
    tests: number;
    failures: number;
    skipped: number;
}

export interface Tally {
    name: string;
    files: number;
    found: number;
    hit: number;
}

export interface Summary {
    rows: Tally[];
    total: Tally;
}

export interface Breach {
    name: string;
    floor: number;
    /** Undefined when the directory has no coverage data at all. */
    coverage: number | undefined;
}

export function parseLcov(text: string): FileCoverage[] {
    const files: FileCoverage[] = [];
    let current: FileCoverage | undefined;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("SF:")) current = { path: line.slice(3), found: 0, hit: 0 };
        else if (line.startsWith("LF:") && current) current.found = Number(line.slice(3));
        else if (line.startsWith("LH:") && current) current.hit = Number(line.slice(3));
        else if (line === "end_of_record" && current) {
            files.push(current);
            current = undefined;
        }
    }
    return files;
}

export function inScope(path: string): boolean {
    return path.startsWith("src/") && !/\.test\.tsx?$/.test(path) && !HELPERS.has(path);
}

export function parseJunit(xml: string): TestCounts | undefined {
    const root = xml.match(/<testsuites\b[^>]*>/)?.[0];
    if (!root) return undefined;
    const attr = (name: string) => Number(root.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? 0);
    return { tests: attr("tests"), failures: attr("failures"), skipped: attr("skipped") };
}

export function percent(tally: Pick<Tally, "found" | "hit">): number {
    return tally.found === 0 ? 100 : (100 * tally.hit) / tally.found;
}

export function summarize(files: FileCoverage[]): Summary {
    const byDir = new Map<string, Tally>();
    const total: Tally = { name: "total", files: 0, found: 0, hit: 0 };
    for (const file of files.filter((file) => inScope(file.path))) {
        const name = file.path.split("/").slice(0, 2).join("/");
        const row = byDir.get(name) ?? { name, files: 0, found: 0, hit: 0 };
        byDir.set(name, row);
        for (const tally of [row, total]) {
            tally.files += 1;
            tally.found += file.found;
            tally.hit += file.hit;
        }
    }
    const rows = [...byDir.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { rows, total };
}

/** Floored directories under their floor; a floored directory missing from the report breaches. */
export function breaches(summary: Summary, floors: Readonly<Record<string, number>>): Breach[] {
    const result: Breach[] = [];
    for (const [name, floor] of Object.entries(floors)) {
        const row = summary.rows.find((row) => row.name === name);
        const coverage = row && row.found > 0 ? percent(row) : undefined;
        if (coverage === undefined || coverage < floor) result.push({ name, floor, coverage });
    }
    return result;
}

function describeBreach(breach: Breach): string {
    return breach.coverage === undefined
        ? `${breach.name} has no coverage data`
        : `${breach.name} is at ${breach.coverage.toFixed(2)}%, under its ${breach.floor}% floor`;
}

function cells(tally: Tally): string[] {
    return [
        tally.name,
        String(tally.files),
        `${tally.hit} / ${tally.found}`,
        `${percent(tally).toFixed(2)}%`,
    ];
}

function floorCell(name: string, floors: Readonly<Record<string, number>>): string {
    if (name === "total") return "";
    const floor = floors[name];
    return floor === undefined ? "none" : `${floor}%`;
}

export function markdown(
    counts: TestCounts | undefined,
    summary: Summary,
    floors: Readonly<Record<string, number>>,
): string {
    const lines = ["### Tests", ""];
    if (counts) {
        const passed = counts.tests - counts.failures - counts.skipped;
        lines.push(
            `${counts.tests} tests: ${passed} passed, ${counts.failures} failed, ${counts.skipped} skipped`,
        );
    } else {
        lines.push("No junit report was written.");
    }
    lines.push("", "### Line coverage of src/", "");
    if (summary.total.found === 0) {
        lines.push("No coverage data was written.");
        return `${lines.join("\n")}\n`;
    }
    lines.push(
        "| Directory | Files | Lines hit | Coverage | Floor |",
        "| --- | ---: | ---: | ---: | ---: |",
    );
    for (const row of [...summary.rows, summary.total]) {
        lines.push(`| ${[...cells(row), floorCell(row.name, floors)].join(" | ")} |`);
    }
    const failed = breaches(summary, floors);
    const verdict =
        failed.length === 0
            ? "Every directory with a floor passes it."
            : `Coverage fails: ${failed.map(describeBreach).join("; ")}.`;
    lines.push(
        "",
        verdict,
        "",
        "Bun counts lines and functions, not branches, and only in files a test loads; code that runs",
        "only inside a spawned daemon is not counted. src/client has no floor: its tests load UI",
        "modules whose render paths are covered by browser checks and e2e, not unit tests.",
    );
    return `${lines.join("\n")}\n`;
}

export function plain(counts: TestCounts | undefined, summary: Summary): string {
    const rows = [...summary.rows, summary.total].map((row) => {
        const [name, files, lines, pct] = cells(row);
        return `  ${name!.padEnd(12)} ${files!.padStart(3)} files  ${lines!.padStart(13)}  ${pct!.padStart(7)}`;
    });
    const tests = counts
        ? `tests: ${counts.tests}, ${counts.failures} failed, ${counts.skipped} skipped`
        : "tests: no junit report";
    return [tests, "line coverage of src/:", ...rows].join("\n");
}

function read(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function main(): Promise<number> {
    const scratch = mkdtempSync(join(tmpdir(), "margin-coverage-"));
    try {
        const junit = join(scratch, "junit.xml");
        const run = Bun.spawn(
            [
                "bun",
                "test",
                "--coverage",
                "--coverage-reporter=lcov",
                `--coverage-dir=${scratch}`,
                "--reporter=junit",
                `--reporter-outfile=${junit}`,
            ],
            { cwd: join(import.meta.dir, ".."), stdio: ["inherit", "inherit", "inherit"] },
        );
        const code = await run.exited;
        const counts = parseJunit(read(junit));
        const summary = summarize(parseLcov(read(join(scratch, "lcov.info"))));
        console.log(`\n${plain(counts, summary)}`);
        const stepSummary = process.env.GITHUB_STEP_SUMMARY;
        if (stepSummary) appendFileSync(stepSummary, markdown(counts, summary, FLOORS));

        if (code !== 0) return code;
        if (summary.total.found === 0) {
            console.error("coverage: no lcov data for src/");
            return 1;
        }
        const failed = breaches(summary, FLOORS);
        for (const breach of failed) console.error(`coverage: ${describeBreach(breach)}`);
        if (failed.length > 0) return 1;
        const passed = Object.entries(FLOORS).map(([name, floor]) => {
            const row = summary.rows.find((row) => row.name === name)!;
            return `${name} ${percent(row).toFixed(2)}% (floor ${floor}%)`;
        });
        console.log(`coverage: ${passed.join(", ")}; src/client has no floor`);
        return 0;
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

if (import.meta.main) process.exit(await main());
