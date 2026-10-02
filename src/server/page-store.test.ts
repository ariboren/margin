import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOC_KEEP_MS, pageStore, parseChange } from "./page-store.ts";
import { DEVICE_KEYS, STORED_CHANGE_MAX, STORED_KEY_MAX, STORED_VALUE_MAX } from "./protocol.ts";

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
    test("nothing stored reads as empty and writes no file", async () => {
        expect(pageStore(path).read(A)).toEqual({});
        expect(readdirSync(root)).toEqual([]);
    });

    test("settings are the device's; every other key belongs to the doc that set it", async () => {
        const store = pageStore(path);
        await store.apply(A, { set: { [DEVICE_KEYS.view]: "{}", "margin:reply:c1": "to a" } });
        await store.apply(B, { set: { [DEVICE_KEYS.theme]: "dark", "margin:reply:c1": "to b" } });
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

    test("a delete removes one key and leaves the rest", async () => {
        const store = pageStore(path);
        await store.apply(A, { set: { "margin:reply:c1": "one", "margin:reply:c2": "two" } });
        await store.apply(A, { delete: ["margin:reply:c1", "margin:never-set"] });
        expect(store.read(A)).toEqual({ "margin:reply:c2": "two" });
        await store.apply(A, { set: { [DEVICE_KEYS.theme]: "dark" } });
        await store.apply(B, { delete: [DEVICE_KEYS.theme] });
        expect(store.read(A)).toEqual({ "margin:reply:c2": "two" });
    });

    test("the file is 0600, written whole, and leaves no temp file behind", async () => {
        await pageStore(path).apply(A, { set: { "margin:reply:c1": "text" } });
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readdirSync(root).sort()).toEqual(["page-store.json", "page-store.json.lock"]);
        expect(JSON.parse(readFileSync(path, "utf8")).docs[A]["margin:reply:c1"].v).toBe("text");
    });

    test("two stores on one file keep each other's keys, as two daemons would", async () => {
        const first = pageStore(path);
        const second = pageStore(path);
        await first.apply(A, { set: { [DEVICE_KEYS.view]: "one", "margin:reply:c1": "first" } });
        await second.apply(A, { set: { "margin:reply:c2": "second" } });
        await first.apply(A, { set: { [DEVICE_KEYS.theme]: "dark" } });
        expect(second.read(A)).toEqual({
            [DEVICE_KEYS.view]: "one",
            [DEVICE_KEYS.theme]: "dark",
            "margin:reply:c1": "first",
            "margin:reply:c2": "second",
        });
    });

    test("writers in separate processes at the same moment lose no key", async () => {
        const script = `
            import { pageStore } from ${JSON.stringify(join(import.meta.dir, "page-store.ts"))};
            const [path, writer] = process.argv.slice(-2);
            const store = pageStore(path);
            for (let index = 0; index < 20; index++) {
                await store.apply("aaaaaaaaaaaa", { set: { ["margin:reply:" + writer + "-" + index]: writer } });
            }
        `;
        const writers = ["w1", "w2", "w3", "w4"].map((writer) =>
            Bun.spawn([process.execPath, "-e", script, path, writer], { stderr: "inherit" }),
        );
        expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual([0, 0, 0, 0]);
        expect(Object.keys(pageStore(path).read(A)).length).toBe(80);
    });

    test("writes at the same moment in one process lose no key either", async () => {
        const store = pageStore(path);
        await Promise.all(
            Array.from({ length: 20 }, (_, index) =>
                store.apply(A, { set: { [`margin:reply:c${index}`]: "x" } }),
            ),
        );
        expect(Object.keys(store.read(A)).length).toBe(20);
        expect(readdirSync(root).sort()).toEqual(["page-store.json", "page-store.json.lock"]);
    });

    test("a file that does not parse reads as empty and is set aside, whole, by the next write", async () => {
        const problems: unknown[] = [];
        const store = pageStore(path, { onCorrupt: (caught) => problems.push(caught) });
        const torn = '{"device":{"margin:view":{"v":"x"';
        for (const text of [torn, "null", "[]"]) {
            writeFileSync(path, text);
            expect(store.read(A)).toEqual({});
            expect(readFileSync(path, "utf8")).toBe(text);
            await store.apply(A, { set: { [DEVICE_KEYS.view]: "y" } });
            expect(store.read(A)).toEqual({ [DEVICE_KEYS.view]: "y" });
            expect(readFileSync(`${path}.unreadable`, "utf8")).toBe(text);
        }
        expect(problems.length).toBe(6);
    });

    test("a file that cannot be read is never replaced: the write is refused", async () => {
        const problems: unknown[] = [];
        const store = pageStore(path, { onCorrupt: (caught) => problems.push(caught) });
        await store.apply(A, { set: { [DEVICE_KEYS.view]: "kept", "margin:reply:c1": "kept" } });
        const whole = readFileSync(path, "utf8");
        // A directory in the file's place fails the read with EISDIR, not ENOENT.
        renameSync(path, `${path}.moved`);
        mkdirSync(path);
        expect(store.read(A)).toEqual({});
        await expect(store.apply(A, { set: { [DEVICE_KEYS.theme]: "dark" } })).rejects.toThrow();
        await store.apply(A, { delete: ["margin:reply:c1"] }).catch(() => undefined);
        expect(problems.length).toBe(3);
        expect(readdirSync(path)).toEqual([]);
        rmSync(path, { recursive: true });
        renameSync(`${path}.moved`, path);
        expect(readFileSync(path, "utf8")).toBe(whole);
        expect(store.read(A)).toEqual({ [DEVICE_KEYS.view]: "kept", "margin:reply:c1": "kept" });
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
    });

    test("a doc nothing was stored for in 60 days loses its entries; settings never do", async () => {
        let now = 1_000;
        const store = pageStore(path, { now: () => now });
        await store.apply(A, { set: { [DEVICE_KEYS.view]: "{}", "margin:reply:c1": "old draft" } });
        now += DOC_KEEP_MS - 1;
        await store.apply(B, { set: { "margin:reply:c1": "newer" } });
        expect(store.read(A)["margin:reply:c1"]).toBe("old draft");
        now += 2;
        await store.apply(B, { set: { "margin:reply:c2": "newest" } });
        expect(store.read(A)).toEqual({ [DEVICE_KEYS.view]: "{}" });
        expect(Object.keys(store.read(B)).length).toBe(3);
    });

    test("over the size cap the oldest doc entries go first, settings stay", async () => {
        let now = 0;
        const store = pageStore(path, { now: () => ++now, totalMax: 2_000 });
        await store.apply(A, { set: { [DEVICE_KEYS.view]: "v".repeat(300) } });
        for (const id of ["c1", "c2", "c3", "c4"]) {
            await store.apply(id === "c1" ? A : B, {
                set: { [`margin:reply:${id}`]: id.repeat(300) },
            });
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
        expect(parseChange({})).toEqual({ change: { set: {}, delete: [] }, skipped: [] });
        expect(
            parseChange({ set: { "margin:view": "{}" }, delete: ["margin:draft:/a b/é.md"] }),
        ).toEqual({
            change: { set: { "margin:view": "{}" }, delete: ["margin:draft:/a b/é.md"] },
            skipped: [],
        });
        const longest = `margin:${"k".repeat(STORED_KEY_MAX - 7)}`;
        expect(
            parseChange({ set: { "margin:x": "v".repeat(STORED_VALUE_MAX) }, delete: [longest] })
                ?.skipped,
        ).toEqual([]);
    });

    test("a key or value off the rules is skipped by name; the rest of the change stands", () => {
        const long = `margin:${"k".repeat(STORED_KEY_MAX)}`;
        expect(
            parseChange({
                set: {
                    "margin:view": "{}",
                    "margin:draft:big": "v".repeat(STORED_VALUE_MAX + 1),
                    "margin:number": 3,
                    "margin:a\nb": "v",
                    other: "v",
                    [long]: "v",
                },
                delete: ["margin:reply:c1", "margin:a\u0000b", "__proto__", long],
            }),
        ).toEqual({
            change: { set: { "margin:view": "{}" }, delete: ["margin:reply:c1"] },
            skipped: [
                "margin:draft:big",
                "margin:number",
                "margin:a\nb",
                "other",
                long,
                "margin:a\u0000b",
                "__proto__",
                long,
            ],
        });
    });

    test("refuses a body that is not a change at all", () => {
        const many = Object.fromEntries(
            Array.from({ length: STORED_CHANGE_MAX + 1 }, (_, index) => [`margin:${index}`, ""]),
        );
        for (const body of [
            null,
            [],
            "text",
            { set: [] },
            { set: null },
            { delete: {} },
            { delete: [3] },
            { set: many },
        ]) {
            expect(parseChange(body)).toBeNull();
        }
    });
});
