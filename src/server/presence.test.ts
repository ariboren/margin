import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentIdentity } from "../core/model.ts";
import {
    connectedAgents,
    holdPresence,
    legacyWatcherFile,
    watchersDir,
    withPresence,
} from "./presence.ts";

const FOREMAN: AgentIdentity = { name: "foreman", client: "claude-code" };
const UNKNOWN: AgentIdentity = { name: "Agent", client: "unknown" };

/** True while any registered pid is alive. */
function agentWatching(docPath: string): boolean {
    return connectedAgents(docPath).length > 0;
}

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

/** Registered entries, `<pid>-<seq>` each. */
function entries(): string[] {
    try {
        return readdirSync(watchersDir(doc));
    } catch {
        return [];
    }
}

function entriesOf(pid: number): string[] {
    return entries().filter((name) => name.startsWith(`${pid}-`));
}

async function deadPid(): Promise<number> {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    return dead.pid;
}

type Watcher = ReturnType<typeof spawnWatch>;

function spawnWatch(args: readonly string[] = ["watch"]) {
    return Bun.spawn(["bun", CLI, ...args, doc], {
        env: { ...process.env, MARGIN_STATE_DIR: join(dir, "state") },
        stdout: "ignore",
        stderr: "ignore",
    });
}

/** Waits until the watcher has registered, failing fast if it exits first. */
async function registered(proc: Watcher): Promise<void> {
    await until(() => {
        if (proc.exitCode !== null) {
            throw new Error(`watcher exited early with ${proc.exitCode}`);
        }
        return entriesOf(proc.pid).length > 0;
    }, "the watcher entry");
}

/** Spawning a bun process can take seconds under a full parallel run. */
const SUBPROCESS_TIMEOUT_MS = 30_000;

