import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    deviceDir,
    ensureStateDir,
    pageStorePath,
    readDaemonInfo,
    removeDaemonInfo,
    stateDir,
    writeDaemonInfo,
    type DaemonInfo,
} from "./paths.ts";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "margin-paths-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const info: DaemonInfo = { pid: 42, port: 1234, token: "secret", protocol: 1, startedAt: "now" };

describe("stateDir", () => {
    test("prefers MARGIN_STATE_DIR, then XDG_RUNTIME_DIR, never ~/.margin", () => {
        expect(stateDir({ MARGIN_STATE_DIR: "/x", XDG_RUNTIME_DIR: "/run" })).toBe("/x");
        expect(stateDir({ XDG_RUNTIME_DIR: "/run" })).toBe("/run/margin");
        expect(stateDir({})).toEndWith(join(".cache", "margin"));
    });
});

describe("deviceDir", () => {
    test("MARGIN_STATE_DIR wins; otherwise a per-user dir no logout wipes", () => {
        expect(deviceDir({ MARGIN_STATE_DIR: "/x", XDG_STATE_HOME: "/state" }, "linux")).toBe("/x");
        expect(deviceDir({ MARGIN_STATE_DIR: "/x" }, "darwin")).toBe("/x");
        expect(deviceDir({ XDG_RUNTIME_DIR: "/run" }, "darwin")).toEndWith(
            join("Library", "Application Support", "margin"),
        );
        expect(deviceDir({ XDG_RUNTIME_DIR: "/run", XDG_STATE_HOME: "/state" }, "linux")).toBe(
            "/state/margin",
        );
        expect(deviceDir({ XDG_RUNTIME_DIR: "/run" }, "linux")).toEndWith(
            join(".local", "state", "margin"),
        );
        expect(pageStorePath("/x")).toBe("/x/page-store.json");
    });
});

describe("ensureStateDir", () => {
    test("creates the dir 0700 and tightens a loose one", () => {
        const dir = ensureStateDir(join(root, "a", "state"));
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        const loose = join(root, "loose");
        mkdirSync(loose, { mode: 0o755 });
        ensureStateDir(loose);
        expect(statSync(loose).mode & 0o777).toBe(0o700);
    });

    test("refuses a symlink", () => {
        const real = join(root, "real");
        mkdirSync(real);
        const link = join(root, "link");
        symlinkSync(real, link);
        expect(() => ensureStateDir(link)).toThrow();
    });
});

describe("daemon info", () => {
    test("is written 0600 and read back", () => {
        const path = join(ensureStateDir(join(root, "s")), "daemon.json");
        writeDaemonInfo(path, info);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readDaemonInfo(path)).toEqual(info);
    });

    test("is removed only by the daemon it names", () => {
        const path = join(root, "daemon.json");
        writeDaemonInfo(path, info);
        removeDaemonInfo(path, 7);
        expect(readDaemonInfo(path)).not.toBeNull();
        removeDaemonInfo(path, 42);
        expect(readDaemonInfo(path)).toBeNull();
    });
});
