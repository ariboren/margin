import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startServer, type MarginServer } from "./daemon.ts";
import { withPresence } from "./presence.ts";

const FOREMAN = { name: "foreman", client: "claude-code" } as const;
import { BOOT_ELEMENT, routes, type PageBoot, type WireSnapshot } from "./protocol.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");

let root: string;
let server: MarginServer;
const openedUrls: string[] = [];
const openedFiles: string[] = [];
const revealedFiles: string[] = [];

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "margin-daemon-"));
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "docs"), { recursive: true });
    writeFileSync(join(root, "outside.md"), "# Outside the repo\n");
    const docs = join(root, "repo", "docs");
    for (const name of [
        "run.command",
        "build.sh",
        "tool.py",
        "page.html",
        "icon.svg",
        join("Tool.app", "Contents"),
    ]) {
        mkdirSync(dirname(join(docs, name)), { recursive: true });
        writeFileSync(join(docs, name), "#!/bin/sh\necho pwned\n", { mode: 0o755 });
    }
    writeFileSync(join(root, "payload.command"), "#!/bin/sh\necho pwned\n", { mode: 0o755 });
    symlinkSync(join(root, "payload.command"), join(docs, "escape.md"));
    symlinkSync(join(docs, "run.command"), join(docs, "alias.md"));
    for (const name of ["edge-bom.md", "edge-crlf.md", "edge-nonl.md"]) {
        copyFileSync(join(FIXTURES, name), join(root, "repo", "docs", name));
    }
    // A directory named "<" puts "</script>" into the path.
    mkdirSync(join(root, "repo", "docs", "<"));
    writeFileSync(join(root, "repo", "docs", "<", "script>.md"), "# Odd name\n");
    server = await startServer({
        env: { ORCA_WORKTREE_ID: "x" },
        openUrl: async (url) => {
            openedUrls.push(url);
            return "orca";
        },
        openFile: async (path) => {
            openedFiles.push(path);
            return "system";
        },
        revealFile: async (path) => {
            revealedFiles.push(path);
            return path.endsWith("edge-nonl.md") ? "none" : "system";
        },
    });
});

afterAll(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
});

const docPath = (name: string) => join(root, "repo", "docs", name);
const withToken = (path: string) => `${server.origin}${path}?t=${server.token}`;

