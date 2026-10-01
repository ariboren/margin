import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createAnchor } from "../core/anchor.ts";
import { decodeSource, flattenUnits, hashText, parseDoc } from "../core/blocks.ts";
import { appendEvents, readLog, transact, type LogTxn } from "../core/log.ts";
import { applyEdit, applyEditIn } from "../core/apply.ts";
import { emitWatch, WakeTail } from "../cli/watch.ts";
import { threadStatus } from "../client/view-model.ts";
import type { Anchor, Event, EventInput, SaveResult, ThreadId } from "../core/model.ts";
import { startServer, type MarginServer } from "./daemon.ts";
import { nextThreadId } from "../core/threads.ts";
import { DocSession, MAX_VERDICT_NOTE, mapStart, mapStartStrict } from "./session.ts";
import { routes, shortDocId, type MutationName, type WireSnapshot } from "./protocol.ts";

const PUBLIC_SAMPLE = join(import.meta.dir, "..", "..", "fixtures", "public-sample.md");

let dir: string;
let state: string;
let servers: MarginServer[] = [];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "margin-session-"));
    state = mkdtempSync(join(tmpdir(), "margin-state-"));
});

afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers = [];
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
});

async function serve(): Promise<MarginServer> {
    const server = await startServer({ watch: { pollMs: 200 }, stateDir: state });
    servers.push(server);
    return server;
}

async function open(server: MarginServer, path: string): Promise<string> {
    return (await server.register(path)).docId;
}

function headers(server: MarginServer): Record<string, string> {
    return {
        authorization: `Bearer ${server.token}`,
        origin: server.origin,
        "content-type": "application/json",
    };
}

async function call<T = Record<string, unknown>>(
    server: MarginServer,
    docId: string,
    action: MutationName,
    body: object,
): Promise<T & { version: number }> {
    const response = await fetch(`${server.origin}${routes.mutate(docId, action)}`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as T & { version: number };
}

async function snapshot(server: MarginServer, docId: string): Promise<WireSnapshot> {
    const response = await fetch(`${server.origin}${routes.snapshot(docId)}`, {
        headers: headers(server),
    });
    return (await response.json()) as WireSnapshot;
}

/** Reads the push stream; `until` resolves with the first snapshot matching. */
function listen(server: MarginServer, docId: string) {
    const controller = new AbortController();
    const seen: WireSnapshot[] = [];
    const waiters: { match: (s: WireSnapshot) => boolean; resolve: (s: WireSnapshot) => void }[] =
        [];
    const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true });
                let cut: number;
                while ((cut = buffer.indexOf("\n\n")) !== -1) {
                    const message = buffer.slice(0, cut);
                    buffer = buffer.slice(cut + 2);
                    const data = message.split("\n").find((line) => line.startsWith("data: "));
                    if (!data) continue;
                    const snap = JSON.parse(data.slice(6)) as WireSnapshot;
                    seen.push(snap);
                    for (const waiter of waiters.splice(0)) {
                        if (waiter.match(snap)) waiter.resolve(snap);
                        else waiters.push(waiter);
                    }
                }
            }
        } catch {
            // Aborted.
        }
    };
    const ready = (async () => {
        const response = await fetch(`${server.origin}${routes.events(docId)}`, {
            headers: headers(server),
            signal: controller.signal,
        });
        void pump(response.body!.getReader());
    })();
    return {
        seen,
        ready,
        until(match: (s: WireSnapshot) => boolean, timeoutMs = 2_000): Promise<WireSnapshot> {
            const hit = seen.findLast(match);
            if (hit) return Promise.resolve(hit);
            return new Promise((resolve, reject) => {
                waiters.push({ match, resolve });
                setTimeout(() => reject(new Error("no matching push")), timeoutMs);
            });
        },
        close: () => controller.abort(),
    };
}

function copySample(name = "doc.md"): string {
    const path = join(dir, name);
    copyFileSync(PUBLIC_SAMPLE, path);
    return path;
}

function read(path: string): string {
    return decodeSource(readFileSync(path));
}

/** Editor-style save: temp file, rename over the doc. */
function editorWrite(path: string, text: string): void {
    const temp = `${path}.swp`;
    writeFileSync(temp, text);
    renameSync(temp, path);
}

async function events(path: string): Promise<Event[]> {
    return (await readLog(path)).events;
}

/** A mid-document paragraph long enough to edit one word in. */
function paragraph(source: string) {
    const units = flattenUnits(parseDoc(source).units).filter(
        (unit) => unit.kind === "paragraph" && unit.end - unit.start > 200,
    );
    return units[Math.floor(units.length / 2)]!;
}

describe("mapStart", () => {
    test("shifts past earlier splices, ignores later ones, flags overlaps and unknowns", () => {
        const insert = { start: 0, before: "", after: "xx" };
        const later = { start: 50, before: "a", after: "bbb" };
        expect(mapStart([insert, later], 10, 5)).toEqual({ start: 12, exact: true });
        expect(mapStart([{ start: 12, before: "ab", after: "" }], 10, 5)).toEqual({
            start: 12,
            exact: false,
        });
        expect(mapStart([null], 10, 5).exact).toBe(false);
        expect(mapStart([{ start: 15, before: "", after: "z" }], 10, 5)).toEqual({
            start: 10,
            exact: true,
        });
    });
});

describe("mapStartStrict", () => {
    const atStart = { start: 10, before: "", after: "x" };
    const atEnd = { start: 15, before: "", after: "x" };

    test("an insertion touching either end, or into an empty range, is a conflict", () => {
        expect(mapStartStrict([atStart], 10, 5).exact).toBe(false);
        expect(mapStartStrict([atEnd], 10, 5).exact).toBe(false);
        expect(mapStartStrict([{ start: 10, before: "", after: "x" }], 10, 0).exact).toBe(false);
        // A replacement ending right at the start touches it too.
        expect(mapStartStrict([{ start: 8, before: "ab", after: "c" }], 10, 5).exact).toBe(false);
        expect(mapStartStrict([null], 10, 5).exact).toBe(false);
    });

    test("the non-strict mapping still accepts all three", () => {
        expect(mapStart([atStart], 10, 5)).toEqual({ start: 11, exact: true });
        expect(mapStart([atEnd], 10, 5)).toEqual({ start: 10, exact: true });
        expect(mapStart([{ start: 10, before: "", after: "x" }], 10, 0)).toEqual({
            start: 11,
            exact: true,
        });
    });

    test("splices clearly before or after pass, and shift the range", () => {
        const before = { start: 2, before: "abc", after: "z" };
        const after = { start: 16, before: "", after: "yy" };
        expect(mapStartStrict([before, after], 10, 5)).toEqual({ start: 8, exact: true });
        expect(mapStartStrict([{ start: 0, before: "", after: "xx" }], 10, 0)).toEqual({
            start: 12,
            exact: true,
        });
    });
});

