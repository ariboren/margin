import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWatching, watcherFile, withPresence } from "./presence.ts";

const CLI = join(import.meta.dir, "..", "cli", "main.ts");

let dir: string;
let doc: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "margin-presence-"));
    doc = join(dir, "doc.md");
    writeFileSync(doc, "# Doc\n\nText.\n");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Waits on a condition, not a clock: a loaded machine only makes it slower, never wrong. */
async function until(check: () => boolean, what: string, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await Bun.sleep(10);
    }
}

/** Spawning a bun process can take seconds under a full parallel run. */
const SUBPROCESS_TIMEOUT_MS = 30_000;

describe("presence file", () => {
    test("held for the life of the callback, then removed", async () => {
        expect(agentWatching(doc)).toBe(false);
        await withPresence(doc, async () => {
            expect(existsSync(watcherFile(doc))).toBe(true);
            expect(agentWatching(doc)).toBe(true);
        });
        expect(existsSync(watcherFile(doc))).toBe(false);
        expect(agentWatching(doc)).toBe(false);
    });

    test("a missing doc gets no presence file and no .margin/", async () => {
        const missing = join(dir, "nope", "doc.md");
        mkdirSync(join(dir, "nope"));
        await withPresence(missing, async () => {
            expect(existsSync(join(dir, "nope", ".margin"))).toBe(false);
        });
        expect(agentWatching(missing)).toBe(false);
    });

    test("a stale pid counts as not watching", async () => {
        const dead = Bun.spawn(["true"]);
        await dead.exited;
        mkdirSync(join(dir, ".margin"), { recursive: true });
        writeFileSync(watcherFile(doc), `${dead.pid}\n`);
        expect(agentWatching(doc)).toBe(false);
        writeFileSync(watcherFile(doc), "not a pid\n");
        expect(agentWatching(doc)).toBe(false);
    });

    test("a newer watcher's file is left alone by an older one exiting", async () => {
        await withPresence(doc, async () => {
            writeFileSync(watcherFile(doc), "1\n");
        });
        expect(existsSync(watcherFile(doc))).toBe(true);
    });

    for (const [args, signal] of [
        [["watch"], "SIGTERM"],
        [["watch"], "SIGINT"],
        [["pending", "--wait"], "SIGTERM"],
    ] as const) {
        test(
            `margin ${args.join(" ")} holds it and drops it on ${signal}`,
            async () => {
                const proc = Bun.spawn(["bun", CLI, ...args, doc], {
                    stdout: "ignore",
                    stderr: "ignore",
                });
                try {
                    await until(() => {
                        if (proc.exitCode !== null) {
                            throw new Error(`watcher exited early with ${proc.exitCode}`);
                        }
                        return agentWatching(doc);
                    }, "the presence file");
                    proc.kill(signal);
                    await proc.exited;
                    expect(proc.signalCode).toBe(signal);
                    expect(existsSync(watcherFile(doc))).toBe(false);
                    expect(agentWatching(doc)).toBe(false);
                } finally {
                    proc.kill("SIGKILL");
                }
            },
            SUBPROCESS_TIMEOUT_MS,
        );
    }
});