describe("opening files and links", () => {
    const post = async (path: string, body: unknown, headers?: Record<string, string>) =>
        await fetch(`${server.origin}${path}`, {
            method: "POST",
            headers: headers ?? { authorization: `Bearer ${server.token}`, origin: server.origin },
            body: JSON.stringify(body),
        });

    test("open-file with no link opens the doc's own path", async () => {
        const { docId } = await server.register(docPath("edge-crlf.md"));
        const response = await post(routes.openFile(docId), {});
        expect(await response.json()).toEqual({ opened: "system" });
        expect(openedFiles.at(-1)).toBe(server.session(docId)!.path);
    });

    test("open-file follows a relative link only to a file inside the repository", async () => {
        const { docId } = await server.register(docPath("edge-crlf.md"));
        const response = await post(routes.openFile(docId), { link: "edge-bom.md#part" });
        expect(response.status).toBe(200);
        expect(openedFiles.at(-1)).toBe(server.session(docId)!.path.replace("crlf", "bom"));
        const count = openedFiles.length;
        for (const link of ["missing.md", "/etc/hosts", "https://x.test"]) {
            expect((await post(routes.openFile(docId), { link })).status).toBe(404);
        }
        expect((await post(routes.openFile(docId), { link: 3 })).status).toBe(400);
        expect(openedFiles.length).toBe(count);
    });

    test("executables, directories and anything outside the repository are refused unspawned", async () => {
        const { docId } = await server.register(docPath("edge-crlf.md"));
        const count = openedFiles.length;
        for (const link of [
            "run.command",
            "build.sh",
            "Tool.app",
            // They launch or run script: the Python Launcher, a browser from file://.
            "tool.py",
            "page.html",
            "icon.svg",
            // A `.md` name on symlinks: one to an executable outside the repo, one inside it.
            "escape.md",
            "alias.md",
            "../../outside.md",
            "../docs",
        ]) {
            const response = await post(routes.openFile(docId), { link });
            expect({ link, status: response.status }).toEqual({ link, status: 403 });
            expect(await response.json()).toEqual({ error: "not-openable" });
        }
        expect(openedFiles.length).toBe(count);
    });

    test("open-file with reveal shows the doc's own path, whatever else the page sends", async () => {
        const { docId } = await server.register(docPath("edge-crlf.md"));
        const path = server.session(docId)!.path;
        const opens = openedFiles.length;
        for (const body of [{ reveal: true }, { reveal: true, path: "/etc/hosts" }]) {
            const response = await post(routes.openFile(docId), body);
            expect(await response.json()).toEqual({ opened: "system" });
            expect(revealedFiles.at(-1)).toBe(path);
        }
        expect(openedFiles.length).toBe(opens);
        const reveals = revealedFiles.length;
        await post(routes.openFile(docId), { reveal: false });
        expect(openedFiles.at(-1)).toBe(path);
        expect(revealedFiles.length).toBe(reveals);
    });

    test("reveal takes no link and only a boolean", async () => {
        const { docId } = await server.register(docPath("edge-crlf.md"));
        const count = revealedFiles.length + openedFiles.length;
        for (const body of [
            { reveal: true, link: "edge-bom.md" },
            { reveal: true, link: "/etc/hosts" },
            { reveal: "/etc/hosts" },
            { reveal: 1 },
        ]) {
            const response = await post(routes.openFile(docId), body);
            expect({ body, status: response.status }).toEqual({ body, status: 400 });
        }
        expect(revealedFiles.length + openedFiles.length).toBe(count);
    });

    test("reveal answers none when no command worked", async () => {
        const { docId } = await server.register(docPath("edge-nonl.md"));
        const response = await post(routes.openFile(docId), { reveal: true });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ opened: "none" });
    });

    test("a doc missing on disk is neither opened nor revealed", async () => {
        const path = docPath("gone.md");
        writeFileSync(path, "# Going\n");
        const { docId } = await server.register(path);
        renameSync(path, `${path}.away`);
        const deadline = Date.now() + 5_000;
        while (!server.session(docId)!.isMissing && Date.now() < deadline) {
            await Bun.sleep(20);
        }
        const count = revealedFiles.length + openedFiles.length;
        for (const body of [{ reveal: true }, {}]) {
            const response = await post(routes.openFile(docId), body);
            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({ error: "not-found" });
        }
        expect(revealedFiles.length + openedFiles.length).toBe(count);
    });

    test("open-url takes http(s) only", async () => {
        const { docId } = await server.register(docPath("edge-crlf.md"));
        const ok = await post(routes.openUrl(docId), { url: "https://example.com/a?b=1" });
        expect(await ok.json()).toEqual({ opened: "orca" });
        expect(openedUrls.at(-1)).toBe("https://example.com/a?b=1");
        for (const url of ["file:///etc/hosts", "javascript:alert(1)", "not a url"]) {
            expect((await post(routes.openUrl(docId), { url })).status).toBe(400);
        }
    });

    test("both need the token and a same-origin POST", async () => {
        const { docId } = await server.register(docPath("edge-crlf.md"));
        for (const path of [routes.openFile(docId), routes.openUrl(docId)]) {
            expect((await post(path, {}, { origin: server.origin })).status).toBe(403);
            expect((await post(path, {}, { authorization: `Bearer ${server.token}` })).status).toBe(
                403,
            );
            const get = await fetch(`${server.origin}${path}`, {
                headers: { authorization: `Bearer ${server.token}` },
            });
            expect(get.status).toBe(404);
        }
    });
});

