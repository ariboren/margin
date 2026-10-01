import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvents } from "../core/log.ts";
import type { ThreadId } from "../core/model.ts";
import { createThread } from "../core/threads.ts";
import { resolveThread } from "./commands.ts";
import { resolveDoc, type DocTarget } from "./doc.ts";
import { recordDoc } from "./registry.ts";

let dir: string;
let work: string;
let env: Record<string, string>;

beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "margin-doc-")));
    work = join(dir, "work");
    mkdirSync(work);
    env = { MARGIN_STATE_DIR: join(dir, "state") };
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** A recorded doc holding `threads` user notes (c1, c2, ...); later calls are newer in the registry. */
async function recorded(relativePath: string, threads: number): Promise<string> {
    const path = join(dir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# Title\n\nSome text.\n");
    for (let i = 0; i < threads; i++) {
        await createThread(path, (id) => [
            { type: "comment", by: "user", id, text: "Note", draft: false },
        ]);
    }
    await recordDoc(path, env);
    return path;
}

function find(id: ThreadId | undefined, options: { write?: boolean; cwd?: string } = {}) {
    return resolveDoc({
        ...(id ? { id } : {}),
        ...(options.write ? { write: true } : {}),
        cwd: options.cwd ?? work,
        env,
    });
}

function failure(id: ThreadId, error: "not-found" | "not-unique", detail: string): DocTarget {
    return { ok: false, ack: { ok: false, id, error, detail } };
}

describe("an id finds a recent doc outside the working directory", () => {
    test("the only doc holding the id, for reads and writes", async () => {
        const doc = await recorded("elsewhere/doc.md", 1);
        expect(await find("c1")).toEqual({ ok: true, path: doc });
        expect(await find("c1", { write: true })).toEqual({ ok: true, path: doc });
    });

    test("a doc reached through a symlink under the working directory", async () => {
        const doc = await recorded("elsewhere/doc.md", 1);
        symlinkSync(join(dir, "elsewhere"), join(work, "linked"));
        expect(await find("c1")).toEqual({ ok: true, path: doc });
    });

    test("a doc under the working directory wins over outside docs", async () => {
        const local = await recorded("work/doc.md", 1);
        await recorded("elsewhere/doc.md", 1);
        expect(await find("c1", { write: true })).toEqual({ ok: true, path: local });
    });

    test("a local doc without the id does not hide an outside doc with it", async () => {
        await recorded("work/doc.md", 1);
        const outside = await recorded("elsewhere/doc.md", 2);
        expect(await find("c2")).toEqual({ ok: true, path: outside });
    });

    test("several outside holders are named in full, newest first, at most three", async () => {
        const docs: string[] = [];
        for (const name of ["a", "b", "c", "d"]) docs.push(await recorded(`${name}/doc.md`, 1));
        const [, b, c, d] = docs;
        expect(await find("c1")).toEqual(
            failure("c1", "not-unique", `pass the doc: ${d} ${c} ${b}`),
        );
    });

    test("an id nobody holds names the recent docs", async () => {
        const outside = await recorded("elsewhere/doc.md", 1);
        expect(await find("c9")).toEqual(failure("c9", "not-found", `pass the doc: ${outside}`));
        await recorded("work/doc.md", 1);
        expect(await find("c9")).toEqual(failure("c9", "not-found", "pass the doc: doc.md"));
    });
});

describe("a write takes an outside doc only while the thread is unresolved", () => {
    test("a resolved thread is read but not written, and the error names its doc", async () => {
        const doc = await recorded("elsewhere/doc.md", 1);
        await resolveThread(doc, "c1");
        expect(await find("c1")).toEqual({ ok: true, path: doc });
        expect(await find("c1", { write: true })).toEqual(
            failure("c1", "not-found", `pass the doc: ${doc}`),
        );
    });

    test("a deleted thread is not written", async () => {
        const doc = await recorded("elsewhere/doc.md", 1);
        await appendEvents(doc, [{ type: "delete", by: "user", id: "c1" }]);
        expect(await find("c1", { write: true })).toEqual(
            failure("c1", "not-found", `pass the doc: ${doc}`),
        );
    });

    test("the one doc where the thread is unresolved wins a write; a read stays ambiguous", async () => {
        const stale = await recorded("old/doc.md", 1);
        await resolveThread(stale, "c1");
        const live = await recorded("new/doc.md", 1);
        expect(await find("c1", { write: true })).toEqual({ ok: true, path: live });
        expect(await find("c1")).toEqual(
            failure("c1", "not-unique", `pass the doc: ${live} ${stale}`),
        );
    });

    test("a thread resolved under the working directory does not hide the open one outside", async () => {
        const local = await recorded("work/doc.md", 1);
        await resolveThread(local, "c1");
        const outside = await recorded("elsewhere/doc.md", 1);
        expect(await find("c1", { write: true })).toEqual({ ok: true, path: outside });
        expect(await find("c1")).toEqual({ ok: true, path: local });

        await resolveThread(outside, "c1");
        expect(await find("c1", { write: true })).toEqual({ ok: true, path: local });
    });

    test("of several holders under the working directory, a write takes the unresolved one", async () => {
        const settled = await recorded("work/a.md", 1);
        await resolveThread(settled, "c1");
        const live = await recorded("work/b.md", 1);
        expect(await find("c1", { write: true })).toEqual({ ok: true, path: live });
        expect(await find("c1")).toEqual(failure("c1", "not-unique", "pass the doc: b.md a.md"));

        await resolveThread(live, "c1");
        expect(await find("c1", { write: true })).toEqual(
            failure("c1", "not-unique", "pass the doc: b.md a.md"),
        );
    });

    test("under the working directory a resolved thread still resolves its doc", async () => {
        const doc = await recorded("work/doc.md", 1);
        await resolveThread(doc, "c1");
        expect(await find("c1", { write: true })).toEqual({ ok: true, path: doc });
    });
});

test("without an id only docs under the working directory count", async () => {
    await recorded("elsewhere/doc.md", 1);
    expect(await find(undefined)).toEqual({
        ok: false,
        ack: { ok: false, error: "not-found", detail: "pass the doc" },
    });
    const local = await recorded("work/doc.md", 0);
    await appendEvents(local, [{ type: "cursor", by: "agent", stream: "pending", upTo: 0 }]);
    expect(await find(undefined)).toEqual({ ok: true, path: local });
});
