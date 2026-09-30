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
import { join } from "node:path";
import { createAnchor } from "../core/anchor.ts";
import { decodeSource, flattenUnits, hashText, parseDoc } from "../core/blocks.ts";
import { appendEvents, readLog, transact, type LogTxn } from "../core/log.ts";
import { applyEdit, applyEditIn } from "../core/apply.ts";
import type { Event, SaveResult, ThreadId } from "../core/model.ts";
import { startServer, type MarginServer } from "./daemon.ts";
import { DocSession, mapStart, mapStartStrict } from "./session.ts";
import { routes, type MutationName, type WireSnapshot } from "./protocol.ts";

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
        expect(thread.anchor.exact).toBe("quick slow brown fox");
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
            expect(thread.anchor.exact).toBe("cold code path rarely runs");
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
        expect(thread.anchor.exact).toBe("cold path");
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
        expect(thread.anchor.exact).toBe("cold code path rarely runs");
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
        const page = await fetch(`${second.origin}${routes.page(docId)}?t=${second.token}`);
        expect(page.status).toBe(200);
        const thread = (await snapshot(second, docId)).threads[0]!;
        expect(thread.id).toBe("c1");
        expect(thread.messages[0]?.text).toBe("Tighten this");
        expect(thread.anchor.exact).toBe(anchor.exact);
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
                    downgraded: false,
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
