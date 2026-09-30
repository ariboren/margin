import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startServer, type MarginServer } from "./daemon.ts";
import { withPresence } from "./presence.ts";
import { BOOT_ELEMENT, routes, type PageBoot, type WireSnapshot } from "./protocol.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");

let root: string;
let server: MarginServer;
const openedUrls: string[] = [];
const openedFiles: string[] = [];

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

describe("page boot data", () => {
    const bootOf = async (docId: string): Promise<{ html: string; boot: PageBoot }> => {
        const html = await (await fetch(withToken(routes.page(docId)))).text();
        const match = new RegExp(
            `<script type="application/json" id="${BOOT_ELEMENT}">(.*?)</script>`,
        ).exec(html);
        return { html, boot: JSON.parse(match![1]!) as PageBoot };
    };

    test("carries the path and the repo-relative path", async () => {
        const { docId } = await server.register(docPath("edge-bom.md"));
        const { boot } = await bootOf(docId);
        expect(boot).toEqual({
            docId,
            path: server.session(docId)!.path,
            relativePath: "docs/edge-bom.md",
        });
    });

    test("a path cannot close the script element", async () => {
        const { docId } = await server.register(join(root, "repo", "docs", "<", "script>.md"));
        const { html, boot } = await bootOf(docId);
        expect(boot.relativePath).toBe("docs/</script>.md");
        expect(html.match(/<\/script>/g)?.length).toBe(2);
    });
});

describe("agent presence", () => {
    test("the snapshot says whether a watcher holds the presence file", async () => {
        const { docId } = await server.register(docPath("edge-nonl.md"));
        const get = async () =>
            (await (await fetch(withToken(routes.snapshot(docId)))).json()) as WireSnapshot;
        expect((await get()).agentWatching).toBe(false);
        await withPresence(docPath("edge-nonl.md"), async () => {
            expect((await get()).agentWatching).toBe(true);
        });
        expect((await get()).agentWatching).toBe(false);
    });

    test("a presence change is pushed to open tabs without any log event", async () => {
        const { docId } = await server.register(docPath("edge-nonl.md"));
        const abort = new AbortController();
        const response = await fetch(withToken(routes.events(docId)), { signal: abort.signal });
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
        const first = await next();
        expect(first.agentWatching).toBe(false);
        await withPresence(docPath("edge-nonl.md"), async () => {
            const pushed = await next();
            expect(pushed.agentWatching).toBe(true);
            expect(pushed.version).toBe(first.version);
        });
        expect((await next()).agentWatching).toBe(false);
        abort.abort();
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