describe("page URLs", () => {
    const get = async (path: string, query = `?t=${server.token}`) =>
        await fetch(`${server.origin}${path}${query}`, { redirect: "manual" });

    test("carry the short id and the file name, and serve the page there", async () => {
        const { docId, url } = await server.register(docPath("edge-crlf.md"));
        const short = docId.slice(0, 8);
        expect(url).toBe(`${server.origin}/d/${short}/edge-crlf.md?t=${server.token}`);
        expect((await fetch(url, { redirect: "manual" })).status).toBe(200);
    });

    test("encode the file name", async () => {
        const { url } = await server.register(join(root, "repo", "docs", "<", "script>.md"));
        expect(new URL(url).pathname).toEndWith("/script%3E.md");
        expect((await fetch(url, { redirect: "manual" })).status).toBe(200);
    });

    test("a wrong or missing file name redirects to the canonical URL, token kept", async () => {
        const { docId, url } = await server.register(docPath("edge-crlf.md"));
        const canonical = url.slice(server.origin.length);
        for (const path of [
            `/d/${docId.slice(0, 8)}/other.md`,
            `/d/${docId.slice(0, 8)}/%E0%A4%A`,
            `/d/${docId.slice(0, 8)}/`,
            `/d/${docId.slice(0, 8)}`,
            `/d/${docId}/edge-crlf.md`,
        ]) {
            const response = await get(path);
            expect({ path, status: response.status }).toEqual({ path, status: 302 });
            expect(response.headers.get("location")).toBe(canonical);
        }
    });

    test("a legacy full-id URL redirects with its whole query", async () => {
        const { docId, url } = await server.register(docPath("edge-crlf.md"));
        const response = await get(`/d/${docId}`, `?t=${server.token}&x=1`);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(
            `${new URL(url).pathname}?t=${server.token}&x=1`,
        );
    });

    test("without the token nothing redirects, and the file name never leaks", async () => {
        const { docId } = await server.register(docPath("edge-crlf.md"));
        for (const query of ["", "?t=wrong"]) {
            for (const path of [`/d/${docId}`, `/d/${docId.slice(0, 8)}/edge-crlf.md`]) {
                const response = await get(path, query);
                expect(response.status).toBe(403);
                expect(response.headers.get("location")).toBeNull();
            }
        }
    });

    test("an unknown id is not found", async () => {
        for (const path of ["/d/00000000/x.md", "/d/000000000000", "/d/000000000000/x.md"]) {
            expect((await get(path)).status).toBe(404);
        }
    });

    test("two docs with one name get distinct ids and each serves its own path", async () => {
        const first = join(root, "repo", "one", "notes.md");
        const second = join(root, "repo", "two", "notes.md");
        for (const path of [first, second]) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, "# Notes\n");
        }
        const a = await server.register(first);
        const b = await server.register(second);
        expect(a.docId).not.toBe(b.docId);
        expect(new URL(a.url).pathname).not.toBe(new URL(b.url).pathname);
        for (const { docId, url } of [a, b]) {
            const html = await (await fetch(url, { redirect: "manual" })).text();
            expect(html).toContain(`"path":${JSON.stringify(server.session(docId)!.path)}`);
        }
    });
});

describe("page boot data", () => {
    const bootOf = async (url: string): Promise<{ html: string; boot: PageBoot }> => {
        const html = await (await fetch(url)).text();
        const match = new RegExp(
            `<script type="application/json" id="${BOOT_ELEMENT}">(.*?)</script>`,
        ).exec(html);
        return { html, boot: JSON.parse(match![1]!) as PageBoot };
    };

    test("carries the path and the repo-relative path", async () => {
        const { docId, url } = await server.register(docPath("edge-bom.md"));
        const { boot } = await bootOf(url);
        expect(boot).toEqual({
            docId,
            path: server.session(docId)!.path,
            relativePath: "docs/edge-bom.md",
        });
    });

    test("a path cannot close the script element", async () => {
        const { url } = await server.register(join(root, "repo", "docs", "<", "script>.md"));
        const { html, boot } = await bootOf(url);
        expect(boot.relativePath).toBe("docs/</script>.md");
        expect(html.match(/<\/script>/g)?.length).toBe(2);
    });
});