describe("doc session", () => {
    test("an edit landing between the first read and the lock is logged once", async () => {
        const path = join(dir, "doc.md");
        writeFileSync(path, "# Title\n\nThe quick brown fox jumps.\n");
        const source = read(path);
        const quoteStart = source.indexOf("quick brown fox");
        await appendEvents(path, [
            {
                type: "comment",
                by: "user",
                id: "c1",
                anchor: createAnchor(source, {
                    start: quoteStart,
                    end: quoteStart + "quick brown fox".length,
                }),
                text: "Check",
                draft: false,
            },
        ]);
        let opening: Promise<DocSession> | undefined;
        await transact(path, async (txn) => {
            // open() reads the file now, then waits on the lock this test holds.
            opening = DocSession.open("0123456789ab", path);
            await Bun.sleep(100);
            const edited = applyEditIn(txn, {
                start: source.indexOf("brown"),
                before: "brown",
                after: "slow brown",
                cause: "apply",
                by: "agent",
            });
            expect(edited.ok).toBe(true);
        });
        const session = await opening!;
        await session.sync();

        const log = await events(path);
        expect(log.filter((event) => event.type === "edit")).toHaveLength(1);
        expect(log.filter((event) => event.type === "outside")).toHaveLength(0);
        const thread = session.snapshot().threads[0]!;
        expect(thread.anchor!.exact).toBe("quick slow brown fox");
        expect(thread.detached).toBe(false);
        expect(session.snapshot().hash).toBe(hashText(read(path)));
    });

    for (const where of ["before", "after"] as const) {
        test(`an unsynced save inside the only quote, then a CLI edit ${where} it (gate B)`, async () => {
            const path = join(dir, "doc.md");
            writeFileSync(
                path,
                "# Title\n\nFirst paragraph here.\n\nThe cold path rarely runs.\n\nLast paragraph here.\n",
            );
            const source = read(path);
            const quote = "cold path rarely runs";
            const start = source.indexOf(quote);
            await appendEvents(path, [
                {
                    type: "comment",
                    by: "user",
                    id: "c1",
                    anchor: createAnchor(source, { start, end: start + quote.length }),
                    text: "Why?",
                    draft: false,
                },
            ]);
            const session = await DocSession.open("0123456789ab", path);
            writeFileSync(path, read(path).replace("cold path", "cold code path"));
            const saved = read(path);
            const target = where === "before" ? "First paragraph" : "Last paragraph";
            const edited = await applyEdit(path, {
                start: saved.indexOf(target),
                before: target,
                after: `${target}, edited`,
                cause: "apply",
                by: "agent",
            });
            expect(edited.ok).toBe(true);
            await session.sync();

            const final = read(path);
            const thread = session.snapshot().threads[0]!;
            const logged = (await events(path)).map((event) => event.type);
            expect(logged).toEqual(["comment", "edit", "outside"]);
            const outside = (await events(path)).find((event) => event.type === "outside");
            expect(outside).toHaveProperty("edit");
            expect(thread.anchor!.exact).toBe("cold code path rarely runs");
            expect(thread.detached).toBe(false);
            expect(final).toContain("cold code path rarely runs");
        });
    }

    test("an unsynced save under a CLI edit's own text is logged without a splice (gate B)", async () => {
        const path = join(dir, "doc.md");
        writeFileSync(
            path,
            "# Title\n\nThe cold path rarely runs.\n\nA middle paragraph keeps the quote's context away.\n\nLast paragraph here.\n",
        );
        const source = read(path);
        const start = source.indexOf("cold path");
        await appendEvents(path, [
            {
                type: "comment",
                by: "user",
                id: "c1",
                anchor: createAnchor(source, { start, end: start + "cold path".length }),
                text: "Why?",
                draft: false,
            },
        ]);
        const session = await DocSession.open("0123456789ab", path);
        writeFileSync(path, read(path).replace("Last paragraph", "Final paragraph"));
        const saved = read(path);
        const edited = await applyEdit(path, {
            start: saved.indexOf("Final paragraph"),
            before: "Final paragraph",
            after: "Closing paragraph",
            cause: "apply",
            by: "agent",
        });
        expect(edited.ok).toBe(true);
        await session.sync();

        const log = await events(path);
        expect(log.map((event) => event.type)).toEqual(["comment", "edit", "outside"]);
        expect(log.at(-1)).not.toHaveProperty("edit");
        const thread = session.snapshot().threads[0]!;
        expect(thread.anchor!.exact).toBe("cold path");
        expect(thread.detached).toBe(false);
        expect(session.snapshot().changedOnDisk).toBeString();
    });

    test("typing inside a quote after an unlogged edit above keeps the quote (gate B)", async () => {
        const path = join(dir, "doc.md");
        writeFileSync(path, "# Title\n\nThe cache is warm, so the cold path rarely runs.\n");
        const source = read(path);
        const quote = "cold path rarely runs";
        const start = source.indexOf(quote);
        await appendEvents(path, [
            {
                type: "comment",
                by: "user",
                id: "c1",
                anchor: createAnchor(source, { start, end: start + quote.length }),
                text: "Why?",
                draft: false,
            },
        ]);
        writeFileSync(path, source.replace("# Title\n", "# Title\nIntro.\n"));
        const session = await DocSession.open("0123456789ab", path);
        writeFileSync(path, read(path).replace("cold path", "cold code path"));
        await session.sync();

        const thread = session.snapshot().threads[0]!;
        expect(thread.anchor!.exact).toBe("cold code path rarely runs");
        expect(thread.detached).toBe(false);
        const log = await events(path);
        expect(log.map((event) => event.type)).toEqual(["comment", "reanchor", "outside"]);
    });

    test("a comment survives a reload and a daemon restart", async () => {
        const path = copySample();
        const first = await serve();
        const docId = await open(first, path);
        const source = read(path);
        const unit = paragraph(source);
        const anchor = createAnchor(source, { start: unit.start + 5, end: unit.start + 25 });
        const { id } = await call<{ id: ThreadId }>(first, docId, "comment", {
            anchor,
            text: "Tighten this",
        });
        expect(id).toBe("c1");
        await first.stop();

        const second = await serve();
        expect(await open(second, path)).toBe(docId);
        const page = await fetch(
            `${second.origin}${routes.page(shortDocId(docId), basename(path))}?t=${second.token}`,
        );
        expect(page.status).toBe(200);
        const thread = (await snapshot(second, docId)).threads[0]!;
        expect(thread.id).toBe("c1");
        expect(thread.messages[0]?.text).toBe("Tighten this");
        expect(thread.anchor!.exact).toBe(anchor.exact);
        expect(thread.detached).toBe(false);
        expect(read(path)).toBe(source);
    });

    test("a unit edit changes only its bytes, and git diff shows only that line", async () => {
        const path = copySample();
        const git = (...args: string[]) =>
            Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
                cwd: dir,
            });
        git("init", "-q");
        git("add", "doc.md");
        git("commit", "-qm", "base");

        const server = await serve();
        const docId = await open(server, path);
        const before = readFileSync(path);
        const source = decodeSource(before);
        const unit = paragraph(source);
        const text = source.slice(unit.start, unit.end);
        const word = text.indexOf(" ", 40);
        const after = `${text.slice(0, word)} really${text.slice(word)}`;
        const { version } = await snapshot(server, docId);
        const result = await call<SaveResult>(server, docId, "save", {
            start: unit.start,
            before: text,
            after,
            version,
        });
        expect(result.ok).toBe(true);

        const now = read(path);
        expect(now).toBe(source.slice(0, unit.start) + after + source.slice(unit.end));
        const numstat = git("diff", "--numstat").stdout.toString().trim();
        expect(numstat).toBe("1\t1\tdoc.md");
        const log = await events(path);
        expect(log.filter((event) => event.type === "outside")).toHaveLength(0);
        expect(log.filter((event) => event.type === "edit")).toHaveLength(1);
    });

    test("a save onto a unit changed on disk is a conflict and leaves the file alone", async () => {
        const path = copySample();
        const server = await serve();
        const docId = await open(server, path);
        const source = read(path);
        const unit = paragraph(source);
        const text = source.slice(unit.start, unit.end);
        const { version } = await snapshot(server, docId);

        const theirs = `${text.slice(0, 20)}THEIRS${text.slice(20)}`;
        const changed = source.slice(0, unit.start) + theirs + source.slice(unit.end);
        editorWrite(path, changed);
        const bytes = readFileSync(path);

        const result = await call<SaveResult>(server, docId, "save", {
            start: unit.start,
            before: text,
            after: `${text} mine`,
            version,
        });
        expect(result).toMatchObject({ ok: false, reason: "conflict", current: theirs });
        expect(readFileSync(path).equals(bytes)).toBe(true);
    });

    test("a save lands after an outside change elsewhere, moved by the logged splice", async () => {
        const path = copySample();
        const server = await serve();
        const docId = await open(server, path);
        const source = read(path);
        const unit = paragraph(source);
        const text = source.slice(unit.start, unit.end);
        const { version } = await snapshot(server, docId);

        editorWrite(path, `Inserted line.\n\n${source}`);
        const result = await call<SaveResult>(server, docId, "save", {
            start: unit.start,
            before: text,
            after: `${text} Added.`,
            version,
        });
        expect(result.ok).toBe(true);
        const shift = "Inserted line.\n\n".length;
        expect(read(path)).toBe(
            `Inserted line.\n\n${source.slice(0, unit.start)}${text} Added.${source.slice(unit.end)}`,
        );
        expect(read(path).slice(unit.start + shift, unit.start + shift + text.length)).toBe(text);
    });

    test("a strict save refuses an outside insertion right at its end; a plain one lands", async () => {
        const source = "# T\n\nMine.\n\nNext.\n";
        const appended = "# T\n\nMine. And more.\n\nNext.\n";
        const start = source.indexOf("Mine.");
        const results: SaveResult[] = [];
        for (const strict of [true, false]) {
            const path = join(dir, `doc-${strict}.md`);
            writeFileSync(path, source);
            const server = await serve();
            const docId = await open(server, path);
            const { version } = await snapshot(server, docId);
            // Logged as the insertion " And more." exactly at the end of "Mine.".
            editorWrite(path, appended);
            results.push(
                await call<SaveResult>(server, docId, "save", {
                    start,
                    before: "Mine.",
                    after: "Theirs.",
                    version,
                    strict,
                }),
            );
            if (strict) {
                expect(read(path)).toBe(appended);
            } else {
                expect(read(path)).toBe("# T\n\nTheirs. And more.\n\nNext.\n");
            }
        }
        expect(results[0]).toMatchObject({ ok: false, reason: "conflict" });
        expect(results[1]).toMatchObject({ ok: true });
    });

    test("Restore is a strict save at the keep-time range: refused once text lands at its end", async () => {
        for (const inserted of [true, false]) {
            const path = join(dir, `restore-${inserted}.md`);
            writeFileSync(path, "Alpha.\n\nTheirs.\n\nNext.\n");
            const server = await serve();
            const docId = await open(server, path);
            const { version } = await snapshot(server, docId);
            // Keep mine over the agent's "Theirs.".
            const kept = await call<SaveResult & { at: number }>(server, docId, "save", {
                start: "Alpha.\n\n".length,
                before: "Theirs.",
                after: "Mine.",
                version,
            });
            expect(kept).toMatchObject({ ok: true, at: "Alpha.\n\n".length });
            if (inserted) {
                // Logged exactly at the kept text's end, as an agent or unit save would.
                await call(server, docId, "save", {
                    start: kept.at + "Mine.".length,
                    before: "",
                    after: "\n\nNew.",
                });
            }
            const before = read(path);
            const restored = await call<SaveResult>(server, docId, "save", {
                start: kept.at,
                before: "Mine.",
                after: "Theirs.",
                version: kept.version,
                strict: true,
            });
            if (inserted) {
                expect(restored).toMatchObject({ ok: false, reason: "conflict" });
                expect(read(path)).toBe(before);
            } else {
                expect(restored).toMatchObject({ ok: true });
                expect(read(path)).toBe("Alpha.\n\nTheirs.\n\nNext.\n");
            }
        }
    });

    test("a save's version and at come from one transaction, even with a save queued behind it", async () => {
        const path = join(dir, "doc.md");
        writeFileSync(path, "# T\n\nAlpha.\n\nTheirs.\n\nNext.\n");
        const server = await serve();
        const docId = await open(server, path);
        const { version } = await snapshot(server, docId);
        const start = read(path).indexOf("Theirs.");
        // The handler resumes a macrotask late, so the save queued behind has surely run by then:
        // what the response says must not depend on when the handler gets to read it.
        const session = server.session(docId)!;
        const save = session.save.bind(session);
        session.save = async (input) => {
            const result = await save(input);
            await Bun.sleep(0);
            return result;
        };
        let keep: Promise<SaveResult & { at: number; version: number }> | undefined;
        let title: Promise<SaveResult & { version: number }> | undefined;
        // Both saves park on the session queue, in this order, behind the lock this test holds.
        await transact(path, async () => {
            keep = call(server, docId, "save", {
                start,
                before: "Theirs.",
                after: "Mine.",
                version,
            });
            await Bun.sleep(30);
            title = call(server, docId, "save", {
                start: 0,
                before: "# T",
                after: "# Title",
                version,
            });
            await Bun.sleep(120);
        });
        const kept = await keep!;
        const titled = await title!;
        expect(kept).toMatchObject({ ok: true, at: start });
        expect(titled).toMatchObject({ ok: true });
        expect(kept.version).toBeLessThan(titled.version);

        const restored = await call<SaveResult>(server, docId, "save", {
            start: kept.at,
            before: "Mine.",
            after: "Theirs.",
            version: kept.version,
            strict: true,
        });
        expect(restored).toMatchObject({ ok: true });
        expect(read(path)).toBe("# Title\n\nAlpha.\n\nTheirs.\n\nNext.\n");
    });

    test("an outside write logged inside a save's own transaction is not paired with its at", async () => {
        const path = join(dir, "doc.md");
        writeFileSync(path, "# T\n\n| a | b |\n| - | - |\n| x |  |\n| y | agent |\n");
        const server = await serve();
        const docId = await open(server, path);
        const { version } = await snapshot(server, docId);
        const start = read(path).indexOf("agent");
        // An editor takes no lock: its write can land between the save's own write and the second
        // reconcile, which logs it. Injected there by shadowing the session's reconcile.
        const session = server.session(docId)! as unknown as { reconcile: (txn: LogTxn) => void };
        const reconcile = session.reconcile;
        let calls = 0;
        session.reconcile = function (this: unknown, txn: LogTxn) {
            if (++calls === 2) {
                editorWrite(path, read(path).replace("# T\n", "# Txxxxxxxxx\n"));
            }
            reconcile.call(this, txn);
        };
        // Keep mine that clears the cell: Restore's compare-and-swap on "" checks nothing.
        const kept = await call<SaveResult & { at: number }>(server, docId, "save", {
            start,
            before: "agent",
            after: "",
            version,
        });
        session.reconcile = reconcile;
        const log = await events(path);
        const edit = log.find((event) => event.type === "edit")!;
        expect(log.at(-1)).toMatchObject({ type: "outside" });
        expect(kept).toMatchObject({ ok: true, at: start, version: edit.seq });

        const restored = await call<SaveResult>(server, docId, "save", {
            start: kept.at,
            before: "",
            after: "agent",
            version: kept.version,
            strict: true,
        });
        expect(restored).toMatchObject({ ok: true });
        expect(read(path)).toBe("# Txxxxxxxxx\n\n| a | b |\n| - | - |\n| x |  |\n| y | agent |\n");
    });

    test("S1: Restore after the kept cell was edited again is refused; the same text elsewhere is left alone", async () => {
        const path = join(dir, "doc.md");
        writeFileSync(path, "| k | v |\n| - | - |\n| 1 | 3 |\n");
        const server = await serve();
        const docId = await open(server, path);
        const { version } = await snapshot(server, docId);
        const kept = await call<SaveResult & { at: number }>(server, docId, "save", {
            start: read(path).indexOf("3"),
            before: "3",
            after: "1",
            version,
        });
        expect(kept).toMatchObject({ ok: true });
        expect(read(path)).toBe("| k | v |\n| - | - |\n| 1 | 1 |\n");
        const edited = await call<SaveResult>(server, docId, "save", {
            start: kept.at,
            before: "1",
            after: "5",
            version: kept.version,
        });
        expect(edited).toMatchObject({ ok: true });
        const restored = await call<SaveResult>(server, docId, "save", {
            start: kept.at,
            before: "1",
            after: "3",
            version: kept.version,
            strict: true,
        });
        expect(restored).toMatchObject({ ok: false, reason: "conflict" });
        expect(read(path)).toBe("| k | v |\n| - | - |\n| 1 | 5 |\n");
    });

    test("a strict save against a version the log never reached is a conflict", async () => {
        const path = join(dir, "doc.md");
        writeFileSync(path, "# T\n\n| k | v |\n| - | - |\n| a | x |\n| b | Theirs |\n");
        const server = await serve();
        const docId = await open(server, path);
        const { version } = await snapshot(server, docId);
        // Keep mine that clears a cell: Restore's compare-and-swap on "" checks nothing.
        const kept = await call<SaveResult & { at: number }>(server, docId, "save", {
            start: read(path).indexOf("Theirs"),
            before: "Theirs",
            after: "",
            version,
        });
        expect(kept).toMatchObject({ ok: true });
        await call(server, docId, "save", {
            start: 0,
            before: "# T",
            after: "# Title",
            version: kept.version,
        });
        const before = read(path);
        const restored = await call<SaveResult>(server, docId, "save", {
            start: kept.at,
            before: "",
            after: "Theirs",
            version: kept.version + 9999,
            strict: true,
        });
        expect(restored).toMatchObject({ ok: false, reason: "conflict" });
        expect(read(path)).toBe(before);
    });

    test("a save never lands on another copy of the same text", async () => {
        const path = join(dir, "doc.md");
        writeFileSync(path, "| k | v |\n| - | - |\n| a | Yes |\n| b | Maybe |\n");
        const server = await serve();
        const docId = await open(server, path);
        const { version } = await snapshot(server, docId);
        const start = read(path).indexOf("Yes");
        editorWrite(path, "| k | v |\n| - | - |\n| a | No |\n| b | Yes |\n");
        const bytes = readFileSync(path);

        const mapped = await call<SaveResult>(server, docId, "save", {
            start,
            before: "Yes",
            after: "Sure",
            version,
        });
        expect(mapped.ok).toBe(false);
        const exact = await call<SaveResult>(server, docId, "save", {
            start,
            before: "Yes",
            after: "Sure",
        });
        expect(exact.ok).toBe(false);
        expect(readFileSync(path).equals(bytes)).toBe(true);
    });

    test("an outside edit reaches a connected tab within 300 ms", async () => {
        const path = copySample();
        const server = await serve();
        const docId = await open(server, path);
        const stream = listen(server, docId);
        await stream.ready;
        await stream.until(() => true);
        const source = read(path);
        const samples: number[] = [];
        for (let i = 0; i < 10; i++) {
            const next = `${source}\nOutside line ${i}.\n`;
            const started = performance.now();
            editorWrite(path, next);
            const hash = hashText(next);
            await stream.until((snap) => snap.hash === hash);
            samples.push(performance.now() - started);
        }
        stream.close();
        const sorted = samples.toSorted((a, b) => a - b);
        console.log(
            `outside edit to tab: p50 ${sorted[4]!.toFixed(1)} ms, max ${sorted[9]!.toFixed(1)} ms`,
        );
        expect(sorted[9]!).toBeLessThan(300);
        const outside = (await events(path)).filter((event) => event.type === "outside");
        expect(outside).toHaveLength(10);
        expect(outside.every((event) => event.type === "outside" && event.edit)).toBe(true);
    });

    test("an edit by another process through applyEdit is not logged as outside", async () => {
        const path = copySample();
        const server = await serve();
        const docId = await open(server, path);
        const source = read(path);
        const unit = paragraph(source);
        const text = source.slice(unit.start, unit.end);
        const stream = listen(server, docId);
        await stream.ready;
        const script = `
            import { applyEdit } from ${JSON.stringify(join(import.meta.dir, "..", "core", "apply.ts"))};
            const result = await applyEdit(${JSON.stringify(path)}, {
                start: ${unit.start}, before: ${JSON.stringify(text)},
                after: ${JSON.stringify(`${text} CLI.`)}, cause: "apply", by: "agent",
            });
            if (!result.ok) process.exit(1);
        `;
        const proc = Bun.spawnSync([process.execPath, "-e", script]);
        expect(proc.exitCode).toBe(0);
        const expected = hashText(read(path));
        const snap = await stream.until((s) => s.hash === expected);
        stream.close();
        expect(snap.edits).toHaveLength(1);
        expect((await events(path)).some((event) => event.type === "outside")).toBe(false);
    });

    test("a missing file keeps state and comes back without an outside event", async () => {
        const path = copySample();
        const server = await serve();
        const docId = await open(server, path);
        const source = read(path);
        const unit = paragraph(source);
        await call(server, docId, "comment", {
            anchor: createAnchor(source, { start: unit.start, end: unit.start + 10 }),
            text: "Keep me",
        });
        const stream = listen(server, docId);
        await stream.ready;
        renameSync(path, `${path}.away`);
        const gone = await stream.until((snap) => snap.missing);
        expect(gone.threads).toHaveLength(1);
        const saved = await call<SaveResult>(server, docId, "save", {
            start: unit.start,
            before: "x",
            after: "y",
        });
        expect(saved).toMatchObject({ ok: false, reason: "missing" });
        renameSync(`${path}.away`, path);
        const back = await stream.until((snap) => !snap.missing);
        stream.close();
        expect(back.threads).toHaveLength(1);
        expect((await events(path)).some((event) => event.type === "outside")).toBe(false);
    });

    test("a change made while no daemon ran is logged on registration, without a splice", async () => {
        const path = copySample();
        const first = await serve();
        const docId = await open(first, path);
        const source = read(path);
        const unit = paragraph(source);
        const text = source.slice(unit.start, unit.end);
        await call(first, docId, "save", {
            start: unit.start,
            before: text,
            after: `${text} One.`,
        });
        await first.stop();

        const second = await serve();
        await open(second, path);
        expect((await events(path)).some((event) => event.type === "outside")).toBe(false);
        await second.stop();

        const current = read(path);
        const logged = await applyEdit(path, {
            start: current.length,
            before: "",
            after: "\nBy the CLI.\n",
            cause: "apply",
            by: "agent",
        });
        expect(logged.ok).toBe(true);
        const quiet = await serve();
        await open(quiet, path);
        expect((await events(path)).some((event) => event.type === "outside")).toBe(false);
        await quiet.stop();

        writeFileSync(path, `${read(path)}\nWhile away.\n`);
        const third = await serve();
        await open(third, path);
        const outside = (await events(path)).filter((event) => event.type === "outside");
        expect(outside).toHaveLength(1);
        expect(outside[0]).not.toHaveProperty("edit");
        expect((await snapshot(third, docId)).changedOnDisk).toBeString();
    });

    test("accept applies the suggestion at its anchor and resolves; revert undoes an applied edit", async () => {
        const path = copySample();
        const server = await serve();
        const docId = await open(server, path);
        const source = read(path);
        const unit = paragraph(source);
        const range = { start: unit.start + 10, end: unit.start + 30 };
        const exact = source.slice(range.start, range.end);
        const { id } = await call<{ id: ThreadId }>(server, docId, "suggest", {
            anchor: createAnchor(source, range),
            replace: "REPLACED",
        });
        const accepted = await call<SaveResult>(server, docId, "accept", { id });
        expect(accepted.ok).toBe(true);
        const afterAccept = source.slice(0, range.start) + "REPLACED" + source.slice(range.end);
        expect(read(path)).toBe(afterAccept);
        const thread = (await snapshot(server, docId)).threads.find((t) => t.id === id)!;
        expect(thread.state).toBe("resolved");
        expect(exact).not.toBe("REPLACED");

        // What `suggest --apply` in the CLI logs: the edit, then the suggestion that owns it.
        const other = paragraph(afterAccept);
        const otherText = afterAccept.slice(other.start, other.end);
        await transact(path, (txn) => {
            applyEditIn(txn, {
                start: other.start,
                before: otherText,
                after: `${otherText} Agent.`,
                cause: "apply",
                by: "agent",
                id: "c2",
            });
            txn.append([
                {
                    type: "suggest",
                    by: "agent",
                    id: "c2",
                    replace: `${otherText} Agent.`,
                    anchor: createAnchor(afterAccept, { start: other.start, end: other.end }),
                    apply: true,
                },
            ]);
        });
        const reverted = await call<SaveResult>(server, docId, "revert", { id: "c2" });
        expect(reverted.ok).toBe(true);
        expect(read(path)).toBe(afterAccept);
        expect((await events(path)).some((event) => event.type === "outside")).toBe(false);
    });

    test("hold keeps comments as drafts until send all", async () => {
        const path = copySample();
        const server = await serve();
        const docId = await open(server, path);
        const source = read(path);
        const unit = paragraph(source);
        await call(server, docId, "hold", { on: true });
        const { id } = await call<{ id: ThreadId }>(server, docId, "comment", {
            anchor: createAnchor(source, { start: unit.start, end: unit.start + 12 }),
            text: "Later",
        });
        const draft = (await snapshot(server, docId)).threads.find((t) => t.id === id)!;
        expect(draft.state).toBe("draft");
        await call(server, docId, "send-all", {});
        const sent = (await snapshot(server, docId)).threads.find((t) => t.id === id)!;
        expect(sent.state).toBe("open");
    });

    test("a doc note needs no anchor: held it drafts, sent it opens, and it never detaches", async () => {
        const path = copySample();
        const server = await serve();
        const docId = await open(server, path);
        await call(server, docId, "hold", { on: true });
        const { id } = await call<{ id: ThreadId }>(server, docId, "comment", {
            text: "Tighten the whole intro.",
        });
        const draft = (await snapshot(server, docId)).threads.find((t) => t.id === id)!;
        expect(draft).toMatchObject({ state: "draft", detached: false });
        expect(draft.anchor).toBeUndefined();
        await call(server, docId, "send-all", {});
        const sent = (await snapshot(server, docId)).threads.find((t) => t.id === id)!;
        expect(sent.state).toBe("open");
        const accept = await fetch(`${server.origin}${routes.mutate(docId, "accept")}`, {
            method: "POST",
            headers: headers(server),
            body: JSON.stringify({ id }),
        });
        expect(accept.status).toBe(409);
        expect(read(path)).toBe(read(PUBLIC_SAMPLE));
    });

    test("bad input is a 400 and an unknown thread a 404", async () => {
        const path = copySample();
        const server = await serve();
        const docId = await open(server, path);
        const post = (action: MutationName, body: object) =>
            fetch(`${server.origin}${routes.mutate(docId, action)}`, {
                method: "POST",
                headers: headers(server),
                body: JSON.stringify(body),
            });
        expect((await post("save", { start: -1, before: "", after: "" })).status).toBe(400);
        expect((await post("comment", { anchor: 5, text: "x" })).status).toBe(400);
        expect((await post("reply", { id: "c9", text: "hi" })).status).toBe(404);
        expect(
            (
                await post("comment", {
                    anchor: { exact: "zzqq", prefix: "", suffix: "", hint: 0 },
                    text: "x",
                })
            ).status,
        ).toBe(409);
    });
    test("a deleted directory is not recreated by a save", async () => {
        const sub = join(dir, "sub");
        mkdirSync(sub);
        const path = join(sub, "doc.md");
        writeFileSync(path, "# T\n\nBody.\n");
        const server = await serve();
        const docId = await open(server, path);
        rmSync(sub, { recursive: true, force: true });
        const saved = await call<SaveResult>(server, docId, "save", {
            start: 5,
            before: "Body.",
            after: "New.",
        });
        expect(saved).toMatchObject({ ok: false, reason: "missing" });
        expect(existsSync(sub)).toBe(false);
    });
});

