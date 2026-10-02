import { describe, expect, test } from "bun:test";
import type { PageBoot, StoredChange } from "../server/protocol.ts";
import { DaemonStorage, daemonStorage, recall, remember, type SendChange } from "./storage.ts";

const tick = async (ms = 0) => await new Promise((done) => setTimeout(done, ms));

function recorder(answers: (boolean | "throw")[] = []): { sent: StoredChange[]; send: SendChange } {
    const sent: StoredChange[] = [];
    return {
        sent,
        send: async (change) => {
            sent.push(change);
            const answer = answers.shift() ?? true;
            if (answer === "throw") {
                throw new Error("unreachable");
            }
            return answer;
        },
    };
}

const boot: PageBoot = { docId: "aaaaaaaaaaaa", path: "/doc.md", relativePath: "doc.md" };

describe("daemonStorage", () => {
    test("boot values are there at once, before any request", () => {
        const { sent, send } = recorder();
        const storage = daemonStorage({ ...boot, stored: { "margin:view": "{}" } }, send);
        expect(storage?.recall("margin:view")).toBe("{}");
        expect(storage?.recall("margin:theme")).toBeNull();
        expect(sent).toEqual([]);
    });

    test("a boot without stored values (an older daemon) gives no daemon storage", () => {
        expect(daemonStorage(boot, recorder().send)).toBeNull();
        expect(daemonStorage(null, recorder().send)).toBeNull();
    });
});

describe("recall and remember with no daemon page", () => {
    test("fall back to browser storage, and to nothing where that is missing", () => {
        expect(recall("margin:view")).toBeNull();
        remember("margin:view", "{}");
        remember("margin:view", null);
        const held = new Map<string, string>();
        Object.assign(globalThis, {
            localStorage: {
                getItem: (key: string) => held.get(key) ?? null,
                setItem: (key: string, value: string) => held.set(key, value),
                removeItem: (key: string) => held.delete(key),
            },
        });
        try {
            remember("margin:view", "{}");
            expect(recall("margin:view")).toBe("{}");
            remember("margin:view", null);
            expect(recall("margin:view")).toBeNull();
        } finally {
            Reflect.deleteProperty(globalThis, "localStorage");
        }
    });
});

describe("DaemonStorage", () => {
    test("writes are readable at once and sent together after the pause", async () => {
        const { sent, send } = recorder();
        const storage = new DaemonStorage({ "margin:reply:c2": "old" }, send, 5);
        storage.remember("margin:reply:c1", "h");
        storage.remember("margin:reply:c1", "hello");
        storage.remember("margin:reply:c2", null);
        expect(storage.recall("margin:reply:c1")).toBe("hello");
        expect(storage.recall("margin:reply:c2")).toBeNull();
        expect(sent).toEqual([]);
        await tick(20);
        expect(sent).toEqual([
            { set: { "margin:reply:c1": "hello" }, delete: ["margin:reply:c2"] },
        ]);
    });

    test("a value that did not change sends nothing", async () => {
        const { sent, send } = recorder();
        const storage = new DaemonStorage({ "margin:view": "{}" }, send, 1);
        storage.remember("margin:view", "{}");
        storage.remember("margin:gone", null);
        await tick(10);
        expect(sent).toEqual([]);
    });

    test("one request at a time: a write during a send goes out after it, in order", async () => {
        const sent: StoredChange[] = [];
        let release = (_taken: boolean) => {};
        const send: SendChange = async (change) => {
            sent.push(change);
            return sent.length === 1
                ? await new Promise<boolean>((done) => (release = done))
                : true;
        };
        const storage = new DaemonStorage({}, send, 1);
        storage.remember("margin:reply:c1", "one");
        await tick(10);
        storage.remember("margin:reply:c1", "two");
        await tick(10);
        expect(sent.length).toBe(1);
        release(true);
        await tick(10);
        expect(sent.map((change) => change.set)).toEqual([
            { "margin:reply:c1": "one" },
            { "margin:reply:c1": "two" },
        ]);
    });

    test("a closing tab sends what is pending now, even past a request in flight", async () => {
        const sent: StoredChange[] = [];
        const send: SendChange = async (change) => {
            sent.push(change);
            return sent.length === 1 ? await new Promise<boolean>(() => {}) : true;
        };
        const storage = new DaemonStorage({}, send, 1_000);
        storage.remember("margin:reply:c1", "one");
        void storage.flush();
        storage.remember("margin:reply:c2", "two");
        void storage.flush();
        expect(sent.length).toBe(1);
        void storage.flush(true);
        expect(sent[1]).toEqual({ set: { "margin:reply:c2": "two" }, delete: [] });
    });

    test("a failed write stays pending and goes with the next one; a newer value wins", async () => {
        const { sent, send } = recorder([false, "throw", true]);
        const storage = new DaemonStorage({}, send, 1);
        storage.remember("margin:reply:c1", "one");
        storage.remember("margin:reply:c2", "kept");
        await tick(10);
        expect(sent.length).toBe(1);
        storage.remember("margin:reply:c1", "two");
        await tick(10);
        expect(sent.length).toBe(2);
        await storage.flush(true);
        expect(sent.length).toBe(3);
        expect(sent[2]).toEqual({
            set: { "margin:reply:c1": "two", "margin:reply:c2": "kept" },
            delete: [],
        });
        await storage.flush(true);
        expect(sent.length).toBe(3);
    });
});
