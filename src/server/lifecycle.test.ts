import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonStatus, DocNotFoundError, openDoc, stopDaemon } from "./api.ts";
import { isAlive, readDaemonInfo, writeDaemonInfo } from "./paths.ts";
import { PROTOCOL_VERSION, routes, TOKEN_PARAM } from "./protocol.ts";

const PUBLIC_SAMPLE = join(import.meta.dir, "..", "..", "fixtures", "public-sample.md");

let root: string;
let doc: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "margin-life-"));
    doc = join(root, "doc.md");
    copyFileSync(PUBLIC_SAMPLE, doc);
    env = { ...process.env, MARGIN_STATE_DIR: join(root, "state"), MARGIN_NO_OPEN: "1" };
});

afterEach(async () => {
    await stopDaemon({ env });
    rmSync(root, { recursive: true, force: true });
});

const info = () => readDaemonInfo(join(root, "state", "daemon.json"));

describe("daemon lifecycle", () => {
    test("reuseTab opens no second tab while one shows the doc", async () => {
        const first = await openDoc(doc, { env, reuseTab: true });
        expect(first.reusedTab).toBe(false);

        const token = new URL(first.url).searchParams.get(TOKEN_PARAM);
        const abort = new AbortController();
        const tab = await fetch(
            `${new URL(first.url).origin}${routes.events(first.docId)}?${TOKEN_PARAM}=${token}`,
            { signal: abort.signal },
        );
        try {
            expect(tab.status).toBe(200);
            const again = await openDoc(doc, { env, reuseTab: true });
            expect(again).toMatchObject({ url: first.url, opened: "none", reusedTab: true });
            expect((await openDoc(doc, { env })).reusedTab).toBe(false);
        } finally {
            abort.abort();
        }
    });

    test("spawns once, then reuses; cold under 1 s, warm under 300 ms", async () => {
        let started = performance.now();
        const cold = await openDoc(doc, { env });
        const coldMs = performance.now() - started;
        started = performance.now();
        const warm = await openDoc(doc, { env });
        const warmMs = performance.now() - started;
        expect(cold.spawned).toBe(true);
        expect(warm.spawned).toBe(false);
        expect(warm.url).toBe(cold.url);
        expect(cold.opened).toBe("none");
        expect(coldMs).toBeLessThan(1_000);
        expect(warmMs).toBeLessThan(300);
        expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
        expect(statSync(join(root, "state", "daemon.json")).mode & 0o777).toBe(0o600);
        const page = await fetch(cold.url);
        expect(page.status).toBe(200);
    });

    test("concurrent opens start one daemon", async () => {
        const results = await Promise.all(
            Array.from({ length: 5 }, () => openDoc(doc, { env, openTab: false })),
        );
        expect(results.filter((result) => result.spawned)).toHaveLength(1);
        expect(new Set(results.map((result) => result.url)).size).toBe(1);
    });

    test("a stale daemon.json is replaced, and its pid is never signalled", async () => {
        const state = join(root, "state");
        await openDoc(doc, { env, openTab: false });
        const live = info()!;
        await stopDaemon({ env });
        // Point the file at a live pid that is not a daemon (this test) and a dead port.
        writeDaemonInfo(join(state, "daemon.json"), { ...live, pid: process.pid });
        const reopened = await openDoc(doc, { env, openTab: false });
        expect(reopened.spawned).toBe(true);
        expect(info()!.pid).not.toBe(process.pid);
        expect(isAlive(process.pid)).toBe(true);
    });

    test("a daemon speaking another protocol is stopped and replaced", async () => {
        await openDoc(doc, { env, openTab: false });
        const old = info()!;
        writeDaemonInfo(join(root, "state", "daemon.json"), {
            ...old,
            protocol: PROTOCOL_VERSION + 1,
        });
        const reopened = await openDoc(doc, { env, openTab: false });
        expect(reopened.spawned).toBe(true);
        expect(info()!.pid).not.toBe(old.pid);
    });

    test("stop removes the daemon and its file; status reports it", async () => {
        await openDoc(doc, { env, openTab: false });
        const status = await daemonStatus({ env });
        expect(status?.docs.map((entry) => entry.path)).toHaveLength(1);
        const { pid } = info()!;
        expect(await stopDaemon({ env })).toEqual({ stopped: true, pid });
        expect(isAlive(pid)).toBe(false);
        expect(existsSync(join(root, "state", "daemon.json"))).toBe(false);
        expect(await daemonStatus({ env })).toBeNull();
        expect(await stopDaemon({ env })).toEqual({ stopped: false });
    });

    test("exits when idle with no tab connected", async () => {
        const idleEnv = { ...env, MARGIN_IDLE_MS: "300" };
        await openDoc(doc, { env: idleEnv, openTab: false });
        const { pid } = info()!;
        const deadline = Date.now() + 3_000;
        while (isAlive(pid) && Date.now() < deadline) {
            await Bun.sleep(50);
        }
        expect(isAlive(pid)).toBe(false);
        expect(info()).toBeNull();
    });

    test("a missing doc throws DocNotFoundError", async () => {
        await expect(openDoc(join(root, "nope.md"), { env })).rejects.toBeInstanceOf(
            DocNotFoundError,
        );
    });
});
