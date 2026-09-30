import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockTimeoutError, withLock } from "./lock.ts";

const LOCK_MODULE = join(import.meta.dir, "lock.ts");

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "margin-lock-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

async function spawnHolder(lockPath: string): Promise<Bun.Subprocess<"ignore", "pipe", "inherit">> {
    const script = join(dir, "holder.ts");
    writeFileSync(
        script,
        `import { withLock } from ${JSON.stringify(LOCK_MODULE)};
await withLock(${JSON.stringify(lockPath)}, async () => {
    console.log("held");
    await Bun.sleep(60_000);
});
`,
    );
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(value)).toContain("held");
    return child;
}

describe("withLock", () => {
    test("serializes callers in one process", async () => {
        const lockPath = join(dir, "a.lock");
        let inside = 0;
        let overlap = false;
        await Promise.all(
            Array.from({ length: 10 }, async () =>
                withLock(lockPath, async () => {
                    inside++;
                    overlap ||= inside > 1;
                    await Bun.sleep(2);
                    inside--;
                }),
            ),
        );
        expect(overlap).toBe(false);
    });

    test("20 processes never interleave a read-modify-write", async () => {
        const lockPath = join(dir, "a.lock");
        const counter = join(dir, "counter");
        writeFileSync(counter, "0");
        const script = join(dir, "worker.ts");
        writeFileSync(
            script,
            `import { readFileSync, writeFileSync } from "node:fs";
import { withLock } from ${JSON.stringify(LOCK_MODULE)};
for (let i = 0; i < 10; i++) {
    await withLock(${JSON.stringify(lockPath)}, async () => {
        const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
        await Bun.sleep(1);
        writeFileSync(${JSON.stringify(counter)}, String(n + 1));
    }, { timeoutMs: 30_000 });
}
`,
        );
        const children = Array.from({ length: 20 }, () =>
            Bun.spawn([process.execPath, script], { stdout: "inherit", stderr: "inherit" }),
        );
        const codes = await Promise.all(children.map(async (child) => await child.exited));
        expect(codes.every((code) => code === 0)).toBe(true);
        expect(readFileSync(counter, "utf8")).toBe("200");
    }, 60_000);

    test("a killed holder releases the lock", async () => {
        const lockPath = join(dir, "a.lock");
        const child = await spawnHolder(lockPath);
        await expect(withLock(lockPath, () => 1, { timeoutMs: 50 })).rejects.toBeInstanceOf(
            LockTimeoutError,
        );
        child.kill("SIGKILL");
        await child.exited;
        expect(await withLock(lockPath, () => "acquired", { timeoutMs: 2_000 })).toBe("acquired");
    }, 20_000);

    test("releases after the callback throws", async () => {
        const lockPath = join(dir, "a.lock");
        await expect(
            withLock(lockPath, () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        expect(await withLock(lockPath, () => "again", { timeoutMs: 100 })).toBe("again");
    });
});