/** A tab's event stream, one pushed snapshot per `next()`. */
async function snapshotStream(from: MarginServer, docId: string) {
    const abort = new AbortController();
    const response = await fetch(`${from.origin}${routes.events(docId)}?t=${from.token}`, {
        signal: abort.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (): Promise<WireSnapshot> => {
        while (true) {
            const end = buffer.indexOf("\n\n");
            if (end >= 0) {
                const block = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = block.split("\n").find((line) => line.startsWith("data: "));
                if (data) {
                    return JSON.parse(data.slice("data: ".length)) as WireSnapshot;
                }
                continue;
            }
            const { value, done } = await reader.read();
            if (done) {
                throw new Error("stream ended");
            }
            buffer += decoder.decode(value, { stream: true });
        }
    };
    return { next, abort };
}

describe("agent presence", () => {
    test("the snapshot says whether a watcher holds the presence file", async () => {
        const { docId } = await server.register(docPath("edge-nonl.md"));
        const get = async () =>
            (await (await fetch(withToken(routes.snapshot(docId)))).json()) as WireSnapshot;
        expect((await get()).agents).toEqual([]);
        await withPresence(docPath("edge-nonl.md"), FOREMAN, async () => {
            expect((await get()).agents).toEqual([FOREMAN]);
        });
        expect((await get()).agents).toEqual([]);
    });

    test("a presence change is pushed to open tabs without any log event", async () => {
        const { docId } = await server.register(docPath("edge-nonl.md"));
        const { next, abort } = await snapshotStream(server, docId);
        const first = await next();
        expect(first.agents).toEqual([]);
        await withPresence(docPath("edge-nonl.md"), FOREMAN, async () => {
            const pushed = await next();
            expect(pushed.agents).toEqual([FOREMAN]);
            expect(pushed.version).toBe(first.version);
        });
        expect((await next()).agents).toEqual([]);
        abort.abort();
    });
});

describe("the agent that opened the doc", () => {
    const REVIEWER = { name: "reviewer", client: "codex" } as const;
    let waiting: MarginServer;
    let count = 0;

    beforeAll(async () => {
        waiting = await startServer({ expectedMs: 60_000 });
    });
    afterAll(async () => {
        await waiting.stop();
    });

    const fresh = (): string => {
        const path = join(root, "repo", "docs", `expected-${++count}.md`);
        writeFileSync(path, "# Expected\n");
        return path;
    };
    const snapshotOf = async (from: MarginServer, docId: string) =>
        (await (
            await fetch(`${from.origin}${routes.snapshot(docId)}?t=${from.token}`)
        ).json()) as WireSnapshot;

    test("a person's open expects nobody; an agent's open names the agent", async () => {
        const path = fresh();
        const { docId } = await waiting.register(path);
        const first = await snapshotOf(waiting, docId);
        expect(first.agents).toEqual([]);
        expect("expected" in first).toBe(false);

        await waiting.register(path, FOREMAN);
        expect(await snapshotOf(waiting, docId)).toMatchObject({ agents: [], expected: FOREMAN });
    });

    test("a person's later open leaves it; another agent's open replaces it", async () => {
        const path = fresh();
        const { docId } = await waiting.register(path, FOREMAN);
        await waiting.register(path);
        expect((await snapshotOf(waiting, docId)).expected).toEqual(FOREMAN);
        await waiting.register(path, REVIEWER);
        expect((await snapshotOf(waiting, docId)).expected).toEqual(REVIEWER);
    });

    test("any watcher arriving ends the wait for good", async () => {
        const path = fresh();
        const { docId } = await waiting.register(path, FOREMAN);
        await withPresence(path, REVIEWER, async () => {
            const during = await snapshotOf(waiting, docId);
            expect(during.agents).toEqual([REVIEWER]);
            expect("expected" in during).toBe(false);
        });
        const after = await snapshotOf(waiting, docId);
        expect(after.agents).toEqual([]);
        expect("expected" in after).toBe(false);
    });

    test("an open while a watcher is connected expects nobody, also once it leaves", async () => {
        const path = fresh();
        const { docId } = await waiting.register(path);
        await withPresence(path, FOREMAN, async () => {
            await waiting.register(path, FOREMAN);
            expect("expected" in (await snapshotOf(waiting, docId))).toBe(false);
        });
        const after = await snapshotOf(waiting, docId);
        expect(after.agents).toEqual([]);
        expect("expected" in after).toBe(false);
    });

    test("the register route takes the agent and trusts none of it", async () => {
        const path = fresh();
        const post = async (body: unknown) =>
            (await (
                await fetch(`${waiting.origin}${routes.register}`, {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${waiting.token}`,
                        origin: waiting.origin,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify(body),
                })
            ).json()) as { docId: string };
        const { docId } = await post({ path, agent: FOREMAN });
        expect((await snapshotOf(waiting, docId)).expected).toEqual(FOREMAN);
        await post({ path, agent: { name: 7, client: "<script>" } });
        expect((await snapshotOf(waiting, docId)).expected).toEqual({
            name: "Agent",
            client: "unknown",
        });
    });

    test("the wait running out is pushed to open tabs and the agent is gone", async () => {
        const brief = await startServer({ expectedMs: 300 });
        try {
            const path = fresh();
            const { docId } = await brief.register(path, FOREMAN);
            const { next, abort } = await snapshotStream(brief, docId);
            const first = await next();
            expect(first.expected).toEqual(FOREMAN);
            const pushed = await next();
            expect(pushed.agents).toEqual([]);
            expect("expected" in pushed).toBe(false);
            expect(pushed.version).toBe(first.version);
            abort.abort();
        } finally {
            await brief.stop();
        }
    });
});

describe("client bundle", () => {
    test("with no build, the bundle routes answer 503 and never try to build", async () => {
        const empty = mkdtempSync(join(tmpdir(), "margin-noclient-"));
        const bare = await startServer({ clientDir: empty });
        try {
            for (const path of ["/app.js", "/app.css", "/assets/x.woff2"]) {
                const response = await fetch(`${bare.origin}${path}`);
                expect({ path, status: response.status }).toEqual({ path, status: 503 });
                expect(await response.json()).toEqual({
                    error: "internal",
                    detail: "client not built; run bun run build",
                });
            }
            expect(readdirSync(empty)).toEqual([]);
        } finally {
            await bare.stop();
            rmSync(empty, { recursive: true, force: true });
        }
    });
});

describe("dev reload", () => {
    const blocks = async function* (response: Response): AsyncGenerator<string> {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const end = buffer.indexOf("\n\n");
            if (end >= 0) {
                yield buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                continue;
            }
            const { value, done } = await reader.read();
            if (done) {
                return;
            }
            buffer += decoder.decode(value, { stream: true });
        }
    };
    const firstSnapshot = async (stream: AsyncGenerator<string>): Promise<string[]> => {
        // Not `for await`: leaving that loop early would close the stream.
        const seen: string[] = [];
        while (true) {
            const { value, done } = await stream.next();
            if (done) {
                throw new Error("stream ended");
            }
            seen.push(value);
            if (value.startsWith("event: snapshot")) {
                return seen;
            }
        }
    };
    const devData = (seen: string[]) =>
        seen
            .filter((block) => block.startsWith("event: dev\n"))
            .map((block) => block.split("\n")[1]);

    test("a normal server sends no dev stamp and reload does nothing", async () => {
        const { docId } = await server.register(docPath("edge-bom.md"));
        const abort = new AbortController();
        const response = await fetch(withToken(routes.events(docId)), { signal: abort.signal });
        const stream = blocks(response);
        server.reload();
        expect(devData(await firstSnapshot(stream))).toEqual([]);
        abort.abort();
    });

    test("a dev server stamps each stream and reload changes the stamp", async () => {
        const dev = await startServer({ dev: true, port: 0 });
        try {
            const { docId } = await dev.register(docPath("edge-bom.md"));
            const abort = new AbortController();
            const response = await fetch(`${dev.origin}${routes.events(docId)}?t=${dev.token}`, {
                signal: abort.signal,
            });
            const stream = blocks(response);
            const [before] = devData(await firstSnapshot(stream));
            expect(before).toMatch(/^data: \S+$/);
            dev.reload();
            const [after] = devData(await firstSnapshot(stream));
            expect(after).toMatch(/^data: \S+$/);
            expect(after).not.toBe(before);
            abort.abort();
        } finally {
            await dev.stop();
        }
    });
});

describe("idle exit", () => {
    const ping = async (idle: MarginServer, headers: Record<string, string>, status: number) => {
        const until = Date.now() + 600;
        while (Date.now() < until) {
            const response = await fetch(`${idle.origin}${routes.status}`, { headers });
            expect(response.status).toBe(status);
            await Bun.sleep(40);
        }
    };

    test("unauthenticated requests do not keep the daemon alive", async () => {
        let fired = 0;
        const idle = await startServer({
            idleMs: 200,
            onIdle: () => {
                fired++;
            },
        });
        try {
            await ping(idle, {}, 403);
            expect(fired).toBeGreaterThanOrEqual(1);
        } finally {
            await idle.stop();
        }
    });

    test("authenticated requests do", async () => {
        let fired = 0;
        const idle = await startServer({
            idleMs: 200,
            onIdle: () => {
                fired++;
            },
        });
        try {
            await ping(idle, { authorization: `Bearer ${idle.token}` }, 200);
            expect(fired).toBe(0);
            await Bun.sleep(400);
            expect(fired).toBeGreaterThanOrEqual(1);
        } finally {
            await idle.stop();
        }
    });
});

describe("verdict and finish routes", () => {
    const post = async (docId: string, action: "verdict" | "finish" | "comment", body: unknown) =>
        await fetch(`${server.origin}${routes.mutate(docId, action)}`, {
            method: "POST",
            headers: { authorization: `Bearer ${server.token}`, origin: server.origin },
            body: JSON.stringify(body),
        });

    async function register(name: string): Promise<string> {
        writeFileSync(docPath(name), "# Plan\n\nOne step.\n");
        return (await server.register(docPath(name))).docId;
    }

    test("a refusal is a 200 naming the threads; as is, the verdict lands in the snapshot", async () => {
        const docId = await register("verdict.md");
        const { id } = (await (await post(docId, "comment", { text: "A note" })).json()) as {
            id: string;
        };

        const refused = await post(docId, "verdict", { state: "approved" });
        expect(refused.status).toBe(200);
        expect(await refused.json()).toEqual({
            ok: false,
            reason: "unresolved",
            ids: [id],
            version: 1,
        });

        const approved = await post(docId, "verdict", {
            state: "approved",
            asIs: true,
            note: " Go\nahead ",
        });
        expect(approved.status).toBe(200);
        expect(await approved.json()).toEqual({ ok: true, seq: 2, version: 2 });
        const snapshot = server.session(docId)!.snapshot();
        expect(snapshot.verdict).toMatchObject({
            state: "approved",
            seq: 2,
            hash: snapshot.hash,
            note: "Go ahead",
            closed: [id],
        });

        const reopened = await post(docId, "verdict", { state: "open" });
        expect(await reopened.json()).toEqual({ ok: true, seq: 3, version: 3 });
        const again = await post(docId, "verdict", { state: "open" });
        expect(await again.json()).toEqual({ ok: true, version: 3 });
    });

    test("a malformed verdict is a bad request and logs nothing", async () => {
        const docId = await register("verdict-bad.md");
        for (const body of [
            {},
            { state: "done" },
            { state: "declined", note: 3 },
            { state: "declined", note: "x".repeat(201) },
            { state: "approved", asIs: "yes" },
        ]) {
            const response = await post(docId, "verdict", body);
            expect({ body, status: response.status }).toEqual({ body, status: 400 });
            expect(await response.json()).toMatchObject({ error: "bad-request" });
        }
        expect(server.session(docId)!.version).toBe(0);
    });

    test("finish answers with the ids handed over and the event's seq, or neither", async () => {
        const docId = await register("finish.md");
        const empty = await post(docId, "finish", {});
        expect(empty.status).toBe(200);
        expect(await empty.json()).toEqual({ ids: [], unapplied: [], version: 0 });

        const { id } = (await (await post(docId, "comment", { text: "A note" })).json()) as {
            id: string;
        };
        const finished = await post(docId, "finish", {});
        expect(await finished.json()).toEqual({ ids: [id], unapplied: [], seq: 2, version: 2 });
        expect(server.session(docId)!.snapshot().finish).toMatchObject({ seq: 2, ids: [id] });
    });
});
