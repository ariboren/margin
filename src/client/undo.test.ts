import { describe, expect, test } from "bun:test";
import { parseDoc } from "../core/blocks.ts";
import type {
    Connection,
    DocSnapshot,
    DocStore,
    EditEvent,
    SaveResult,
    StoreStatus,
    ThreadId,
} from "../core/model.ts";
import {
    DELETE_NOTICE_MS,
    REFUSAL_NOTICE_MS,
    UndoStack,
    describeEntry,
    recording,
    type Notice,
} from "./undo.ts";
import type { RetractResult } from "../server/protocol.ts";
import type { ThreadActions } from "./undo.ts";

const SOURCE = "# Doc\n\nFirst paragraph.\n\nSecond paragraph.\n";

const anchor = { exact: "First", prefix: "", suffix: " paragraph", hint: 7 };

interface Host extends DocStore {
    calls: string[];
    edits: EditEvent[];
    version: number;
    /** Next answers, by method; a function throws or returns. */
    answers: Partial<{
        save: (SaveResult & { version?: number })[];
        retract: RetractResult[];
        accept: SaveResult[];
        delete: Error[];
    }>;
    retract?: (id: ThreadId, seq: number) => Promise<RetractResult>;
    actions?: ThreadActions;
}

function edit(seq: number, start: number, before: string, after: string): EditEvent {
    return {
        seq,
        at: new Date(seq * 1000).toISOString(),
        by: "user",
        type: "edit",
        cause: "user",
        start,
        before,
        after,
        line: 1,
        headingPath: [],
    };
}

/** A store stand-in with versions and seqs like the daemon's; `retract` only when asked for. */
function host(options: { retract?: boolean } = {}): Host {
    const { retract = true } = options;
    const doc = parseDoc(SOURCE);
    const store: Host = {
        calls: [],
        edits: [],
        version: 0,
        answers: {},
        snapshot: (): DocSnapshot => ({
            path: "/tmp/doc.md",
            doc,
            threads: [],
            edits: store.edits,
            settings: { hold: false, autoApply: false },
            missing: false,
            version: store.version,
        }),
        subscribe: () => () => {},
        comment: async () => {
            store.calls.push("comment");
            return "c1";
        },
        suggest: async () => {
            store.calls.push("suggest");
            return "c2";
        },
        reply: async (id, text) => {
            store.calls.push(`reply ${id} ${text}`);
            store.version++;
        },
        accept: async (id) => {
            store.calls.push(`accept ${id}`);
            const answer = store.answers.accept?.shift() ?? { ok: true };
            return answer.ok ? { ...answer, seq: ++store.version } : answer;
        },
        reject: async (id, note) => {
            store.calls.push(`reject ${id}${note === undefined ? "" : ` ${note}`}`);
            store.version++;
        },
        resolve: async (id) => {
            store.calls.push(`resolve ${id}`);
            store.version++;
        },
        reopen: async (id) => {
            store.calls.push(`reopen ${id}`);
            store.version++;
        },
        deleteThread: async (id) => {
            store.calls.push(`delete ${id}`);
            const failure = store.answers.delete?.shift();
            if (failure) {
                throw failure;
            }
        },
        undeleteThread: async (id) => {
            store.calls.push(`undelete ${id}`);
        },
        revert: async () => ({ ok: true }),
        saveUnit: async (request) => {
            const { start, before, after } = request;
            const extra = request as { version?: number; strict?: boolean; undoes?: number };
            store.calls.push(
                `save ${start} ${JSON.stringify(before)}->${JSON.stringify(after)} v${extra.version}${extra.strict ? " strict" : ""}${extra.undoes === undefined ? "" : ` undoes ${extra.undoes}`}`,
            );
            const answer = store.answers.save?.shift();
            if (answer) {
                return answer;
            }
            const seq = ++store.version;
            store.edits = [...store.edits, edit(seq, start, before, after)];
            return { ok: true, version: seq, at: start };
        },
        followThrough: async () => {
            store.calls.push("follow-through");
            return "c3";
        },
        setHold: async () => {},
        sendAll: async () => {},
        setSetting: async () => {},
        dismissChangedOnDisk: () => {},
    };
    if (retract) {
        store.retract = async (id, seq) => {
            store.calls.push(`retract ${id} ${seq}`);
            return store.answers.retract?.shift() ?? { ok: true };
        };
        const withSeq = async (call: Promise<unknown>) => {
            await call;
            return { ok: true as const, seq: store.version };
        };
        store.actions = {
            reply: (id, text) => withSeq(store.reply(id, text)),
            reject: (id, note) => withSeq(store.reject(id, note)),
            resolve: (id) => withSeq(store.resolve(id)),
            reopen: (id) => withSeq(store.reopen(id)),
        };
    }
    return store;
}

