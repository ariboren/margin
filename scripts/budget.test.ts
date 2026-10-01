import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import defaultCeilings from "../budget.json";
import { decodeSource } from "../src/core/blocks.ts";
import {
    editAllowance,
    measure,
    pendingBlocks,
    report,
    samples,
    shape,
    type Ceilings,
} from "./budget.ts";

const publicSource = decodeSource(readFileSync(samples.public));
const hasPrivate = existsSync(samples.private);
const measured = await measure(publicSource);

/** Spawning a bun process can take seconds under coverage instrumentation. */
const SUBPROCESS_TIMEOUT_MS = 30_000;

function runScript(...args: string[]): { code: number; stdout: string } {
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "budget.ts"), ...args], {
        cwd: join(import.meta.dir, ".."),
    });
    return { code: result.exitCode, stdout: result.stdout.toString() };
}

describe("budget on the public sample", () => {
    test("measures every op from real CLI output and stays within every ceiling", () => {
        const result = report(measured, publicSource);
        expect(result.rows.filter((row) => row.bytes === undefined)).toEqual([]);
        expect(result.rows.filter((row) => row.over)).toEqual([]);
        expect(result.breached).toBe(false);
    });

    test("every batch wakes one compact line and goes through pending", () => {
        expect(measured.lines.map((line) => line.match(/c\d+/g))).toEqual([
            ["c1", "c2"],
            ["c3", "c4", "c5"],
            ["c6", "c7", "c8", "c9", "c10"],
        ]);
        for (const line of measured.lines) expect(line).toMatch(/^new( c\d+)+( "[^"]*")?\n$/);
        expect(measured.ops.filter((op) => op.name.startsWith("ack"))).toHaveLength(10);
        expect(measured.ops.filter((op) => op.name.startsWith("pending batch"))).toHaveLength(3);
    });

    test("the doc's status is measured: every watch word and the pending header", () => {
        const ids = Array.from({ length: 10 }, (_, index) => ` c${index + 1}`).join("");
        expect(measured.statusLines).toEqual([
            "approved\n",
            `dropped | new${ids}\n`,
            `finish${ids}\n`,
            "approved\n",
            "reopened\n",
        ]);
        const status = measured.ops.filter((op) => /^watch (?!batch)/.test(op.name));
        expect(status.map((op) => op.stdout)).toEqual(measured.statusLines);
        for (const op of status) expect(op.keys).toContain("watch");
        expect(measured.headed.map((read) => read.slice(0, read.indexOf("\n")))).toEqual([
            "approved",
            "finish",
        ]);
        // The approval ends the loop, so its line and header count toward the loop's total.
        expect(measured.ops.find((op) => op.name === "pending approved")).toMatchObject({
            keys: ["fullLoopTenThreads"],
            stdout: "approved\n",
        });
        expect(measured.ops.filter((op) => op.name.startsWith("finish ack"))).toHaveLength(10);
        expect(measured.finishBytes).toBeGreaterThan(0);
    });

    test("a status line over the watch ceiling breaches it", () => {
        const widest = Math.max(...measured.statusLines.map((line) => line.length));
        const result = report(measured, publicSource, { ...defaultCeilings, watch: widest - 1 });
        expect(result.rows.filter((row) => row.over).map((row) => row.key)).toEqual(["watch"]);
    });

    test("user edits ride along with the first pending only", () => {
        const reads = measured.ops.filter((op) => op.name.startsWith("pending batch"));
        expect(reads.map((op) => op.stdout.includes("\nedit L"))).toEqual([true, false, false]);
    });

    test("every ack is one short line", () => {
        const acks = measured.ops.filter((op) => op.name.startsWith("ack"));
        for (const op of acks) expect(op.stdout).toMatch(/^ok c\d+ (replied|resolved)\n$/);
    });

    test("seeds reach table cells with header and row context", () => {
        expect(measured.cellThreads).toBeGreaterThanOrEqual(3);
    });

    test("pending text is smaller than its JSON", () => {
        expect(measured.pendingBytes.text).toBeLessThan(measured.pendingBytes.json);
    });

    test("pending output splits into one block per thread or edit", () => {
        expect(pendingBlocks("c1 open L1 A\n  [[x]]\n  user: hi\nedit L2 B\n  a {+b+}\n")).toEqual([
            "c1 open L1 A\n  [[x]]\n  user: hi",
            "edit L2 B\n  a {+b+}",
        ]);
    });
});

describe("user edit allowance", () => {
    test("a two-hunk edit gets the base plus one extra hunk plus its changed words", () => {
        const edit = measured.ops.find((op) => op.edit?.hunks === 2);
        expect(edit).toBeDefined();
        expect(editAllowance(edit!, defaultCeilings)).toBe(
            edit!.edit!.changedBytes + defaultCeilings.pendingEditExtraHunk,
        );
    });

    test("a one-hunk edit gets no extra-hunk allowance", () => {
        const edit = measured.ops.find((op) => op.edit?.hunks === 1);
        expect(editAllowance(edit!, defaultCeilings)).toBe(edit!.edit!.changedBytes);
    });

    test("every user edit op carries its size", () => {
        const edits = measured.ops.filter((op) => op.name.startsWith("pending edit"));
        expect(edits).toHaveLength(3);
        for (const op of edits) expect(op.edit).toBeDefined();
    });

    test("the extra-hunk allowance is a parameter, not a row of its own", () => {
        expect(report(measured, publicSource).rows.map((row) => row.key)).not.toContain(
            "pendingEditExtraHunk",
        );
    });
});

describe("breach", () => {
    test("an injected ceiling below a measurement breaches that key only", () => {
        const ceilings: Ceilings = { ...defaultCeilings, ack: 5 };
        const result = report(measured, publicSource, ceilings);
        expect(result.breached).toBe(true);
        expect(result.rows.filter((row) => row.over).map((row) => row.key)).toEqual(["ack"]);
    });

    test(
        "the script exits non-zero on a breach and zero otherwise",
        () => {
            const dir = mkdtempSync(join(tmpdir(), "margin-budget-"));
            try {
                const path = join(dir, "budget.json");
                writeFileSync(path, JSON.stringify({ ...defaultCeilings, pendingThreadMax: 10 }));
                const breached = runScript("--sample", "public", "--ceilings", path);
                expect(breached.code).toBe(1);
                expect(breached.stdout).toMatch(/pendingThreadMax\s+\d+ \/\s+10 B {2}OVER/);
                expect(runScript("--sample=public").code).toBe(0);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        },
        SUBPROCESS_TIMEOUT_MS,
    );
});

describe("public sample shape", () => {
    test("long one-line paragraphs, wide tables, code spans and fences", () => {
        const stats = shape(publicSource);
        expect(stats.paragraphMean).toBeGreaterThan(400);
        expect(stats.paragraphMax).toBeGreaterThan(1500);
        expect(stats.tableRowMean).toBeGreaterThan(600);
        expect(stats.codeSpans / (stats.bytes / 1024)).toBeGreaterThan(3);
        expect(stats.fences).toBeGreaterThanOrEqual(3);
    });
});

describe.skipIf(!hasPrivate)("private sample", () => {
    test(
        "bun run budget:private passes every ceiling, and its output is numbers only",
        () => {
            const sample = decodeSource(readFileSync(samples.private))
                .toLowerCase()
                .replace(/\s+/g, " ");
            const script = Bun.spawnSync(["bun", "run", "budget:private"], {
                cwd: join(import.meta.dir, ".."),
            });
            const stdout = script.stdout.toString();
            expect(stdout).toContain("sample: private");
            expect(stdout).not.toContain("OVER");
            expect(script.exitCode).toBe(0);
            const tokens = stdout.toLowerCase().split(/\s+/).filter(Boolean);
            const leaked = tokens
                .slice(0, -3)
                .map((_, i) => tokens.slice(i, i + 4).join(" "))
                .filter((run) => sample.includes(run));
            expect(leaked).toEqual([]);
        },
        SUBPROCESS_TIMEOUT_MS,
    );

    test(
        "a breach on the private sample exits non-zero",
        () => {
            const dir = mkdtempSync(join(tmpdir(), "margin-budget-"));
            try {
                const path = join(dir, "budget.json");
                writeFileSync(path, JSON.stringify({ ...defaultCeilings, pendingEditBase: 10 }));
                const breached = runScript("--sample", "private", "--ceilings", path);
                expect(breached.stdout).toMatch(/pendingEditBase\s+\d+ \/\s+10 B {2}OVER/);
                expect(breached.code).toBe(1);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        },
        SUBPROCESS_TIMEOUT_MS,
    );
});