describe("idle exit", () => {
    test("waits while a tab is connected, fires once none is", async () => {
        const path = copySample();
        let idled = 0;
        const server = await startServer({ idleMs: 150, onIdle: () => idled++ });
        servers.push(server);
        const docId = await open(server, path);
        const stream = listen(server, docId);
        await stream.ready;
        await Bun.sleep(400);
        expect(idled).toBe(0);
        stream.close();
        await Bun.sleep(400);
        expect(idled).toBe(1);
    });
});

describe("delete and undelete", () => {
    async function setup(): Promise<{ session: DocSession; anchor: (exact: string) => Anchor }> {
        const path = join(dir, "doc.md");
        writeFileSync(path, "# Title\n\nThe quick brown fox jumps over the lazy dog.\n");
        const session = await DocSession.open("0123456789ab", path);
        const anchor = (exact: string): Anchor => {
            const start = read(path).indexOf(exact);
            return createAnchor(read(path), { start, end: start + exact.length });
        };
        return { session, anchor };
    }

    const ids = (session: DocSession) => session.snapshot().threads.map((thread) => thread.id);

    test("a deleted thread leaves the snapshot, resolved or not, and comes back as it was", async () => {
        const { session, anchor } = await setup();
        const { id } = await session.comment({ anchor: anchor("quick"), text: "Why?" });
        const { id: done } = await session.comment({ anchor: anchor("lazy"), text: "Ok" });
        await session.resolve(done);
        const before = session.snapshot().threads;

        await session.deleteThread(id);
        await session.deleteThread(done);
        expect(ids(session)).toEqual([]);

        await session.undeleteThread(id);
        await session.undeleteThread(done);
        expect(session.snapshot().threads).toEqual(before);
    });

    test("both are idempotent; an unknown id is not found", async () => {
        const { session, anchor } = await setup();
        const { id } = await session.comment({ anchor: anchor("quick"), text: "Why?" });
        await session.undeleteThread(id);
        await session.deleteThread(id);
        await session.deleteThread(id);
        const types = (await events(session.path)).map((event) => event.type);
        expect(types.filter((type) => type === "delete" || type === "undelete")).toEqual([
            "delete",
        ]);
        for (const call of [() => session.deleteThread("c9"), () => session.undeleteThread("c9")]) {
            await expect(call()).rejects.toMatchObject({ status: 404, error: "not-found" });
        }
    });

    test("the page deletes and undeletes over HTTP, with the token", async () => {
        const path = join(dir, "doc.md");
        writeFileSync(path, "# Title\n\nThe quick brown fox jumps.\n");
        const server = await serve();
        const docId = await open(server, path);
        const source = read(path);
        const start = source.indexOf("quick");
        const { id } = await call<{ id: ThreadId }>(server, docId, "comment", {
            anchor: createAnchor(source, { start, end: start + 5 }),
            text: "Why?",
        });
        const unsigned = await fetch(`${server.origin}${routes.mutate(docId, "delete")}`, {
            method: "POST",
            headers: { ...headers(server), authorization: "Bearer nope" },
            body: JSON.stringify({ id }),
        });
        expect(unsigned.status).toBe(403);
        await call(server, docId, "delete", { id });
        expect((await snapshot(server, docId)).threads).toEqual([]);
        await call(server, docId, "undelete", { id });
        expect((await snapshot(server, docId)).threads.map((thread) => thread.id)).toEqual([id]);
    });

    test("a deleted draft is not sent, and the page cannot act on a deleted thread", async () => {
        const { session, anchor } = await setup();
        await session.setHold(true);
        const { id } = await session.comment({ anchor: anchor("quick"), text: "Draft" });
        await session.deleteThread(id);
        await session.sendAll();
        expect((await events(session.path)).some((event) => event.type === "send")).toBe(false);
        await expect(session.reply(id, "More")).rejects.toMatchObject({ status: 404 });

        await session.undeleteThread(id);
        expect(session.snapshot().threads[0]).toMatchObject({ id, state: "draft" });
    });
});