function timers() {
    const pending: { done: () => void; ms: number; cleared: boolean }[] = [];
    return {
        pending,
        fire: () => pending.filter((timer) => !timer.cleared).forEach((timer) => timer.done()),
        set: (done: () => void, ms: number) => {
            const timer = { done, ms, cleared: false };
            pending.push(timer);
            return timer;
        },
        clear: (handle: unknown) => {
            if (handle) {
                (handle as { cleared: boolean }).cleared = true;
            }
        },
    };
}

function setup(options: { retract?: boolean; limit?: number } = {}) {
    const store = host(options);
    const clock = timers();
    const stack = new UndoStack(store, clock, options.limit);
    const notices: Notice[] = [];
    stack.subscribe((notice) => notices.push(notice));
    const page = recording(store, stack);
    return { store, stack, page, notices, clock };
}

describe("recording", () => {
    test("passes the host's status link through only when it has one", () => {
        const plain = setup();
        expect(plain.page.status).toBeUndefined();
        expect(plain.page.subscribeStatus).toBeUndefined();

        const store = host();
        const listeners: ((status: StoreStatus) => void)[] = [];
        store.status = () => ({ connection: "reconnecting" });
        store.subscribeStatus = (listener) => {
            listeners.push(listener);
            return () => listeners.splice(listeners.indexOf(listener), 1);
        };
        const page = recording(store, new UndoStack(store, timers()));
        expect(page.status?.()).toEqual({ connection: "reconnecting" });
        const seen: Connection[] = [];
        const stop = page.subscribeStatus?.((status) => seen.push(status.connection));
        listeners[0]?.({ connection: "lost" });
        stop?.();
        expect(seen).toEqual(["lost"]);
        expect(listeners).toHaveLength(0);
    });
});

