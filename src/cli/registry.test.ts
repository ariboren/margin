import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECENT_DOCS_MAX, recentDocs, recordDoc } from "./registry.ts";

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