describe("presence", () => {
    test("held for the life of the callback, then removed", async () => {
        expect(connectedAgents(doc)).toEqual([]);
        await withPresence(doc, FOREMAN, async () => {
            expect(entriesOf(process.pid)).toHaveLength(1);
            expect(connectedAgents(doc)).toEqual([FOREMAN]);
            expect(agentWatching(doc)).toBe(true);
        });
        expect(entries()).toEqual([]);
        expect(agentWatching(doc)).toBe(false);
    });

    test("the entry holds the identity as JSON, with no draft left beside it", async () => {
        await withPresence(doc, FOREMAN, async () => {
            const [name] = entriesOf(process.pid);
            expect(JSON.parse(readFileSync(join(watchersDir(doc), name!), "utf8"))).toEqual(
                FOREMAN,
            );
            expect(entries().filter((entry) => entry.startsWith("."))).toEqual([]);
        });
    });

    test("distinct agents are listed once each; the same agent twice counts once", async () => {
        const reviewer: AgentIdentity = { name: "reviewer", client: "codex" };
        await withPresence(doc, FOREMAN, async () => {
            await withPresence(doc, reviewer, async () => {
                await withPresence(doc, FOREMAN, async () => {
                    expect(connectedAgents(doc)).toEqual([FOREMAN, reviewer]);
                });
            });
        });
    });

    test("an empty or garbled entry of a live pid reads as an unknown agent", async () => {
        mkdirSync(watchersDir(doc), { recursive: true });
        const entry = join(watchersDir(doc), `${process.pid}-7`);
        writeFileSync(entry, "");
        expect(connectedAgents(doc)).toEqual([UNKNOWN]);
        writeFileSync(entry, "{not json");
        expect(connectedAgents(doc)).toEqual([UNKNOWN]);
        writeFileSync(entry, '"foreman"');
        expect(connectedAgents(doc)).toEqual([UNKNOWN]);
    });

    test("a half-formed entry keeps the field it has and fills the other", async () => {
        mkdirSync(watchersDir(doc), { recursive: true });
        const entry = join(watchersDir(doc), `${process.pid}-7`);
        writeFileSync(entry, '{"name":"x"}');
        expect(connectedAgents(doc)).toEqual([{ name: "x", client: "unknown" }]);
        writeFileSync(entry, '{"name":"","client":"codex"}');
        expect(connectedAgents(doc)).toEqual([{ name: "Codex", client: "codex" }]);
    });

    test("a hostile entry reaches the page as a known client and a string name", async () => {
        mkdirSync(watchersDir(doc), { recursive: true });
        const entry = join(watchersDir(doc), `${process.pid}-7`);
        for (const client of ["toString", "__proto__", "constructor"]) {
            writeFileSync(entry, JSON.stringify({ name: "ghost", client }));
            expect(connectedAgents(doc)).toEqual([{ name: "ghost", client: "unknown" }]);
        }
        writeFileSync(entry, '{"__proto__":{"name":"ghost","client":"codex"}}');
        expect(connectedAgents(doc)).toEqual([UNKNOWN]);
        writeFileSync(entry, '{"name":{"call":1},"client":"codex"}');
        expect(connectedAgents(doc)).toEqual([{ name: "Codex", client: "codex" }]);
        writeFileSync(entry, '{"name":42,"client":"cursor"}');
        expect(connectedAgents(doc)).toEqual([{ name: "Cursor", client: "cursor" }]);
        writeFileSync(entry, JSON.stringify({ name: "n".repeat(500), client: "codex" }));
        expect(connectedAgents(doc)[0]!.name).toBe("n".repeat(200));
    });

    test("a missing doc gets no entry and no .margin/", async () => {
        const missing = join(dir, "nope", "doc.md");
        mkdirSync(join(dir, "nope"));
        await withPresence(missing, FOREMAN, async () => {
            expect(existsSync(join(dir, "nope", ".margin"))).toBe(false);
        });
        expect(agentWatching(missing)).toBe(false);
    });

    test("overlapping registrations in one process each release only their own", async () => {
        let releaseFirst = () => {};
        const first = withPresence(doc, FOREMAN, async () => {
            await new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
        });
        await withPresence(doc, FOREMAN, async () => {
            expect(entriesOf(process.pid)).toHaveLength(2);
        });
        expect(entriesOf(process.pid)).toHaveLength(1);
        expect(agentWatching(doc)).toBe(true);
        releaseFirst();
        await first;
        expect(agentWatching(doc)).toBe(false);
    });

    test("many docs held at once share one set of process listeners", () => {
        const signals = ["SIGINT", "SIGTERM", "SIGHUP", "exit"] as const;
        const count = () => signals.map((signal) => process.listenerCount(signal));
        const before = count();
        const docs = Array.from({ length: 12 }, (_, index) => {
            const path = join(dir, `doc-${index}.md`);
            writeFileSync(path, "# Doc\n");
            return path;
        });
        const holds = docs.map((path) => holdPresence(path, FOREMAN));
        expect(count()).toEqual(before.map((listeners) => listeners + 1));
        expect(docs.map((path) => connectedAgents(path))).toEqual(docs.map(() => [FOREMAN]));
        holds[0]!.release();
        holds[0]!.release();
        expect(connectedAgents(docs[0]!)).toEqual([]);
        expect(connectedAgents(docs[1]!)).toEqual([FOREMAN]);
        expect(count()).toEqual(before.map((listeners) => listeners + 1));
        for (const hold of holds) hold.release();
        expect(count()).toEqual(before);
        expect(docs.flatMap((path) => connectedAgents(path))).toEqual([]);
    });

    test("renew writes the entry again once a deleted .margin/ is back, and never brings it back itself", () => {
        const hold = holdPresence(doc, FOREMAN);
        try {
            rmSync(join(dir, ".margin"), { recursive: true, force: true });
            hold.renew();
            expect(existsSync(join(dir, ".margin"))).toBe(false);
            mkdirSync(join(dir, ".margin"));
            hold.renew();
            expect(connectedAgents(doc)).toEqual([FOREMAN]);
            const [name] = entriesOf(process.pid);
            hold.renew();
            expect(entriesOf(process.pid)).toEqual([name!]);
        } finally {
            hold.release();
        }
        expect(entries()).toEqual([]);
        hold.renew();
        expect(entries()).toEqual([]);
    });

    test("a dead pid's entry reads false and is pruned", async () => {
        const pid = await deadPid();
        mkdirSync(watchersDir(doc), { recursive: true });
        writeFileSync(join(watchersDir(doc), `${pid}-0`), "");
        writeFileSync(join(watchersDir(doc), "junk"), "");
        expect(agentWatching(doc)).toBe(false);
        expect(entries()).toEqual(["junk"]);
    });

    // As root every pid can be signalled, so there is no other user's process to name.
    test.skipIf(process.getuid?.() === 0)(
        "an entry naming another user's pid is not ours and is pruned, the legacy file too",
        () => {
            mkdirSync(watchersDir(doc), { recursive: true });
            writeFileSync(
                join(watchersDir(doc), "1-0"),
                JSON.stringify({ name: "reviewer", client: "claude-code" }),
            );
            writeFileSync(legacyWatcherFile(doc), "1\n");
            expect(connectedAgents(doc)).toEqual([]);
            expect(entries()).toEqual([]);
            expect(existsSync(legacyWatcherFile(doc))).toBe(false);
        },
    );

    test("a dead entry beside a live one is pruned while presence holds", async () => {
        const pid = await deadPid();
        await withPresence(doc, FOREMAN, async () => {
            writeFileSync(join(watchersDir(doc), `${pid}-0`), "");
            expect(agentWatching(doc)).toBe(true);
            expect(entriesOf(pid)).toEqual([]);
        });
    });

    test("a legacy file with a live pid counts as one unknown watcher", async () => {
        mkdirSync(join(dir, ".margin"), { recursive: true });
        writeFileSync(legacyWatcherFile(doc), `${process.pid}\n`);
        expect(connectedAgents(doc)).toEqual([UNKNOWN]);
        expect(existsSync(legacyWatcherFile(doc))).toBe(true);
    });

    test("a legacy file with a dead or garbled pid reads false and is removed", async () => {
        mkdirSync(join(dir, ".margin"), { recursive: true });
        for (const text of [`${await deadPid()}\n`, "not a pid\n"]) {
            writeFileSync(legacyWatcherFile(doc), text);
            expect(agentWatching(doc)).toBe(false);
            expect(existsSync(legacyWatcherFile(doc))).toBe(false);
        }
    });

    for (const order of [
        ["first", "second"],
        ["second", "first"],
    ] as const) {
        test(
            `two watchers: presence holds until both exit, ${order[0]} one first`,
            async () => {
                const first = spawnWatch();
                const second = spawnWatch();
                try {
                    await registered(first);
                    await registered(second);
                    const procs = { first, second };
                    const [early, late] = [procs[order[0]], procs[order[1]]];
                    early.kill("SIGTERM");
                    await early.exited;
                    expect(entriesOf(early.pid)).toEqual([]);
                    expect(agentWatching(doc)).toBe(true);
                    late.kill("SIGTERM");
                    await late.exited;
                    expect(agentWatching(doc)).toBe(false);
                    expect(entries()).toEqual([]);
                } finally {
                    first.kill("SIGKILL");
                    second.kill("SIGKILL");
                }
            },
            SUBPROCESS_TIMEOUT_MS,
        );
    }

    test(
        "a crashed watcher leaves an entry that the next read prunes",
        async () => {
            const proc = spawnWatch();
            try {
                await registered(proc);
                proc.kill("SIGKILL");
                await proc.exited;
                expect(entriesOf(proc.pid)).toHaveLength(1);
                expect(agentWatching(doc)).toBe(false);
                expect(entries()).toEqual([]);
            } finally {
                proc.kill("SIGKILL");
            }
        },
        SUBPROCESS_TIMEOUT_MS,
    );

    for (const [args, signal] of [
        [["watch"], "SIGTERM"],
        [["watch"], "SIGINT"],
        [["pending", "--wait"], "SIGTERM"],
    ] as const) {
        test(
            `margin ${args.join(" ")} registers and releases on ${signal}`,
            async () => {
                const proc = spawnWatch(args);
                try {
                    await registered(proc);
                    expect(agentWatching(doc)).toBe(true);
                    proc.kill(signal);
                    await proc.exited;
                    expect(proc.signalCode).toBe(signal);
                    expect(entriesOf(proc.pid)).toEqual([]);
                    expect(agentWatching(doc)).toBe(false);
                } finally {
                    proc.kill("SIGKILL");
                }
            },
            SUBPROCESS_TIMEOUT_MS,
        );
    }
});
