import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type MarginServer } from "./daemon.ts";
import { routes, shortDocId } from "./protocol.ts";
import { hostAllowed, originAllowed, resolveImage, tokenMatches } from "./security.ts";

describe("checks", () => {
    test("token compare", () => {
        expect(tokenMatches("abc", "abc")).toBe(true);
        expect(tokenMatches("abd", "abc")).toBe(false);
        expect(tokenMatches("", "abc")).toBe(false);
        expect(tokenMatches(null, "abc")).toBe(false);
    });

    test("host allow-list is loopback on our port only", () => {
        expect(hostAllowed("127.0.0.1:80", 80)).toBe(true);
        expect(hostAllowed("localhost:80", 80)).toBe(true);
        expect(hostAllowed("127.0.0.1:81", 80)).toBe(false);
        expect(hostAllowed("evil.example:80", 80)).toBe(false);
        expect(hostAllowed(null, 80)).toBe(false);
    });

    test("origin must match when present and is required to change state", () => {
        expect(originAllowed(null, 80, "GET")).toBe(true);
        expect(originAllowed(null, 80, "POST")).toBe(false);
        expect(originAllowed("http://127.0.0.1:80", 80, "POST")).toBe(true);
        expect(originAllowed("http://evil.example", 80, "GET")).toBe(false);
        expect(originAllowed("http://127.0.0.1:81", 80, "POST")).toBe(false);
    });
});

let root: string;
let docDir: string;
let server: MarginServer;
let docId: string;

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "margin-security-"));
    docDir = join(root, "docs");
    mkdirSync(join(docDir, "img"), { recursive: true });
    writeFileSync(join(docDir, "doc.md"), "# Doc\n\nText.\n");
    writeFileSync(join(docDir, "img", "pic.png"), "png");
    writeFileSync(join(docDir, "notes.txt"), "not an image");
    writeFileSync(join(root, "secret.png"), "outside");
    symlinkSync(join(root, "secret.png"), join(docDir, "link.png"));
    symlinkSync(join(docDir, "img", "pic.png"), join(docDir, "inside.png"));
    server = await startServer();
    docId = (await server.register(join(docDir, "doc.md"))).docId;
});

afterAll(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
});

/** A request whose Host and path go out exactly as written (fetch would rewrite them). */
async function raw(lines: string[]): Promise<number> {
    const chunks: Uint8Array[] = [];
    const done = Promise.withResolvers<void>();
    const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port: server.port,
        socket: {
            data(_socket, data) {
                chunks.push(data);
            },
            close() {
                done.resolve();
            },
            error() {
                done.resolve();
            },
        },
    });
    socket.write(`${[...lines, "Connection: close", "", ""].join("\r\n")}`);
    await done.promise;
    const head = new TextDecoder().decode(Buffer.concat(chunks)).split("\r\n")[0] ?? "";
    return Number(head.split(" ")[1]);
}

function auth(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${server.token}`, ...extra };
}

describe("server", () => {
    test("bad Host gets 403", async () => {
        const path = routes.snapshot(docId);
        const token = `Authorization: Bearer ${server.token}`;
        expect(await raw([`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${server.port}`, token])).toBe(
            200,
        );
        expect(
            await raw([`GET ${path} HTTP/1.1`, `Host: evil.example:${server.port}`, token]),
        ).toBe(403);
        expect(await raw([`GET ${path} HTTP/1.1`, "Host: 127.0.0.1:1", token])).toBe(403);
    });

    test("bad Origin gets 403, and a state change needs one", async () => {
        const snapshot = `${server.origin}${routes.snapshot(docId)}`;
        const evil = await fetch(snapshot, { headers: auth({ origin: "http://evil.example" }) });
        expect(evil.status).toBe(403);
        const hold = `${server.origin}${routes.mutate(docId, "hold")}`;
        const body = JSON.stringify({ on: false });
        expect((await fetch(hold, { method: "POST", headers: auth(), body })).status).toBe(403);
        const ok = await fetch(hold, {
            method: "POST",
            headers: auth({ origin: server.origin }),
            body,
        });
        expect(ok.status).toBe(200);
    });

    test("missing or bad token gets 403 on every doc route", async () => {
        const urls = [
            routes.page(shortDocId(docId), "doc.md"),
            routes.page(shortDocId(docId), "other.md"),
            `/d/${docId}`,
            routes.snapshot(docId),
            routes.events(docId),
            routes.asset(docId, "img/pic.png"),
            routes.status,
        ];
        for (const path of urls) {
            expect((await fetch(`${server.origin}${path}`)).status).toBe(403);
            expect((await fetch(`${server.origin}${path}?t=wrong`)).status).toBe(403);
            const bad = await fetch(`${server.origin}${path}`, {
                headers: { authorization: "Bearer wrong" },
            });
            expect(bad.status).toBe(403);
        }
    });

    test("the page carries the CSP and no-referrer headers", async () => {
        const page = await fetch(
            `${server.origin}${routes.page(shortDocId(docId), "doc.md")}?t=${server.token}`,
        );
        expect(page.status).toBe(200);
        expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
        expect(page.headers.get("referrer-policy")).toBe("no-referrer");
        expect(await page.text()).not.toContain("<script>");
    });

    test("unregistered docs are not served", async () => {
        const other = `${server.origin}${routes.snapshot("0123456789ab")}`;
        expect((await fetch(other, { headers: auth() })).status).toBe(404);
    });
});

describe("images", () => {
    const get = async (path: string) =>
        await fetch(`${server.origin}/d/${docId}/asset/${path}?t=${server.token}`);

    test("an image inside the doc's directory is served with its type", async () => {
        const response = await get("img/pic.png");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect((await get("inside.png")).status).toBe(200);
    });

    test("traversal, encoded traversal, outside symlinks and non-images are refused", async () => {
        expect((await get("..%2Fsecret.png")).status).toBe(404);
        expect((await get("%2e%2e%2fsecret.png")).status).toBe(404);
        expect((await get("img/..%2F..%2Fsecret.png")).status).toBe(404);
        expect((await get("link.png")).status).toBe(404);
        expect((await get("notes.txt")).status).toBe(404);
        expect((await get("doc.md")).status).toBe(404);
        const dotted = await raw([
            `GET /d/${docId}/asset/../../secret.png?t=${server.token} HTTP/1.1`,
            `Host: 127.0.0.1:${server.port}`,
        ]);
        expect(dotted).not.toBe(200);
    });

    test("resolveImage stays inside the directory", () => {
        expect(resolveImage(docDir, "img/pic.png")?.type).toBe("image/png");
        expect(resolveImage(docDir, "../secret.png")).toBeNull();
        expect(resolveImage(docDir, join(root, "secret.png"))).toBeNull();
        expect(resolveImage(docDir, "link.png")).toBeNull();
        expect(resolveImage(docDir, "missing.png")).toBeNull();
    });
});
