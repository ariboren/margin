import { describe, expect, test } from "bun:test";
import {
    FLOORS,
    breaches,
    inScope,
    markdown,
    parseJunit,
    parseLcov,
    percent,
    summarize,
    type FileCoverage,
} from "./coverage.ts";

const lcov = [
    "TN:",
    "SF:src/core/anchor.ts",
    "FNF:2",
    "FNH:2",
    "DA:1,1",
    "LF:200",
    "LH:190",
    "end_of_record",
    "TN:",
    "SF:src/core/log.ts",
    "LF:100",
    "LH:100",
    "end_of_record",
    "TN:",
    "SF:src/client/links.ts",
    "LF:50",
    "LH:10",
    "end_of_record",
    "TN:",
    "SF:src/cli/testing.ts",
    "LF:40",
    "LH:0",
    "end_of_record",
    "TN:",
    "SF:scripts/budget.ts",
    "LF:300",
    "LH:0",
    "end_of_record",
    "",
].join("\n");

describe("parseLcov", () => {
    test("reads lines found and hit per file", () => {
        expect(parseLcov(lcov).slice(0, 2)).toEqual([
            { path: "src/core/anchor.ts", found: 200, hit: 190 },
            { path: "src/core/log.ts", found: 100, hit: 100 },
        ]);
        expect(parseLcov(lcov)).toHaveLength(5);
    });

    test("drops a record without end_of_record", () => {
        expect(parseLcov("SF:src/a.ts\nLF:3\nLH:1\n")).toEqual([]);
    });
});

describe("inScope", () => {
    test("keeps shipped src files and drops tests, helpers and other dirs", () => {
        expect(inScope("src/core/anchor.ts")).toBe(true);
        expect(inScope("src/client/components/margin-rail.tsx")).toBe(true);
        expect(inScope("src/core/anchor.test.ts")).toBe(false);
        expect(inScope("src/cli/testing.ts")).toBe(false);
        expect(inScope("src/core/testing.ts")).toBe(false);
        expect(inScope("src/server/dev-open.ts")).toBe(false);
        expect(inScope("scripts/budget.ts")).toBe(false);
        expect(inScope("mockup/seed.ts")).toBe(false);
    });
});

describe("summarize", () => {
    test("sums lines, not per-file percentages, and groups by directory", () => {
        const summary = summarize(parseLcov(lcov));
        expect(summary.total).toEqual({ name: "total", files: 3, found: 350, hit: 300 });
        expect(summary.rows.map((row) => [row.name, row.files, row.hit, row.found])).toEqual([
            ["src/client", 1, 10, 50],
            ["src/core", 2, 290, 300],
        ]);
        expect(percent(summary.total)).toBeCloseTo(85.714, 3);
    });

    test("an empty report has no lines", () => {
        const files: FileCoverage[] = [];
        expect(summarize(files).total.found).toBe(0);
    });
});

describe("parseJunit", () => {
    test("reads the totals from the testsuites element", () => {
        const xml =
            '<?xml version="1.0"?>\n<testsuites name="bun test" tests="380" assertions="9" failures="2" skipped="5" time="1">\n<testsuite tests="3" failures="0" skipped="0">';
        expect(parseJunit(xml)).toEqual({ tests: 380, failures: 2, skipped: 5 });
    });

    test("returns undefined without a report", () => {
        expect(parseJunit("")).toBeUndefined();
    });
});

describe("breaches", () => {
    const summary = summarize(parseLcov(lcov));

    test("passes when every floored directory meets its floor, whatever an unfloored one is at", () => {
        expect(breaches(summary, { "src/core": 96 })).toEqual([]);
    });

    test("names a floored directory under its floor", () => {
        const [breach] = breaches(summary, { "src/core": 97 });
        expect(breach?.name).toBe("src/core");
        expect(breach?.floor).toBe(97);
        expect(breach?.coverage).toBeCloseTo(96.667, 3);
    });

    test("a floored directory missing from the report breaches", () => {
        expect(breaches(summary, { "src/core": 96, "src/server": 50 })).toEqual([
            { name: "src/server", floor: 50, coverage: undefined },
        ]);
    });
});

describe("FLOORS", () => {
    test("floors cli, core and server in whole percents and leaves the client unfloored", () => {
        expect(Object.keys(FLOORS).sort()).toEqual(["src/cli", "src/core", "src/server"]);
        for (const floor of Object.values(FLOORS)) expect(Number.isInteger(floor)).toBe(true);
    });
});

describe("markdown", () => {
    const summary = summarize(parseLcov(lcov));

    test("shows test counts, a row per directory with its floor, and the total", () => {
        const text = markdown({ tests: 10, failures: 1, skipped: 2 }, summary, { "src/core": 96 });
        expect(text).toContain("10 tests: 7 passed, 1 failed, 2 skipped");
        expect(text).toContain("| src/core | 2 | 290 / 300 | 96.67% | 96% |");
        expect(text).toContain("| src/client | 1 | 10 / 50 | 20.00% | none |");
        expect(text).toContain("| total | 3 | 300 / 350 | 85.71% |  |");
        expect(text).toContain("Every directory with a floor passes it.");
    });

    test("names each directory under its floor", () => {
        const text = markdown(undefined, summary, { "src/core": 97, "src/server": 80 });
        expect(text).toContain(
            "Coverage fails: src/core is at 96.67%, under its 97% floor; src/server has no coverage data.",
        );
    });
});
