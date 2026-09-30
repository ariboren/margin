import { describe, expect, test } from "bun:test";
import { hashText } from "../core/blocks.ts";
import type { SaveResult } from "../core/model.ts";
import type { MutationName, WireSnapshot } from "../server/protocol.ts";
import { RequestError, ServerStore, type Connection, type Transport } from "./server-store.ts";

const SOURCE = "# Doc\n\nFirst paragraph.\n\nSecond paragraph.\n";

function wire(version: number, source = SOURCE, extra: Partial<WireSnapshot> = {}): WireSnapshot {
    return {
        docId: "0123456789ab",
        path: "/tmp/doc.md",
        source,
        hash: hashText(source),
        threads: [],
        edits: [],
        settings: { hold: false, suggestionsOnly: false, autoApply: false },
        missing: false,
        version,
        agentWatching: false,
        ...extra,
    };
}

interface Posted {
    name: MutationName;
    body: unknown;
}

/** A daemon stand-in: answers posts from a queue, pushes snapshots on demand. */
function fakeTransport(initial: WireSnapshot) {
    const posted: Posted[] = [];
    const answers: unknown[] = [];
    let latest = initial;
    let fetches = 0;
    let push: (wire: WireSnapshot) => void = () => {};
    let connect: (connection: Connection) => void = () => {};
    const transport: Transport = {
        fetchSnapshot: async () => {
            fetches++;
            return latest;
        },
        post: async (name, body) => {
            posted.push({ name, body });
            const answer = answers.shift();
            if (answer instanceof Error) {
                throw answer;
            }
            return answer as never;
        },
        listen(onSnapshot, onConnection) {
            push = onSnapshot;
            connect = onConnection;
            return () => {};
        },
        openFile: async () => ({ opened: "none" }),
        openUrl: async () => ({ opened: "none" }),
    };
    return {
        transport,
        posted,
        answer: (value: unknown) => answers.push(value),
        push: (next: WireSnapshot) => {
            latest = next;
            push(next);
        },
        /** The daemon moved on, but the stream never delivered it. */
        advance: (next: WireSnapshot) => {
            latest = next;
        },
        connect: (connection: Connection) => connect(connection),
        fetches: () => fetches,
    };
}

async function settled<T>(promise: Promise<T>): Promise<{ done: boolean; value?: T }> {
    let result: { done: boolean; value?: T } = { done: false };
    void (async () => {
        result = { done: true, value: await promise };
    })();
    await Bun.sleep(5);
    return result;
}