describe("undo of a save", () => {
    /** The user's edit of a mid-document paragraph, and the strict save that takes it back. */
    async function edited(session: DocSession, path: string) {
        const source = read(path);
        const unit = paragraph(source);
        const before = source.slice(unit.start, unit.end);
        const after = `${before} Mine.`;
        const saved = await session.save({ start: unit.start, before, after, version: 0 });
        expect(saved.ok).toBe(true);
        const undo = () =>
            session.save({
                start: unit.start,
                before: after,
                after: before,
                version: saved.version,
                strict: true,
            });
        return { source, unit, before, after, undo };
    }

    test("a save that undoes an edit is logged as its undo; a wrong inverse is a 400", async () => {
        const path = copySample();
        const session = await DocSession.open("0123456789ab", path);
        const { unit, before, after } = await edited(session, path);
        const edited1 = (await events(path)).at(-1)!.seq;
        await expect(
            session.save({
                start: unit.start,
                before: after,
                after: `${before}!`,
                version: edited1,
                strict: true,
                undoes: edited1,
            }),
        ).rejects.toMatchObject({ status: 400, error: "bad-request" });
        await expect(
            session.save({ start: unit.start, before: after, after: before, undoes: 999 }),
        ).rejects.toMatchObject({ status: 400 });
        const undone = await session.save({
            start: unit.start,
            before: after,
            after: before,
            version: edited1,
            strict: true,
            undoes: edited1,
        });
        expect(undone.ok).toBe(true);
        expect((await events(path)).at(-1)).toMatchObject({
            type: "edit",
            cause: "undo",
            of: edited1,
            seq: undone.version,
        });
        expect(read(path).slice(unit.start, unit.end)).toBe(before);
    });

    test("an agent edit inside the same block since makes the undo a conflict, file untouched", async () => {
        const path = copySample();
        const session = await DocSession.open("0123456789ab", path);
        const { unit, after, undo } = await edited(session, path);
        await transact(path, (txn) => {
            applyEditIn(txn, {
                start: unit.start,
                before: after,
                after: `${after} Agent.`,
                cause: "apply",
                by: "agent",
                id: "c1",
            });
        });
        const bytes = readFileSync(path);
        expect(await undo()).toMatchObject({ ok: false, reason: "conflict" });
        expect(Buffer.compare(readFileSync(path), bytes)).toBe(0);
    });

    test("an agent edit above since moves the undo, which lands byte-exact", async () => {
        const path = copySample();
        const session = await DocSession.open("0123456789ab", path);
        const { source, unit, before, undo } = await edited(session, path);
        await transact(path, (txn) => {
            applyEditIn(txn, {
                start: 0,
                before: "",
                after: "Inserted above.\n\n",
                cause: "apply",
                by: "agent",
                id: "c1",
            });
        });
        const undone = await undo();
        expect(undone).toMatchObject({ ok: true, at: unit.start + "Inserted above.\n\n".length });
        expect(read(path)).toBe(`Inserted above.\n\n${source}`);
        expect(read(path).slice(undone.at!, undone.at! + before.length)).toBe(before);
    });

    test("an editor write touching the block since is a conflict; one elsewhere is not", async () => {
        const path = copySample();
        const session = await DocSession.open("0123456789ab", path);
        const { unit, after, undo } = await edited(session, path);
        const written = read(path);
        editorWrite(
            path,
            `${written.slice(0, unit.start + after.length)}!${written.slice(unit.start + after.length)}`,
        );
        expect(await undo()).toMatchObject({ ok: false, reason: "conflict" });
        expect(read(path)).toBe(
            `${written.slice(0, unit.start + after.length)}!${written.slice(unit.start + after.length)}`,
        );

        const other = await DocSession.open("0123456789ac", copySample("other.md"));
        const second = await edited(other, other.path);
        editorWrite(other.path, `${read(other.path)}\nTrailing.\n`);
        expect(await second.undo()).toMatchObject({ ok: true });
        expect(read(other.path)).toBe(`${second.source}\nTrailing.\n`);
    });
});

