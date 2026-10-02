import { describe, expect, test } from "bun:test";
import {
    STORED_CHANGE_MAX,
    STORED_KEY_MAX,
    STORED_VALUE_MAX,
    type PageBoot,
    type StoredChange,
} from "../server/protocol.ts";
import {
    DaemonStorage,
    daemonStorage,
    httpSend,
    recall,
    remember,
    type SendChange,
} from "./storage.ts";

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

    test("a failed write is sent again without another write, later each time; a newer value wins", async () => {
        const { sent, send } = recorder([false, "throw", true]);
        const storage = new DaemonStorage({}, send, 1, 100);
        storage.remember("margin:reply:c1", "one");
        storage.remember("margin:reply:c2", "kept");
        await tick(10);
        expect(sent.length).toBe(1);
        storage.remember("margin:reply:c1", "two");
        await tick(10);
        expect(sent.length).toBe(2);
        // The second failure in a row waits twice as long as the first would have.
        await tick(100);
        expect(sent.length).toBe(2);
        await tick(150);
        expect(sent.length).toBe(3);
        expect(sent[2]).toEqual({
            set: { "margin:reply:c1": "two", "margin:reply:c2": "kept" },
            delete: [],
        });
        await tick(60);
        await storage.flush(true);
        expect(sent.length).toBe(3);
    });

    test("a daemon that stays gone is given up on, until the next write", async () => {
        const { sent, send } = recorder(Array.from({ length: 20 }, () => false));
        const storage = new DaemonStorage({}, send, 1, 0);
        storage.remember("margin:reply:c1", "one");
        await tick(120);
        expect(sent.length).toBe(9);
        await tick(60);
        expect(sent.length).toBe(9);
        storage.remember("margin:reply:c2", "two");
        await tick(60);
        expect(sent.length).toBe(10);
        expect(sent[9]?.set).toEqual({ "margin:reply:c1": "one", "margin:reply:c2": "two" });
    });

    test("a value or key past the daemon's limits is kept for the tab and never sent", async () => {
        const { sent, send } = recorder();
        const storage = new DaemonStorage({ "margin:draft:a": "short" }, send, 1);
        const big = "v".repeat(STORED_VALUE_MAX + 1);
        const long = `margin:${"k".repeat(STORED_KEY_MAX)}`;
        storage.remember("margin:view", "{}");
        storage.remember("margin:draft:a", big);
        storage.remember(long, "v");
        expect(storage.recall("margin:draft:a")).toBe(big);
        expect(storage.recall(long)).toBe("v");
        await tick(10);
        expect(sent).toEqual([{ set: { "margin:view": "{}" }, delete: [] }]);
        storage.remember("margin:draft:a", "v".repeat(STORED_VALUE_MAX));
        storage.remember(long, null);
        await tick(10);
        expect(Object.keys(sent[1]?.set ?? {})).toEqual(["margin:draft:a"]);
        expect(sent[1]?.delete).toEqual([]);
    });

    test("more keys than one change may carry go out over several", async () => {
        const { sent, send } = recorder();
        const storage = new DaemonStorage({}, send, 1);
        for (let index = 0; index < STORED_CHANGE_MAX + 5; index++) {
            storage.remember(`margin:reply:c${index}`, "x");
        }
        await tick(20);
        expect(sent.map((change) => Object.keys(change.set ?? {}).length)).toEqual([
            STORED_CHANGE_MAX,
            5,
        ]);
    });
});

describe("httpSend", () => {
    test("only a 2xx counts as taken: a refusal leaves the keys to be sent again", async () => {
        const real = globalThis.fetch;
        const calls: { url: string; init: RequestInit }[] = [];
        let status = 200;
        globalThis.fetch = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response("{}", { status });
        }) as typeof fetch;
        try {
            const send = httpSend("aaaaaaaaaaaa", "token");
            expect(await send({ set: { "margin:view": "{}" } })).toBe(true);
            expect(calls[0]?.url).toBe("/api/docs/aaaaaaaaaaaa/stored");
            expect(calls[0]?.init).toMatchObject({
                method: "POST",
                keepalive: true,
                body: '{"set":{"margin:view":"{}"}}',
            });
            expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer token");
            for (status of [400, 403, 404, 500, 503]) {
                expect(await send({ set: { "margin:view": "{}" } })).toBe(false);
            }
        } finally {
            globalThis.fetch = real;
        }
    });
});