describe("UndoStack", () => {
    test("undo and redo go in order, a new action clears redo, the cap drops the oldest", async () => {
        const { store, stack, page } = setup({ limit: 3 });
        await page.comment({ anchor, text: "one" });
        await page.deleteThread("c9");
        await page.resolve("c1");
        expect(stack.top).toEqual({
            kind: "thread",
            id: "c1",
            seq: 1,
            action: { type: "resolve" },
        });
        await stack.undo();
        await stack.undo();
        expect(store.calls.slice(-2)).toEqual(["retract c1 1", "undelete c9"]);
        expect(stack.canRedo).toBe(true);
        await stack.redo();
        expect(store.calls.at(-1)).toBe("delete c9");
        await page.reopen("c1");
        expect(stack.canRedo).toBe(false);
        // Four entries were pushed in all; only the last three remain.
        await page.resolve("c1");
        await stack.undo();
        await stack.undo();
        await stack.undo();
        expect(stack.canUndo).toBe(false);
        expect(store.calls.filter((call) => call.startsWith("retract"))).toHaveLength(3);
        expect(store.calls).not.toContain("delete c1");
    });

    test("an edit is undone by a strict save of its logged inverse, from its own version", async () => {
        const { store, stack, page } = setup();
        await page.saveUnit({ start: 7, before: "First paragraph.", after: "Changed." });
        expect(stack.top).toEqual({
            kind: "edit",
            last: { seq: 1, start: 7, before: "First paragraph.", after: "Changed." },
        });
        await stack.undo();
        expect(store.calls.at(-1)).toBe('save 7 "Changed."->"First paragraph." v1 strict undoes 1');
        await stack.redo();
        expect(store.calls.at(-1)).toBe('save 7 "First paragraph."->"Changed." v2 strict undoes 2');
        expect(stack.top).toEqual({
            kind: "edit",
            last: { seq: 3, start: 7, before: "First paragraph.", after: "Changed." },
        });
    });

    test("a save that logged nothing is not recorded", async () => {
        const { stack, page, store } = setup();
        store.answers.save = [{ ok: true }];
        await page.saveUnit({ start: 7, before: "x", after: "x" });
        expect(stack.canUndo).toBe(false);
    });

    test("a refused undo drops the entry with a notice; a missing file keeps it", async () => {
        const { store, stack, page, notices, clock } = setup();
        await page.saveUnit({ start: 7, before: "First paragraph.", after: "Changed." });
        store.answers.save = [{ ok: false, reason: "missing" }];
        await stack.undo();
        expect(stack.canUndo).toBe(true);
        expect(notices.every((notice) => notice === null)).toBe(true);
        store.answers.save = [{ ok: false, reason: "conflict", current: "Other." }];
        await stack.undo();
        expect(stack.canUndo).toBe(false);
        expect(stack.canRedo).toBe(false);
        expect(notices.at(-1)).toEqual({
            kind: "refused",
            text: "Can't undo: this text changed since.",
        });
        expect(clock.pending.at(-1)?.ms).toBe(REFUSAL_NOTICE_MS);
        clock.fire();
        expect(stack.current).toBeNull();
    });

    test("a new thread is undone by deleting it and redone by undeleting it", async () => {
        const { store, stack, page } = setup();
        await page.suggest({ anchor, replace: "x" });
        await page.followThrough(1, "carry on");
        await stack.undo();
        await stack.undo();
        await stack.redo();
        expect(store.calls).toEqual([
            "suggest",
            "follow-through",
            "delete c3",
            "delete c2",
            "undelete c2",
        ]);
    });

    test("delete shows the notice; its Undo is the stack's undo", async () => {
        const { store, stack, page, notices, clock } = setup();
        await page.deleteThread("c1");
        expect(notices).toEqual([{ kind: "deleted", id: "c1" }]);
        expect(clock.pending[0]?.ms).toBe(DELETE_NOTICE_MS);
        await stack.undo();
        expect(store.calls).toEqual(["delete c1", "undelete c1"]);
        expect(stack.current).toBeNull();
        await stack.redo();
        expect(store.calls.at(-1)).toBe("delete c1");
        expect(stack.current).toEqual({ kind: "deleted", id: "c1" });
    });

    test("the notice goes after DELETE_NOTICE_MS; the entry stays undoable", async () => {
        const { stack, page, clock } = setup();
        await page.deleteThread("c1");
        clock.fire();
        expect(stack.current).toBeNull();
        expect(stack.canUndo).toBe(true);
    });

    test("a second action takes the notice down, so Undo is always the top entry", async () => {
        const { store, stack, page, clock } = setup();
        await page.deleteThread("c1");
        await page.deleteThread("c2");
        expect(clock.pending[0]?.cleared).toBe(true);
        expect(stack.current).toEqual({ kind: "deleted", id: "c2" });
        await page.resolve("c3");
        expect(stack.current).toBeNull();
        await stack.undo();
        expect(store.calls.at(-1)).toBe("retract c3 1");
    });

    test("a failed delete is not recorded and shows no notice", async () => {
        const { stack, page, store, notices } = setup();
        store.answers.delete = [new Error("gone")];
        await expect(page.deleteThread("c1")).rejects.toThrow("gone");
        expect(stack.canUndo).toBe(false);
        expect(notices).toEqual([]);
    });

    test("a reply is taken back with retract and redone as a new reply", async () => {
        const { store, stack, page } = setup();
        await page.reply("c1", "hello");
        await page.reject("c2", "no");
        await page.accept("c3");
        await stack.undo();
        await stack.undo();
        await stack.undo();
        expect(store.calls.slice(3)).toEqual(["retract c3 3", "retract c2 2", "retract c1 1"]);
        await stack.redo();
        await stack.redo();
        await stack.redo();
        expect(store.calls.slice(6)).toEqual(["reply c1 hello", "reject c2 no", "accept c3"]);
        expect(stack.top).toEqual({ kind: "thread", id: "c3", seq: 6, action: { type: "accept" } });
    });

    test("a reply the agent has read cannot be taken back: notice, entry dropped", async () => {
        const { store, stack, page, notices } = setup();
        await page.reply("c1", "hello");
        store.answers.retract = [{ ok: false, reason: "seen" }];
        await stack.undo();
        expect(stack.canUndo).toBe(false);
        expect(stack.canRedo).toBe(false);
        expect(notices.at(-1)).toEqual({
            kind: "refused",
            text: "Can't undo: the agent has already read c1.",
        });
    });

    test("an accept whose text changed since is not undone, and not redone either", async () => {
        const { store, stack, page, notices } = setup();
        await page.accept("c1");
        store.answers.retract = [{ ok: false, reason: "conflict" }];
        await stack.undo();
        expect(notices.at(-1)).toEqual({
            kind: "refused",
            text: "Can't undo: the text changed since the suggestion was accepted.",
        });
        await page.accept("c2");
        await stack.undo();
        store.answers.accept = [{ ok: false, reason: "conflict", current: "" }];
        await stack.redo();
        expect(stack.canRedo).toBe(false);
        expect(notices.at(-1)).toEqual({
            kind: "refused",
            text: "Can't redo: the quoted text changed since.",
        });
    });

    test("thread actions are not recorded on a store that cannot take them back", async () => {
        const { stack, page } = setup({ retract: false });
        await page.reply("c1", "hello");
        await page.resolve("c1");
        expect(stack.canUndo).toBe(false);
    });

    test("a second undo while one is in flight is ignored", async () => {
        const { store, stack, page } = setup();
        await page.deleteThread("c1");
        await page.deleteThread("c2");
        await Promise.all([stack.undo(), stack.undo()]);
        expect(store.calls.filter((call) => call.startsWith("undelete"))).toEqual(["undelete c2"]);
    });

    test("an action landing during an undo keeps its place; the undone entry goes", async () => {
        const { store, stack, page } = setup();
        await page.deleteThread("c1");
        let release = () => {};
        const undelete = store.undeleteThread;
        store.undeleteThread = async (id) => {
            await new Promise<void>((done) => (release = done));
            await undelete(id);
        };
        const undoing = stack.undo();
        await page.resolve("c2");
        release();
        await undoing;
        expect(stack.top).toEqual({
            kind: "thread",
            id: "c2",
            seq: 1,
            action: { type: "resolve" },
        });
        expect(stack.canRedo).toBe(false);
        await stack.undo();
        expect(stack.canUndo).toBe(false);
        expect(store.calls.filter((call) => call.startsWith("undelete"))).toEqual(["undelete c1"]);
    });

    test("top and next name what the buttons would undo and redo", async () => {
        const { stack, page } = setup();
        await page.comment({ anchor, text: "one" });
        await page.suggest({ anchor, replace: "x" });
        await page.followThrough(1, "carry on");
        await page.reply("c1", "hi");
        await page.saveUnit({ start: 7, before: "First paragraph.", after: "Changed." });
        await page.deleteThread("c2");
        const labels: string[] = [];
        while (stack.top) {
            labels.push(describeEntry(stack.top));
            await stack.undo();
        }
        expect(labels).toEqual(["delete", "edit", "reply", "comment", "suggestion", "comment"]);
        expect(stack.next).toEqual({ kind: "create", id: "c1", what: "comment" });
        expect(describeEntry(stack.next!)).toBe("comment");
    });

    test("onChange fires once the stacks have moved, after a push and after an undo or redo", async () => {
        const { stack, page } = setup();
        const seen: [boolean, boolean][] = [];
        stack.onChange(() => seen.push([stack.canUndo, stack.canRedo]));
        await page.resolve("c1");
        expect(seen).toEqual([[true, false]]);
        await stack.undo();
        expect(seen.at(-1)).toEqual([false, true]);
        await stack.redo();
        expect(seen.at(-1)).toEqual([true, false]);
        expect(seen).toHaveLength(3);
    });
});