describe("retract", () => {
    const DOC = "# Title\n\nThe quick brown fox jumps over the lazy dog.\n\nA second paragraph.\n";

    async function setup(name = "doc.md") {
        const path = join(dir, name);
        writeFileSync(path, DOC);
        const session = await DocSession.open("0123456789ab", path);
        const anchor = (exact: string): Anchor => {
            const start = read(path).indexOf(exact);
            return createAnchor(read(path), { start, end: start + exact.length });
        };
        const { id } = await session.comment({ anchor: anchor("quick"), text: "Why?" });
        const thread = () => session.snapshot().threads.find((t) => t.id === id)!;
        const agent = async (...inputs: Parameters<typeof appendEvents>[1]) =>
            await appendEvents(path, inputs);
        return { path, session, id, thread, agent, anchor };
    }

    test("a reply is taken back with its message, once; the answer names its seq", async () => {
        const { session, id, thread, agent } = await setup();
        await agent({ type: "reply", by: "agent", id, text: "Because." });
        const replied = await session.reply(id, "Still why?");
        expect(replied.seq).toBe(3);
        expect(thread()).toMatchObject({ state: "open", messages: [{}, {}, { seq: 3 }] });
        expect(await session.retract(id, 3)).toMatchObject({ ok: true });
        expect(thread()).toMatchObject({ state: "replied", messages: [{ seq: 1 }, { seq: 2 }] });
        expect(await session.retract(id, 3)).toMatchObject({ ok: true });
        const retracts = (await events(session.path)).filter((event) => event.type === "retract");
        expect(retracts).toHaveLength(1);
        expect(retracts[0]).toMatchObject({ by: "user", id, of: 3 });
    });

    test.each<[string, (id: ThreadId) => EventInput]>([
        ["a claim", (id) => ({ type: "claim", by: "agent", ids: [id] })],
        [
            "a cursor past it naming the thread",
            (id) => ({ type: "cursor", by: "agent", stream: "watch", upTo: 2, ids: [id] }),
        ],
        [
            "a cursor past it from an older log, which names no threads",
            () => ({ type: "cursor", by: "agent", stream: "watch", upTo: 2 }),
        ],
        ["an agent reply", (id) => ({ type: "reply", by: "agent", id, text: "Ok" })],
    ])("is refused as seen after %s, and nothing is appended", async (_, event) => {
        const { session, id, thread, agent } = await setup();
        await session.reply(id, "More");
        await agent(event(id));
        const count = (await events(session.path)).length;
        expect(await session.retract(id, 2)).toEqual({ ok: false, reason: "seen", version: 3 });
        expect((await events(session.path)).length).toBe(count);
        expect(thread().messages.some((message) => message.seq === 2)).toBe(true);
    });

    test("a cursor short of the event, or a claim of another thread, is not seen", async () => {
        const { session, id, agent, anchor } = await setup();
        const { id: other } = await session.comment({ anchor: anchor("lazy"), text: "Hm" });
        await session.reply(id, "More");
        await agent(
            { type: "cursor", by: "agent", stream: "pending", upTo: 2 },
            { type: "claim", by: "agent", ids: [other] },
        );
        expect(await session.retract(id, 3)).toMatchObject({ ok: true });
    });

    test("a cursor past the event that named only other threads is not seen", async () => {
        const { session, id, agent, anchor } = await setup();
        const { id: other } = await session.comment({ anchor: anchor("lazy"), text: "Hm" });
        await session.reply(id, "More");
        await agent({ type: "cursor", by: "agent", stream: "watch", upTo: 3, ids: [other] });
        expect(await session.retract(id, 3)).toMatchObject({ ok: true });
    });

    test("a watch that moved its cursor past a reply and a resolve it never printed leaves both retractable", async () => {
        const { session, id, thread } = await setup();
        const replied = await session.reply(id, "Still why?");
        const resolved = await session.resolve(id);
        const printed: string[] = [];
        expect(await emitWatch(session.path, (text) => printed.push(text))).toBe(false);
        expect(printed).toEqual([]);
        expect((await events(session.path)).at(-1)).toMatchObject({
            type: "cursor",
            stream: "watch",
            upTo: resolved.seq,
            ids: [],
        });
        expect(await session.retract(id, resolved.seq)).toMatchObject({ ok: true });
        expect(await session.retract(id, replied.seq)).toMatchObject({ ok: true });
        expect(thread()).toMatchObject({ state: "open", messages: [{ seq: 1 }] });
    });

    test("a watch that printed the reply makes it seen", async () => {
        const { session, id } = await setup();
        const replied = await session.reply(id, "Still why?");
        const printed: string[] = [];
        expect(await emitWatch(session.path, (text) => printed.push(text))).toBe(true);
        expect(printed).toEqual([`new ${id} "Title"\n`]);
        expect(await session.retract(id, replied.seq)).toEqual({
            ok: false,
            reason: "seen",
            version: 3,
        });
    });

    test("a resolve taken back after an empty watch cursor wakes the watch again", async () => {
        const { session, id, thread } = await setup();
        const resolved = await session.resolve(id);
        const printed: string[] = [];
        const write = (text: string) => printed.push(text);
        expect(await emitWatch(session.path, write)).toBe(false);
        expect(await session.retract(id, resolved.seq)).toMatchObject({ ok: true });
        expect(thread().state).toBe("open");
        expect(threadStatus(thread(), Date.now())).toBe("open");
        const tail = new WakeTail(session.path, "watch", { signal: AbortSignal.timeout(5_000) });
        expect(await tail.next()).toBe(true);
        // Times are whole milliseconds, and the pill needs the cursor strictly after the comment.
        await Bun.sleep(2);
        expect(await emitWatch(session.path, write)).toBe(true);
        expect(printed).toEqual([`new ${id} "Title"\n`]);
        expect((await events(session.path)).at(-1)).toMatchObject({ type: "cursor", ids: [id] });
        await session.sync();
        expect(threadStatus(thread(), Date.now())).toBe("notified");
    });

    test("a resolve taken back after a user reply the watch passed unprinted wakes it as a reply", async () => {
        const { session, id, thread, agent } = await setup();
        await agent({ type: "reply", by: "agent", id, text: "Because." });
        await session.reply(id, "Still why?");
        const resolved = await session.resolve(id);
        const printed: string[] = [];
        const write = (text: string) => printed.push(text);
        expect(await emitWatch(session.path, write)).toBe(false);
        expect(await session.retract(id, resolved.seq)).toMatchObject({ ok: true });
        expect(threadStatus(thread(), Date.now())).toBe("open");
        expect(await emitWatch(session.path, write)).toBe(true);
        expect(printed).toEqual([`reply ${id} "Title"\n`]);
    });

    test("a retract that leaves the thread done does not wake the watch", async () => {
        const { session, id, agent } = await setup();
        await agent({ type: "reply", by: "agent", id, text: "Because." });
        const replied = await session.reply(id, "Still why?");
        await session.resolve(id);
        expect(await emitWatch(session.path, () => {})).toBe(false);
        expect(await session.retract(id, replied.seq)).toMatchObject({ ok: true });
        expect(await emitWatch(session.path, () => {})).toBe(false);
    });

    test("only the user's own thread events on that thread can be taken back", async () => {
        const { session, id, agent, anchor } = await setup();
        const { id: other } = await session.comment({ anchor: anchor("lazy"), text: "Hm" });
        await agent({ type: "reply", by: "agent", id, text: "Because." });
        const { seq } = await session.resolve(other);
        for (const [thread, of] of [
            [id, 3],
            [id, seq],
            [id, 99],
            [id, 1],
        ] as const) {
            await expect(session.retract(thread, of)).rejects.toMatchObject({ status: 404 });
        }
        expect(await session.retract(other, seq)).toMatchObject({ ok: true });
    });

    test("an accept is taken back byte-exact, the suggestion is pending again, and accepting again re-applies", async () => {
        const { path, session, id, thread, agent } = await setup();
        await agent(
            { type: "claim", by: "agent", ids: [id] },
            {
                type: "suggest",
                by: "agent",
                id,
                replace: "slow",
                apply: false,
            },
        );
        const bytes = readFileSync(path);
        const accepted = await session.accept(id);
        expect(accepted).toMatchObject({ ok: true, seq: 5 });
        expect(read(path)).toBe(DOC.replace("quick", "slow"));
        expect(await session.retract(id, 5)).toMatchObject({ ok: true });
        expect(Buffer.compare(readFileSync(path), bytes)).toBe(0);
        expect(thread()).toMatchObject({
            state: "replied",
            suggestion: { status: "pending", replace: "slow" },
        });
        const logged = await events(path);
        expect(logged.at(-2)).toMatchObject({ type: "edit", cause: "revert", by: "user", id });
        expect(logged.at(-1)).toMatchObject({ type: "retract", id, of: 5 });

        expect(await session.accept(id)).toMatchObject({ ok: true });
        expect(read(path)).toBe(DOC.replace("quick", "slow"));
        expect(thread()).toMatchObject({ state: "resolved", suggestion: { status: "accepted" } });
    });

    test("an agent edit on the accepted text since refuses the retract; one above moves it", async () => {
        const { path, session, id, thread, agent } = await setup();
        const suggestion = {
            type: "suggest",
            by: "agent",
            id,
            replace: "slow",
            apply: false,
        } as const;
        await agent(suggestion);
        const { seq } = await session.accept(id);
        await transact(path, (txn) => {
            applyEditIn(txn, {
                start: DOC.indexOf("quick"),
                before: "slow",
                after: "slower",
                cause: "apply",
                by: "agent",
                id: "c2",
            });
        });
        const bytes = readFileSync(path);
        const count = (await events(path)).length;
        expect(await session.retract(id, seq!)).toMatchObject({ ok: false, reason: "conflict" });
        expect(Buffer.compare(readFileSync(path), bytes)).toBe(0);
        expect((await events(path)).length).toBe(count);
        expect(thread()).toMatchObject({ state: "resolved", suggestion: { status: "accepted" } });

        const other = await setup("other.md");
        await other.agent(suggestion);
        const second = await other.session.accept(other.id);
        await transact(other.path, (txn) => {
            applyEditIn(txn, {
                start: 0,
                before: "# Title",
                after: "# A longer title",
                cause: "apply",
                by: "agent",
                id: "c2",
            });
        });
        expect(await other.session.retract(other.id, second.seq!)).toMatchObject({ ok: true });
        expect(read(other.path)).toBe(DOC.replace("# Title", "# A longer title"));
    });

    test("the page's answers carry the seq, and retract is a route", async () => {
        const path = join(dir, "doc.md");
        writeFileSync(path, DOC);
        const server = await serve();
        const docId = await open(server, path);
        const source = read(path);
        const start = source.indexOf("quick");
        const { id } = await call<{ id: ThreadId }>(server, docId, "comment", {
            anchor: createAnchor(source, { start, end: start + 5 }),
            text: "Why?",
        });
        const replied = await call<{ seq: number }>(server, docId, "reply", { id, text: "More" });
        expect(replied.seq).toBe(2);
        const resolved = await call<{ seq: number }>(server, docId, "resolve", { id });
        expect(resolved.seq).toBe(3);
        expect(await call(server, docId, "retract", { id, seq: 3 })).toMatchObject({ ok: true });
        expect(await call(server, docId, "retract", { id, seq: 2 })).toMatchObject({ ok: true });
        const thread = (await snapshot(server, docId)).threads[0]!;
        expect(thread).toMatchObject({ state: "open", messages: [{ seq: 1 }] });
        const bad = await fetch(`${server.origin}${routes.mutate(docId, "retract")}`, {
            method: "POST",
            headers: headers(server),
            body: JSON.stringify({ id, seq: "2" }),
        });
        expect(bad.status).toBe(400);
    });
});

