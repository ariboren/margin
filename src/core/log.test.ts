import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    appendFileSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvents, readLog, readSince, sidecar, transact } from "./log.ts";

const LOG_MODULE = join(import.meta.dir, "log.ts");

let dir: string;
let doc: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "margin-log-"));
    doc = join(dir, "doc.md");
    writeFileSync(doc, "# Doc\n");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("sidecar", () => {
    test("lives in .margin beside the doc", () => {
        const paths = sidecar(doc);
        expect(paths.log).toEndWith(join(".margin", "doc.md.jsonl"));
        expect(paths.lock).toEndWith(join(".margin", "doc.md.lock"));
    });

    test("a symlinked doc shares the target's sidecar", () => {
        mkdirSync(join(dir, "links"));
        const link = join(dir, "links", "alias.md");
        symlinkSync(doc, link);
        expect(sidecar(link).log).toBe(sidecar(doc).log);
    });
});

describe("append and read", () => {
    test("a missing log reads as empty", async () => {
        expect(await readLog(doc)).toEqual({ events: [], offset: 0 });
    });

    test("assigns seq and at in order", async () => {
        const stored = await appendEvents(doc, [
            { type: "hold", by: "user", on: true },
            { type: "hold", by: "user", on: false },
        ]);
        expect(stored.map((event) => event.seq)).toEqual([1, 2]);
        expect(Number.isNaN(Date.parse(stored[0]!.at))).toBe(false);
        const [third] = await appendEvents(doc, [{ type: "hold", by: "user", on: true }]);
        expect(third!.seq).toBe(3);
        expect((await readLog(doc)).events).toEqual([...stored, third!]);
    });

    test("tails from an offset and by seq", async () => {
        await appendEvents(doc, [{ type: "hold", by: "user", on: true }]);
        const first = await readLog(doc);
        await appendEvents(doc, [{ type: "hold", by: "user", on: false }]);
        const tail = await readLog(doc, first.offset);
        expect(tail.events.map((event) => event.seq)).toEqual([2]);
        expect(tail.offset).toBe(statSync(sidecar(doc).log).size);
        expect((await readSince(doc, 1)).map((event) => event.seq)).toEqual([2]);
    });

    test("transact sees events appended earlier in the same transaction", async () => {
        const seen = await transact(doc, (txn) => {
            txn.append([{ type: "hold", by: "user", on: true }]);
            return txn.events.length;
        });
        expect(seen).toBe(1);
    });

    test("a torn last line is ignored, then cut before the next append", async () => {
        await appendEvents(doc, [
            { type: "hold", by: "user", on: true },
            { type: "hold", by: "user", on: false },
        ]);
        // Raw bytes on purpose: this simulates a crash mid-append (the one sanctioned exception).
        appendFileSync(sidecar(doc).log, '{"seq":3,"at":"2026-09-30T00:');
        const torn = await readLog(doc);
        expect(torn.events.map((event) => event.seq)).toEqual([1, 2]);
        expect(torn.offset).toBeLessThan(statSync(sidecar(doc).log).size);

        const [next] = await appendEvents(doc, [{ type: "hold", by: "user", on: true }]);
        expect(next!.seq).toBe(3);
        const healed = await readLog(doc);
        expect(healed.events.map((event) => event.seq)).toEqual([1, 2, 3]);
        expect(healed.offset).toBe(statSync(sidecar(doc).log).size);
    });

    test("20 processes appending concurrently lose no event", async () => {
        const perWorker = 10;
        const workers = 20;
        const script = join(dir, "worker.ts");
        writeFileSync(
            script,
            `import { appendEvents } from ${JSON.stringify(LOG_MODULE)};
const worker = Number(process.argv[2]);
for (let i = 0; i < ${perWorker}; i++) {
    await appendEvents(${JSON.stringify(doc)}, [
        { type: "cursor", by: "agent", stream: "watch", upTo: worker * 1000 + i },
    ], { timeoutMs: 30_000 });
}
`,
        );
        const children = Array.from({ length: workers }, (_, worker) =>
            Bun.spawn([process.execPath, script, String(worker)], {
                stdout: "inherit",
                stderr: "inherit",
            }),
        );
        const codes = await Promise.all(children.map(async (child) => await child.exited));
        expect(codes.every((code) => code === 0)).toBe(true);

        const { events } = await readLog(doc);
        expect(events.map((event) => event.seq)).toEqual(
            Array.from({ length: workers * perWorker }, (_, i) => i + 1),
        );
        const marks = new Set(events.map((event) => (event.type === "cursor" ? event.upTo : -1)));
        expect(marks.size).toBe(workers * perWorker);
    }, 60_000);
});