describe("ServerStore", () => {
    test("parses the pushed source and passes presence through", () => {
        const fake = fakeTransport(wire(3, SOURCE, { agentWatching: true }));
        const store = new ServerStore(fake.transport, wire(3, SOURCE, { agentWatching: true }));
        expect(store.snapshot().doc.source).toBe(SOURCE);
        expect(store.snapshot().doc.units.length).toBe(3);
        expect(store.snapshot().agentWatching).toBe(true);
        expect(store.snapshot().version).toBe(3);
    });

    test("a save sends the snapshot's version and resolves once its snapshot arrives", async () => {
        const fake = fakeTransport(wire(4));
        const store = new ServerStore(fake.transport, wire(4));
        const seen: number[] = [];
        store.subscribe((snapshot) => seen.push(snapshot.version));
        const start = SOURCE.indexOf("First");
        fake.answer({ ok: true, version: 5 });
        const saving = store.saveUnit({ start, before: "First paragraph.", after: "One." });
        const early = await settled(saving);
        expect(fake.posted).toEqual([
            {
                name: "save",
                body: { start, before: "First paragraph.", after: "One.", version: 4 },
            },
        ]);
        expect(early.done).toBe(false);
        const edited = SOURCE.replace("First paragraph.", "One.");
        fake.push(wire(5, edited));
        expect(await saving).toMatchObject({ ok: true });
        expect(store.snapshot().doc.source).toBe(edited);
        expect(seen).toEqual([5]);
    });

    test("a save that names its snapshot's version sends that one, not the newest", async () => {
        const fake = fakeTransport(wire(4));
        const store = new ServerStore(fake.transport, wire(4));
        fake.push(wire(6, SOURCE, { agentWatching: true }));
        fake.answer({ ok: true, version: 7 });
        const edit = { start: 0, before: "# Doc", after: "# Title", version: 4 };
        const saving = store.saveUnit(edit);
        await Bun.sleep(1);
        expect(fake.posted.at(-1)?.body).toEqual(edit);
        fake.push(wire(7));
        expect(await saving).toMatchObject({ ok: true });
    });

    test("a conflict waits for the snapshot that shows the other change", async () => {
        const fake = fakeTransport(wire(7));
        const store = new ServerStore(fake.transport, wire(7));
        const theirs = SOURCE.replace("Second paragraph.", "Agent text.");
        fake.answer({ ok: false, reason: "conflict", current: "Agent text.", version: 8 });
        const saving = store.saveUnit({
            start: SOURCE.indexOf("Second"),
            before: "Second paragraph.",
            after: "Mine.",
        });
        expect((await settled(saving)).done).toBe(false);
        fake.push(wire(8, theirs));
        const result: SaveResult = await saving;
        expect(result).toMatchObject({ ok: false, reason: "conflict", current: "Agent text." });
        expect(store.snapshot().doc.source).toBe(theirs);
    });

    test("with no push, a mutation fetches the snapshot after the settle time", async () => {
        const fake = fakeTransport(wire(1));
        const store = new ServerStore(fake.transport, wire(1), 20);
        fake.answer({ ok: true, version: 2 });
        fake.advance(
            wire(2, SOURCE, { settings: { hold: true, suggestionsOnly: false, autoApply: false } }),
        );
        await store.setHold(true);
        expect(fake.fetches()).toBe(1);
        expect(store.snapshot().settings.hold).toBe(true);
    });

    test("an older snapshot never replaces a newer one, and the parse is reused", () => {
        const fake = fakeTransport(wire(5));
        const store = new ServerStore(fake.transport, wire(5));
        const doc = store.snapshot().doc;
        fake.push(wire(4, "# Old\n"));
        expect(store.snapshot().version).toBe(5);
        fake.push(wire(5, SOURCE, { agentWatching: true }));
        expect(store.snapshot().agentWatching).toBe(true);
        expect(store.snapshot().doc).toBe(doc);
    });

    test("dismissing 'changed on disk' holds until the next outside change", () => {
        const first = "2026-09-30T10:00:00.000Z";
        const fake = fakeTransport(wire(2, SOURCE, { changedOnDisk: first }));
        const store = new ServerStore(fake.transport, wire(2, SOURCE, { changedOnDisk: first }));
        expect(store.snapshot().changedOnDisk).toBe(first);
        store.dismissChangedOnDisk();
        expect(store.snapshot().changedOnDisk).toBeUndefined();
        fake.push(wire(3, SOURCE, { changedOnDisk: first }));
        expect(store.snapshot().changedOnDisk).toBeUndefined();
        const second = "2026-09-30T10:05:00.000Z";
        fake.push(wire(4, SOURCE, { changedOnDisk: second }));
        expect(store.snapshot().changedOnDisk).toBe(second);
    });

    test("a refused request is reported and rethrown; the next success clears it", async () => {
        const fake = fakeTransport(wire(1));
        const store = new ServerStore(fake.transport, wire(1));
        fake.answer(new RequestError(503, { error: "locked" }));
        await expect(store.reply("c1", "Hi")).rejects.toThrow("locked");
        expect(store.status().problem).toContain("locked");
        fake.answer({ ok: true, version: 1 });
        await store.reply("c1", "Hi");
        expect(store.status().problem).toBeUndefined();
    });

    test("connection changes reach status listeners", () => {
        const fake = fakeTransport(wire(1));
        const store = new ServerStore(fake.transport, wire(1));
        const states: Connection[] = [];
        store.subscribeStatus((status) => states.push(status.connection));
        fake.connect("reconnecting");
        fake.connect("live");
        expect(states).toEqual(["reconnecting", "live"]);
    });
});