describe("verdict and finish", () => {
    const DOC = "# Title\n\nThe quick brown fox jumps over the lazy dog.\n\nA second paragraph.\n";

    async function setup(source = DOC) {
        const path = join(dir, "doc.md");
        writeFileSync(path, source);
        const session = await DocSession.open("0123456789ab", path);
        const anchor = (exact: string): Anchor => {
            const start = read(path).indexOf(exact);
            return createAnchor(read(path), { start, end: start + exact.length });
        };
        const agent = async (...inputs: EventInput[]) => {
            await appendEvents(path, inputs);
            await session.sync();
        };
        /** `margin suggest --find`: a thread the agent opens with a pending suggestion. */
        const agentSuggest = async (exact: string, replace: string): Promise<ThreadId> => {
            const id = nextThreadId(await events(path));
            await agent({
                type: "suggest",
                by: "agent",
                id,
                anchor: anchor(exact),
                replace,
                apply: false,
            });
            return id;
        };
        const thread = (id: ThreadId) => session.snapshot().threads.find((t) => t.id === id)!;
        const logged = async (type: Event["type"]) =>
            (await events(path)).filter((event) => event.type === type);
        return { path, session, anchor, agent, agentSuggest, thread, logged };
    }

    test("an approval is refused with the ids of every unresolved thread, and logs nothing", async () => {
        const { session, anchor, agent, logged } = await setup();
        const open = await session.comment({ anchor: anchor("quick"), text: "Why?" });
        const replied = await session.comment({ anchor: anchor("lazy"), text: "Sure?" });
        await agent({ type: "reply", by: "agent", id: replied.id, text: "Yes." });
        const done = await session.comment({ anchor: anchor("second"), text: "Fine" });
        await session.resolve(done.id);
        const gone = await session.comment({ text: "A doc note" });
        await session.deleteThread(gone.id);
        await session.setHold(true);
        const draft = await session.comment({ anchor: anchor("Title"), text: "Held" });

        const refused = await session.setVerdict({ state: "approved" });
        expect(refused).toEqual({
            ok: false,
            reason: "unresolved",
            ids: [open.id, replied.id, draft.id],
            version: session.version,
        });
        expect(await logged("verdict")).toEqual([]);
        expect(session.snapshot().verdict).toBeUndefined();
    });

    test("an approval with nothing unresolved records the hash of the file under the lock", async () => {
        const { path, session, anchor, logged } = await setup();
        const { id } = await session.comment({ anchor: anchor("quick"), text: "Why?" });
        await session.resolve(id);
        // Not synced: the verdict's own reconcile must be what reads these bytes.
        editorWrite(path, DOC.replace("second", "third"));

        const approved = await session.setVerdict({ state: "approved" });
        expect(approved).toMatchObject({ ok: true, seq: session.version });
        const [event] = await logged("verdict");
        expect(event).toMatchObject({
            by: "user",
            state: "approved",
            hash: hashText(read(path)),
            seq: approved.seq,
        });
        expect(event).not.toHaveProperty("closed");
        expect(event).not.toHaveProperty("note");
        expect(session.snapshot().verdict).toEqual({
            state: "approved",
            seq: approved.seq!,
            at: event!.at,
            hash: session.snapshot().hash,
        });
    });

    test("the verdict's hash is of the decoded file, BOM and CRLF kept", async () => {
        const source = "\uFEFF# Title\r\n\r\nThe quick brown fox.\r\n";
        const { path, session, logged } = await setup(source);
        await session.setVerdict({ state: "approved" });
        const decoded = decodeSource(readFileSync(path));
        expect(decoded).toBe(source);
        expect(decoded.charCodeAt(0)).toBe(0xfeff);
        expect(await logged("verdict")).toMatchObject([{ hash: hashText(decoded) }]);
        expect(session.snapshot().verdict!.hash).toBe(hashText(decoded));
    });

    test("a thread another writer logged a moment before the request still refuses it", async () => {
        const { path, session, anchor } = await setup();
        await appendEvents(path, [
            {
                type: "comment",
                by: "user",
                id: "c1",
                anchor: anchor("quick"),
                text: "Wait",
                draft: false,
            },
        ]);
        expect(session.snapshot().threads).toEqual([]);
        expect(await session.setVerdict({ state: "approved" })).toMatchObject({
            ok: false,
            ids: ["c1"],
        });
    });

    test("approve as is closes the open threads in one verdict event and applies no suggestion", async () => {
        const { path, session, anchor, agentSuggest, thread } = await setup();
        const open = await session.comment({ anchor: anchor("lazy"), text: "Sure?" });
        const suggested = await agentSuggest("quick", "slow");
        const done = await session.comment({ anchor: anchor("second"), text: "Fine" });
        await session.resolve(done.id);
        const before = (await events(path)).length;

        const approved = await session.setVerdict({ state: "approved", asIs: true });
        expect(approved.ok).toBe(true);
        const after = await events(path);
        expect(after.slice(before)).toMatchObject([
            {
                type: "verdict",
                state: "approved",
                closed: [open.id, suggested],
                hash: hashText(DOC),
            },
        ]);
        expect(read(path)).toBe(DOC);
        expect(thread(open.id).state).toBe("resolved");
        expect(thread(suggested)).toMatchObject({
            state: "resolved",
            suggestion: { status: "rejected" },
        });
        expect(session.snapshot().verdict).toMatchObject({
            state: "approved",
            closed: [open.id, suggested],
        });
        expect(await session.setVerdict({ state: "approved" })).toMatchObject({ ok: true });
    });

    test("a drop leaves the open threads alone, and as-is means nothing on it", async () => {
        const { session, anchor, thread, logged } = await setup();
        const { id } = await session.comment({ anchor: anchor("quick"), text: "Why?" });
        const dropped = await session.setVerdict({ state: "dropped", asIs: true });
        expect(dropped).toMatchObject({ ok: true, seq: 2 });
        expect(thread(id).state).toBe("open");
        expect(session.snapshot().verdict).toMatchObject({ state: "dropped", seq: 2 });
        expect((await logged("verdict"))[0]).not.toHaveProperty("closed");
    });

    test("a reopen of an open doc logs nothing; of a dropped one, a verdict", async () => {
        const { session, logged } = await setup();
        const noop = await session.setVerdict({ state: "open" });
        expect(noop).toEqual({ ok: true, version: 0 });
        expect(await logged("verdict")).toEqual([]);

        await session.setVerdict({ state: "dropped" });
        const reopened = await session.setVerdict({ state: "open" });
        expect(reopened).toMatchObject({ ok: true, seq: 2 });
        expect(session.snapshot().verdict).toMatchObject({ state: "open", seq: 2 });
        expect(await session.setVerdict({ state: "open" })).toEqual({ ok: true, version: 2 });
        expect(await logged("verdict")).toHaveLength(2);
    });

    test("the user's own comment reopens an approved doc with no verdict event", async () => {
        const { session, anchor, logged } = await setup();
        await session.setVerdict({ state: "approved" });
        const { version } = await session.comment({ anchor: anchor("quick"), text: "One more" });
        expect(session.snapshot().verdict).toEqual({
            state: "open",
            seq: version,
            at: expect.any(String),
        });
        expect(await logged("verdict")).toHaveLength(1);
    });

    test("an edit after the approval keeps the verdict; its hash no longer matches the doc", async () => {
        const { path, session } = await setup();
        await session.setVerdict({ state: "approved" });
        expect(session.snapshot().verdict!.hash).toBe(session.snapshot().hash);

        editorWrite(path, DOC.replace("second", "third"));
        await session.sync();
        const afterUser = session.snapshot();
        expect(afterUser.verdict).toMatchObject({ state: "approved", hash: hashText(DOC) });
        expect(afterUser.hash).toBe(hashText(read(path)));
        expect(afterUser.hash).not.toBe(afterUser.verdict!.hash);

        const edited = await applyEdit(path, {
            start: read(path).indexOf("quick"),
            before: "quick",
            after: "slow",
            cause: "apply",
            by: "agent",
        });
        expect(edited.ok).toBe(true);
        await session.sync();
        expect(session.snapshot().verdict).toMatchObject({
            state: "approved",
            hash: hashText(DOC),
        });
    });

    test("nothing the agent logs gives, changes or clears a verdict", async () => {
        const { session, anchor, agent, agentSuggest, logged } = await setup();
        const { id } = await session.comment({ anchor: anchor("quick"), text: "Why?" });
        await agent(
            { type: "reply", by: "agent", id, text: "Because." },
            { type: "resolve", by: "agent", id },
        );
        // Every thread is resolved, by the agent: the doc is still not approved.
        expect(session.snapshot().verdict).toBeUndefined();

        const approved = await session.setVerdict({ state: "approved" });
        await agent({ type: "reply", by: "agent", id, text: "One more thing." });
        await agentSuggest("lazy", "sleepy");
        expect(session.snapshot().verdict).toMatchObject({ state: "approved", seq: approved.seq });
        expect(await logged("verdict")).toHaveLength(1);
        expect(await logged("finish")).toEqual([]);
    });

    test("the note is one trimmed line, left out when empty, and refused past the cap", async () => {
        const { session, logged } = await setup();
        await session.setVerdict({ state: "dropped", note: "  Not now.\r\n\n  Maybe later. " });
        expect(session.snapshot().verdict!.note).toBe("Not now. Maybe later.");
        await session.setVerdict({ state: "dropped", note: " \n " });
        expect(session.snapshot().verdict).not.toHaveProperty("note");
        await session.setVerdict({ state: "dropped", note: "x".repeat(MAX_VERDICT_NOTE) });
        expect(session.snapshot().verdict!.note).toHaveLength(MAX_VERDICT_NOTE);

        const tooLong = session.setVerdict({
            state: "dropped",
            note: "x".repeat(MAX_VERDICT_NOTE + 1),
        });
        await expect(tooLong).rejects.toMatchObject({ status: 400, error: "bad-request" });
        expect(await logged("verdict")).toHaveLength(3);
    });

    test("with the file gone, neither a verdict nor a finish is logged", async () => {
        const { path, session, anchor } = await setup();
        await session.comment({ anchor: anchor("quick"), text: "Why?" });
        rmSync(path);
        const count = (await events(path)).length;
        const gone = { status: 409, error: "missing" };
        await expect(session.setVerdict({ state: "dropped" })).rejects.toMatchObject(gone);
        await expect(session.setVerdict({ state: "open" })).rejects.toMatchObject(gone);
        await expect(session.requestFinish()).rejects.toMatchObject(gone);
        await session.sync();
        expect((await events(path)).length).toBe(count);

        rmSync(dir, { recursive: true });
        await expect(session.requestFinish()).rejects.toMatchObject(gone);
        await expect(session.setVerdict({ state: "dropped" })).rejects.toMatchObject(gone);
    });

    test("finish with nothing unresolved logs nothing", async () => {
        const { path, session, anchor } = await setup();
        const { id } = await session.comment({ anchor: anchor("quick"), text: "Why?" });
        await session.resolve(id);
        const count = (await events(path)).length;
        expect(await session.requestFinish()).toEqual({ ids: [], unapplied: [], version: 2 });
        expect((await events(path)).length).toBe(count);
        expect(session.snapshot().finish).toBeUndefined();
    });

    test("finish accepts the one pending agent suggestion as a click would, and wakes nobody", async () => {
        const { path, session, agentSuggest, thread } = await setup();
        const id = await agentSuggest("quick", "slow");
        const before = (await events(path)).length;
        await emitWatch(path, () => undefined);

        const finished = await session.requestFinish();
        expect(finished).toEqual({ ids: [], unapplied: [], version: session.version });
        expect(read(path)).toBe(DOC.replace("quick", "slow"));
        expect(thread(id)).toMatchObject({ state: "resolved", suggestion: { status: "accepted" } });
        const added = (await events(path)).slice(before).filter((event) => event.type !== "cursor");
        expect(added).toMatchObject([
            { type: "edit", by: "user", cause: "accept", id, before: "quick", after: "slow" },
            { type: "accept", by: "user", id },
        ]);
        expect(session.snapshot().hash).toBe(hashText(read(path)));

        const printed: string[] = [];
        expect(await emitWatch(path, (text) => printed.push(text))).toBe(false);
        expect(printed).toEqual([]);
        expect(await session.setVerdict({ state: "approved" })).toMatchObject({ ok: true });
    });

    test("finish applies suggestions in the order they were made, each on the source the last one left", async () => {
        const { path, session, anchor, agent, agentSuggest, logged } = await setup();
        const older = await session.comment({ anchor: anchor("quick brown"), text: "Shorter?" });
        const later = await agentSuggest("lazy", "sleepy");
        const last = await agentSuggest("second", "2nd");
        // The oldest thread gets the newest suggestion: it goes last, behind the two it shifts.
        await agent({
            type: "suggest",
            by: "agent",
            id: older.id,
            replace: "very quick and very brown",
            apply: false,
        });

        const finished = await session.requestFinish();
        expect(finished).toMatchObject({ ids: [], unapplied: [] });
        expect(read(path)).toBe(
            "# Title\n\nThe very quick and very brown fox jumps over the sleepy dog.\n\nA 2nd paragraph.\n",
        );
        expect((await logged("accept")).map((event) => "id" in event && event.id)).toEqual([
            later,
            last,
            older.id,
        ]);
        expect(await logged("outside")).toEqual([]);
        expect(await logged("finish")).toEqual([]);
    });

    test("a suggestion an earlier accept swallowed stays pending and is handed over", async () => {
        const { path, session, agentSuggest, thread, logged } = await setup();
        const first = await agentSuggest("quick brown fox", "cat");
        const second = await agentSuggest("brown", "red");

        const finished = await session.requestFinish();
        expect(finished).toMatchObject({ ids: [second], unapplied: [second] });
        expect(read(path)).toBe(DOC.replace("quick brown fox", "cat"));
        expect(thread(first)).toMatchObject({ state: "resolved" });
        expect(thread(second)).toMatchObject({ state: "open", suggestion: { status: "pending" } });
        expect(await logged("accept")).toHaveLength(1);
        expect(await logged("edit")).toHaveLength(1);
        expect(await logged("finish")).toMatchObject([
            { by: "user", ids: [second], seq: finished.seq },
        ]);
        expect(session.snapshot().finish).toMatchObject({ seq: finished.seq!, ids: [second] });
    });

    test("a partly overlapping suggestion lands where its anchor moved, as two clicks on accept would", async () => {
        const clicked = await setup();
        const one = await clicked.agentSuggest("quick brown", "slow");
        const two = await clicked.agentSuggest("brown fox", "red fox");
        await clicked.session.accept(one);
        await clicked.session.accept(two);
        const byHand = read(clicked.path);

        const { path, session, agentSuggest } = await setup();
        await agentSuggest("quick brown", "slow");
        await agentSuggest("brown fox", "red fox");
        expect(await session.requestFinish()).toMatchObject({ ids: [], unapplied: [] });
        expect(read(path)).toBe(byHand);
        expect(session.snapshot().hash).toBe(hashText(byHand));
    });

    test("a suggestion whose text is gone is left pending and the file untouched", async () => {
        const { path, session, agentSuggest, thread } = await setup();
        const id = await agentSuggest("quick brown fox", "cat");
        const edited = DOC.replace("The quick brown fox jumps", "Something else leaps");
        editorWrite(path, edited);
        await session.sync();

        const finished = await session.requestFinish();
        expect(finished).toMatchObject({ ids: [id], unapplied: [id] });
        expect(read(path)).toBe(edited);
        expect(thread(id)).toMatchObject({ state: "open", suggestion: { status: "pending" } });
    });

    test("finish hands over held drafts and the user's own suggestion in one event, with no send", async () => {
        const { path, session, anchor, thread, logged } = await setup();
        const open = await session.comment({ anchor: anchor("lazy"), text: "Sure?" });
        await session.setHold(true);
        const draft = await session.comment({ anchor: anchor("quick"), text: "Held" });
        const own = await session.suggest({ anchor: anchor("second"), replace: "2nd" });
        expect(thread(draft.id).state).toBe("draft");

        const finished = await session.requestFinish();
        expect(finished).toMatchObject({ ids: [open.id, draft.id, own.id], unapplied: [] });
        expect(read(path)).toBe(DOC);
        expect(thread(draft.id).state).toBe("open");
        expect(thread(own.id)).toMatchObject({ state: "open", suggestion: { status: "pending" } });
        expect(await logged("send")).toEqual([]);
        expect(await logged("finish")).toHaveLength(1);
    });

    test("finish reopens an approved doc, and the next verdict ends the request", async () => {
        const { session, anchor, agent } = await setup();
        const { id } = await session.comment({ anchor: anchor("quick"), text: "Why?" });
        await session.setVerdict({ state: "dropped" });
        const finished = await session.requestFinish();
        expect(session.snapshot()).toMatchObject({
            verdict: { state: "open", seq: finished.seq },
            finish: { ids: [id] },
        });
        await agent({ type: "resolve", by: "agent", id });
        expect(await session.setVerdict({ state: "approved" })).toMatchObject({ ok: true });
        expect(session.snapshot().finish).toBeUndefined();
    });

    test("finish keeps a BOM, CRLF and a missing trailing newline", async () => {
        const source = "﻿# Title\r\n\r\nThe quick brown fox.\r\n\r\nNo newline at the end";
        const { path, session, agentSuggest } = await setup(source);
        await agentSuggest("quick", "slow");
        await agentSuggest("newline", "line\r\nbreak");
        expect(await session.requestFinish()).toMatchObject({ ids: [], unapplied: [] });
        expect(
            readFileSync(path).equals(
                Buffer.from(
                    "﻿# Title\r\n\r\nThe slow brown fox.\r\n\r\nNo line\r\nbreak at the end",
                ),
            ),
        ).toBe(true);
    });
});