describe("UndoStack.group", () => {
    test("the actions of a group become one entry, undone in reverse and redone in order", async () => {
        const { store, stack, page } = setup();
        await stack.group("resolve of 3 detached threads", async () => {
            await page.resolve("c1");
            await page.resolve("c2");
            await page.resolve("c3");
        });
        expect(stack.top?.kind).toBe("batch");
        expect(describeEntry(stack.top!)).toBe("resolve of 3 detached threads");
        await stack.undo();
        expect(store.calls.slice(3)).toEqual(["retract c3 3", "retract c2 2", "retract c1 1"]);
        expect(stack.canUndo).toBe(false);
        await stack.redo();
        expect(store.calls.slice(6)).toEqual(["resolve c1", "resolve c2", "resolve c3"]);
        expect(stack.top).toEqual({
            kind: "batch",
            label: "resolve of 3 detached threads",
            entries: [
                { kind: "thread", id: "c1", seq: 4, action: { type: "resolve" } },
                { kind: "thread", id: "c2", seq: 5, action: { type: "resolve" } },
                { kind: "thread", id: "c3", seq: 6, action: { type: "resolve" } },
            ],
        });
    });

    test("a group of one action is that action; an empty group records nothing", async () => {
        const { stack, page } = setup();
        await stack.group("resolve of 1 detached thread", async () => {
            await page.resolve("c1");
        });
        expect(stack.top).toEqual({
            kind: "thread",
            id: "c1",
            seq: 1,
            action: { type: "resolve" },
        });
        await stack.group("nothing", async () => {});
        expect(stack.top?.kind).toBe("thread");
    });

    test("a failure part way through keeps what landed as the entry", async () => {
        const { store, stack, page } = setup();
        const resolve = store.resolve;
        store.resolve = async (id) => {
            if (id === "c2") {
                throw new Error("daemon gone");
            }
            await resolve(id);
        };
        await expect(
            stack.group("resolve of 3 detached threads", async () => {
                for (const id of ["c1", "c2", "c3"] as const) {
                    await page.resolve(id);
                }
            }),
        ).rejects.toThrow("daemon gone");
        expect(stack.top).toEqual({
            kind: "thread",
            id: "c1",
            seq: 1,
            action: { type: "resolve" },
        });
    });

    test("parts the agent has read are refused; the rest are undone and stay redoable, with a notice", async () => {
        const { store, stack, page, notices } = setup();
        await stack.group("resolve of 3 detached threads", async () => {
            await page.resolve("c1");
            await page.resolve("c2");
            await page.resolve("c3");
        });
        store.answers.retract = [{ ok: true }, { ok: false, reason: "seen" }, { ok: true }];
        await stack.undo();
        expect(notices.at(-1)).toEqual({
            kind: "refused",
            text: "Undid 2 of 3: the agent has already read the rest.",
        });
        expect(stack.canRedo).toBe(true);
        await stack.redo();
        expect(store.calls.slice(6)).toEqual(["resolve c1", "resolve c3"]);
    });

    test("a batch the agent has read in full is dropped with one notice", async () => {
        const { store, stack, page, notices } = setup();
        await stack.group("resolve of 2 detached threads", async () => {
            await page.resolve("c1");
            await page.resolve("c2");
        });
        store.answers.retract = [
            { ok: false, reason: "seen" },
            { ok: false, reason: "seen" },
        ];
        await stack.undo();
        expect(stack.canUndo).toBe(false);
        expect(stack.canRedo).toBe(false);
        expect(notices.at(-1)).toEqual({
            kind: "refused",
            text: "Can't undo: the agent has already read these 2 threads.",
        });
    });

    test("a batch whose parts all changed nothing for now stays", async () => {
        const { store, stack, page } = setup();
        await stack.group("resolve of 2 detached threads", async () => {
            await page.resolve("c1");
            await page.resolve("c2");
        });
        store.answers.retract = [
            { ok: false, reason: "missing" },
            { ok: false, reason: "missing" },
        ];
        await stack.undo();
        expect(stack.canUndo).toBe(true);
    });
});
