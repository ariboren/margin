import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    RECENT_DOCS_MAX,
    SESSION_MAX_AGE_MS,
    recentDocs,
    recordDoc,
    sessionDocs,
} from "./registry.ts";

let dir: string;
let env: Record<string, string>;

beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "margin-registry-")));
    env = { MARGIN_STATE_DIR: join(dir, "state") };
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function doc(name: string): string {
    const path = join(dir, name);
    writeFileSync(path, "# x\n");
    return path;
}

test("newest first, no duplicates, in a private state dir", async () => {
    const a = doc("a.md");
    const b = doc("b.md");
    await recordDoc(a, env);
    await recordDoc(b, env);
    await recordDoc(a, env);
    expect(recentDocs(env)).toEqual([a, b]);
    expect(statSync(env.MARGIN_STATE_DIR!).mode & 0o777).toBe(0o700);
});

test("keeps at most the newest RECENT_DOCS_MAX docs", async () => {
    for (let i = 0; i <= RECENT_DOCS_MAX; i++) await recordDoc(doc(`${i}.md`), env);
    const list = recentDocs(env);
    expect(list).toHaveLength(RECENT_DOCS_MAX);
    expect(list[0]).toBe(join(dir, `${RECENT_DOCS_MAX}.md`));
});

test("a missing or corrupt registry reads as empty", () => {
    expect(recentDocs(env)).toEqual([]);
});

function sessionFiles(): string[] {
    return readdirSync(join(env.MARGIN_STATE_DIR!, "sessions")).filter((name) =>
        name.endsWith(".json"),
    );
}

describe("session docs", () => {
    test("each session lists its own docs, newest first, in a file only the user can read", async () => {
        const one = { ...env, MARGIN_SESSION: "one" };
        const two = { ...env, MARGIN_SESSION: "two" };
        const a = doc("a.md");
        const b = doc("b.md");
        await recordDoc(a, one);
        await recordDoc(b, one);
        await recordDoc(a, one);
        await recordDoc(b, two);
        expect(sessionDocs(one)).toEqual([a, b]);
        expect(sessionDocs(two)).toEqual([b]);
        expect(recentDocs(env)).toEqual([b, a]);
        const sessions = join(env.MARGIN_STATE_DIR!, "sessions");
        for (const name of sessionFiles()) {
            expect(statSync(join(sessions, name)).mode & 0o777).toBe(0o600);
        }
    });

    test("without a session nothing is listed and nothing is written", async () => {
        await recordDoc(doc("a.md"), env);
        expect(sessionDocs(env)).toEqual([]);
        expect(existsSync(join(env.MARGIN_STATE_DIR!, "sessions"))).toBe(false);
    });

    test("a session name that looks like a path stays one file under sessions/", async () => {
        const hostile = { ...env, MARGIN_SESSION: "../../escape" };
        const a = doc("a.md");
        await recordDoc(a, hostile);
        expect(sessionDocs(hostile)).toEqual([a]);
        expect(sessionFiles()).toHaveLength(1);
        expect(sessionFiles()[0]).toMatch(/^[0-9a-f]{32}\.json$/);
    });

    test("keeps at most the newest RECENT_DOCS_MAX docs", async () => {
        const session = { ...env, MARGIN_SESSION: "one" };
        for (let i = 0; i <= RECENT_DOCS_MAX; i++) await recordDoc(doc(`${i}.md`), session);
        const list = sessionDocs(session);
        expect(list).toHaveLength(RECENT_DOCS_MAX);
        expect(list[0]).toBe(join(dir, `${RECENT_DOCS_MAX}.md`));
    });

    test("a session nothing was recorded in for 30 days is dropped; a live one stays", async () => {
        const old = { ...env, MARGIN_SESSION: "old" };
        const live = { ...env, MARGIN_SESSION: "live" };
        const a = doc("a.md");
        await recordDoc(a, old);
        await recordDoc(a, live, Date.now() + SESSION_MAX_AGE_MS - 60_000);
        expect(sessionDocs(old)).toEqual([a]);
        await recordDoc(a, live, Date.now() + SESSION_MAX_AGE_MS + 60_000);
        expect(sessionDocs(old)).toEqual([]);
        expect(sessionDocs(live)).toEqual([a]);
        expect(sessionFiles()).toHaveLength(1);
    });
});
