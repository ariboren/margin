import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CHANGE_MAX,
    DOC_KEEP_MS,
    KEY_MAX,
    VALUE_MAX,
    pageStore,
    parseChange,
} from "./page-store.ts";
import { DEVICE_KEYS } from "./protocol.ts";

let root: string;
let path: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "margin-store-"));
    path = join(root, "page-store.json");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";

describe("pageStore", () => {
    test("nothing stored reads as empty and writes no file", () => {
        expect(pageStore(path).read(A)).toEqual({});
        expect(readdirSync(root)).toEqual([]);
    });

    test("settings are the device's; every other key belongs to the doc that set it", () => {
        const store = pageStore(path);
        store.apply(A, { set: { [DEVICE_KEYS.view]: "{}", "margin:reply:c1": "to a" } });
        store.apply(B, { set: { [DEVICE_KEYS.theme]: "dark", "margin:reply:c1": "to b" } });
        expect(store.read(A)).toEqual({
            [DEVICE_KEYS.view]: "{}",
            [DEVICE_KEYS.theme]: "dark",
            "margin:reply:c1": "to a",
        });
        expect(store.read(B)["margin:reply:c1"]).toBe("to b");
        expect(store.read("cccccccccccc")).toEqual({
            [DEVICE_KEYS.view]: "{}",
            [DEVICE_KEYS.theme]: "dark",
        });
    });

    test("a delete removes one key and leaves the rest", () => {
        const store = pageStore(path);
        store.apply(A, { set: { "margin:reply:c1": "one", "margin:reply:c2": "two" } });
        store.apply(A, { delete: ["margin:reply:c1", "margin:never-set"] });
        expect(store.read(A)).toEqual({ "margin:reply:c2": "two" });
        store.apply(A, { set: { [DEVICE_KEYS.theme]: "dark" } });
        store.apply(B, { delete: [DEVICE_KEYS.theme] });
        expect(store.read(A)).toEqual({ "margin:reply:c2": "two" });
    });

    test("the file is 0600, written whole, and leaves no temp file behind", () => {
        pageStore(path).apply(A, { set: { "margin:reply:c1": "text" } });
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readdirSync(root)).toEqual(["page-store.json"]);
        expect(JSON.parse(readFileSync(path, "utf8")).docs[A]["margin:reply:c1"].v).toBe("text");
    });

    test("two stores on one file keep each other's keys, as two daemons would", () => {
        const first = pageStore(path);
        const second = pageStore(path);
        first.apply(A, { set: { [DEVICE_KEYS.view]: "one", "margin:reply:c1": "first" } });
        second.apply(A, { set: { "margin:reply:c2": "second" } });
        first.apply(A, { set: { [DEVICE_KEYS.theme]: "dark" } });
        expect(second.read(A)).toEqual({
            [DEVICE_KEYS.view]: "one",
            [DEVICE_KEYS.theme]: "dark",
            "margin:reply:c1": "first",
            "margin:reply:c2": "second",
        });
    });

    test("a corrupt file is reported, read as empty and replaced by the next write", () => {
        const problems: unknown[] = [];
        const store = pageStore(path, { onCorrupt: (caught) => problems.push(caught) });
        writeFileSync(path, '{"device":{"margin:view":{"v":"x"');
        expect(store.read(A)).toEqual({});
        expect(problems.length).toBe(1);
        store.apply(A, { set: { [DEVICE_KEYS.view]: "y" } });
        expect(store.read(A)).toEqual({ [DEVICE_KEYS.view]: "y" });
    });

    test("entries of the wrong shape are dropped, the rest kept", () => {
        writeFileSync(
            path,
            JSON.stringify({
                device: { "margin:view": { v: "kept", at: 1 }, "margin:theme": "dark" },
                docs: { [A]: { "margin:reply:c1": { v: 3, at: 1 } }, [B]: null },
            }),
        );
        expect(pageStore(path).read(A)).toEqual({ "margin:view": "kept" });
        writeFileSync(path, "null");
        expect(pageStore(path).read(A)).toEqual({});
    });

    test("a doc nothing was stored for in 60 days loses its entries; settings never do", () => {
        let now = 1_000;
        const store = pageStore(path, { now: () => now });
        store.apply(A, { set: { [DEVICE_KEYS.view]: "{}", "margin:reply:c1": "old draft" } });
        now += DOC_KEEP_MS - 1;
        store.apply(B, { set: { "margin:reply:c1": "newer" } });
        expect(store.read(A)["margin:reply:c1"]).toBe("old draft");
        now += 2;
        store.apply(B, { set: { "margin:reply:c2": "newest" } });
        expect(store.read(A)).toEqual({ [DEVICE_KEYS.view]: "{}" });
        expect(Object.keys(store.read(B)).length).toBe(3);
    });

    test("over the size cap the oldest doc entries go first, settings stay", () => {
        let now = 0;
        const store = pageStore(path, { now: () => ++now, totalMax: 2_000 });
        store.apply(A, { set: { [DEVICE_KEYS.view]: "v".repeat(300) } });
        for (const id of ["c1", "c2", "c3", "c4"]) {
            store.apply(id === "c1" ? A : B, { set: { [`margin:reply:${id}`]: id.repeat(300) } });
        }
        expect(readFileSync(path, "utf8").length).toBeLessThanOrEqual(2_000);
        expect(Object.keys(store.read(A))).toEqual([DEVICE_KEYS.view]);
        const kept = Object.keys(store.read(B));
        expect(kept).toContain("margin:reply:c4");
        expect(kept).not.toContain("margin:reply:c2");
        expect(JSON.parse(readFileSync(path, "utf8")).docs[A]).toBeUndefined();
    });
});

describe("parseChange", () => {
    test("takes sets and deletes, each optional", () => {
        expect(parseChange({})).toEqual({ set: {}, delete: [] });
        expect(
            parseChange({ set: { "margin:view": "{}" }, delete: ["margin:draft:/a b/é.md"] }),
        ).toEqual({ set: { "margin:view": "{}" }, delete: ["margin:draft:/a b/é.md"] });
        expect(parseChange({ set: { "margin:x": "v".repeat(VALUE_MAX) } })).not.toBeNull();
        expect(parseChange({ delete: [`margin:${"k".repeat(KEY_MAX - 7)}`] })).not.toBeNull();
    });

    test("refuses a body, key or value off the rules", () => {
        const many = Object.fromEntries(
            Array.from({ length: CHANGE_MAX + 1 }, (_, index) => [`margin:${index}`, ""]),
        );
        for (const body of [
            null,
            [],
            "text",
            { set: [] },
            { set: null },
            { delete: {} },
            { set: { other: "v" } },
            { set: { "margin:x": 3 } },
            { set: { "margin:x": "v".repeat(VALUE_MAX + 1) } },
            { set: { [`margin:${"k".repeat(KEY_MAX)}`]: "v" } },
            { set: { "margin:a\nb": "v" } },
            { delete: ["margin:a\u0000b"] },
            { delete: [3] },
            { delete: ["__proto__"] },
            { set: many },
        ]) {
            expect(parseChange(body)).toBeNull();
        }
    });
});
