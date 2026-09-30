// Runs the suite once with line coverage and a junit report, prints test counts and line coverage of
// src/ per directory, and fails when the total drops below FLOOR. In CI the same table goes to the
// job summary. Bun's own coverageThreshold applies per file, so the total is summed here from lcov.
import { existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Whole percent, set at the measured total rounded down (86.72% at W6a). */
export const FLOOR = 86;

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

function cells(tally: Tally): string[] {
    return [
        tally.name,
        String(tally.files),
        `${tally.hit} / ${tally.found}`,
        `${percent(tally).toFixed(2)}%`,
    ];
}

export function markdown(counts: TestCounts | undefined, summary: Summary, floor: number): string {
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
    lines.push("| Directory | Files | Lines hit | Coverage |", "| --- | ---: | ---: | ---: |");
    for (const row of [...summary.rows, summary.total]) lines.push(`| ${cells(row).join(" | ")} |`);
    const verdict = percent(summary.total) >= floor ? "passes" : "fails";
    lines.push(
        "",
        `The total ${verdict} the ${floor}% floor. Bun counts lines and functions, not branches, and`,
        "only in files a test loads; code that runs only inside a spawned daemon is not counted.",
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
        if (stepSummary) appendFileSync(stepSummary, markdown(counts, summary, FLOOR));

        if (code !== 0) return code;
        if (summary.total.found === 0) {
            console.error("coverage: no lcov data for src/");
            return 1;
        }
        const total = percent(summary.total);
        if (total < FLOOR) {
            console.error(
                `coverage: ${total.toFixed(2)}% of src/ lines is below the ${FLOOR}% floor`,
            );
            return 1;
        }
        console.log(`coverage: ${total.toFixed(2)}%, floor ${FLOOR}%`);
        return 0;
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

if (import.meta.main) process.exit(await main());
