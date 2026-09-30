// Dev tool: opens a doc through the daemon, and times cold and warm opens.
//   bun src/server/dev-open.ts open <doc> [--no-tab]
//   bun src/server/dev-open.ts bench <doc> [--runs 10] [--tab]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDoc, stopDaemon } from "./api.ts";

async function open(doc: string, tab: boolean): Promise<void> {
    const result = await openDoc(doc, { openTab: tab });
    console.log(result.url);
}

async function timeOpen(
    doc: string,
    env: Record<string, string | undefined>,
    tab: boolean,
): Promise<number> {
    const started = performance.now();
    const proc = Bun.spawn(
        [process.execPath, import.meta.path, "open", doc, ...(tab ? [] : ["--no-tab"])],
        { env, stdout: "ignore", stderr: "inherit" },
    );
    if ((await proc.exited) !== 0) {
        throw new Error("open failed");
    }
    return performance.now() - started;
}

function summary(label: string, samples: number[]): string {
    const sorted = samples.toSorted((a, b) => a - b);
    const p50 = sorted[Math.floor((sorted.length - 1) / 2)]!;
    return `${label}: p50 ${p50.toFixed(0)} ms, max ${sorted.at(-1)!.toFixed(0)} ms (n=${sorted.length})`;
}

async function bench(doc: string, runs: number, tab: boolean): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "margin-bench-"));
    const env = { ...process.env, MARGIN_STATE_DIR: dir };
    try {
        const cold: number[] = [];
        const warm: number[] = [];
        for (let i = 0; i < runs; i++) {
            await stopDaemon({ env });
            cold.push(await timeOpen(doc, env, tab));
            warm.push(await timeOpen(doc, env, tab));
        }
        const mode = tab ? "with tab" : "without tab";
        console.log(summary(`cold, ${mode}`, cold));
        console.log(summary(`warm, ${mode}`, warm));
    } finally {
        await stopDaemon({ env });
        rmSync(dir, { recursive: true, force: true });
    }
}

const [command, doc, ...rest] = process.argv.slice(2);
if (!doc || (command !== "open" && command !== "bench")) {
    console.error("usage: dev-open.ts open|bench <doc> [--no-tab] [--tab] [--runs N]");
    process.exit(2);
}
if (command === "open") {
    await open(doc, !rest.includes("--no-tab"));
} else {
    const runsAt = rest.indexOf("--runs");
    const runs = runsAt === -1 ? 10 : Number(rest[runsAt + 1]);
    await bench(doc, runs, rest.includes("--tab"));
}
