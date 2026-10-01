import { describe, expect, test } from "bun:test";
import type { AgentIdentity } from "../../core/model.ts";
import {
    DISCONNECT_MS,
    SEEN_MS,
    agentsFrom,
    announcedAbsence,
    connecting,
    inGrace,
    initialPresence,
    nextPresenceDeadline,
    shownAgents,
    updatePresence,
    type PresenceReading,
} from "./presence.ts";

const T0 = 1_000_000;
const foreman: AgentIdentity = { name: "foreman", client: "claude-code" };
const reviewer: AgentIdentity = { name: "reviewer", client: "codex" };

function reading(
    agents: AgentIdentity[] | undefined,
    connection = "live" as const,
): PresenceReading {
    return { agents, seenAt: undefined, connection };
}

describe("agentsFrom", () => {
    test("the daemon's list wins over recent activity", () => {
        const recent = new Date(T0 - 1_000).toISOString();
        expect(agentsFrom({ agents: [], seenAt: recent, connection: "live" }, T0)).toEqual([]);
        expect(agentsFrom(reading([foreman]), T0)).toEqual([foreman]);
    });

    test("without a reading, activity within the window is one unknown agent", () => {
        const within = new Date(T0 - SEEN_MS + 1_000).toISOString();
        const beyond = new Date(T0 - SEEN_MS - 1_000).toISOString();
        expect(agentsFrom({ agents: undefined, seenAt: within, connection: "live" }, T0)).toEqual([
            { name: "Agent", client: "unknown" },
        ]);
        expect(agentsFrom({ agents: undefined, seenAt: beyond, connection: "live" }, T0)).toEqual(
            [],
        );
        expect(agentsFrom(reading(undefined), T0)).toEqual([]);
    });
});

describe("updatePresence", () => {
    test("an unchanged reading returns the same state", () => {
        const state = initialPresence(reading([foreman]), T0);
        expect(updatePresence(state, reading([foreman]), T0 + 5_000)).toBe(state);
    });

    test("a short gap, as between a watcher's batches, stays in grace", () => {
        let state = initialPresence(reading([foreman]), T0);
        let now = T0 + 60_000;
        state = updatePresence(state, reading([]), now);
        now += 8_000;
        expect(inGrace(state, now)).toBe(true);
        expect(shownAgents(state, now)).toEqual([foreman]);
        state = updatePresence(state, reading([foreman]), now);
        expect(state.departed).toEqual([]);
    });

    test("gone past the grace: absent, still showing who was last here", () => {
        let state = initialPresence(reading([foreman]), T0);
        state = updatePresence(state, reading([]), T0 + 60_000);
        const due = T0 + 60_000 + DISCONNECT_MS;
        expect(nextPresenceDeadline(state, T0 + 60_000)).toBe(due);
        expect(announcedAbsence(state, due - 1)).toBe(false);
        expect(announcedAbsence(state, due)).toBe(true);
        expect(shownAgents(state, due)).toEqual([foreman]);
        expect(nextPresenceDeadline(state, due)).toBeNull();
    });

    test("one of two leaving keeps the chip on the other, with no deadline", () => {
        let state = initialPresence(reading([foreman, reviewer]), T0);
        state = updatePresence(state, reading([foreman]), T0 + 60_000);
        expect(shownAgents(state, T0 + 61_000)).toEqual([foreman]);
        expect(inGrace(state, T0 + 61_000)).toBe(false);
        expect(nextPresenceDeadline(state, T0 + 60_000)).toBeNull();
    });

    test("a fresh page without an agent is absent after the grace and shows nobody", () => {
        const state = initialPresence(reading([]), T0);
        expect(announcedAbsence(state, T0 + DISCONNECT_MS - 1)).toBe(false);
        expect(announcedAbsence(state, T0 + DISCONNECT_MS)).toBe(true);
        expect(shownAgents(state, T0)).toEqual([]);
    });
});

describe("the agent that opened the doc", () => {
    const expecting = (agents: AgentIdentity[], expected?: AgentIdentity): PresenceReading => ({
        ...reading(agents),
        expected,
    });

    test("is on its way from the first reading, and is not watching", () => {
        const state = initialPresence(expecting([], foreman), T0);
        expect(connecting(state, T0)).toBe(true);
        expect(shownAgents(state, T0)).toEqual([foreman]);
        expect(state.present).toEqual([]);
        expect(state.everWatching).toBe(false);
        expect(inGrace(state, T0)).toBe(false);
    });

    test("an unchanged expectation returns the same state; a changed one does not", () => {
        const state = initialPresence(expecting([], foreman), T0);
        expect(updatePresence(state, expecting([], foreman), T0 + 1_000)).toBe(state);
        expect(updatePresence(state, expecting([], reviewer), T0 + 1_000).expected).toEqual(
            reviewer,
        );
        const none = initialPresence(reading([]), T0);
        expect(updatePresence(none, expecting([], foreman), T0 + 1_000).expected).toEqual(foreman);
    });

    test("a watcher arriving ends it, whoever the watcher is", () => {
        let state = initialPresence(expecting([], foreman), T0);
        state = updatePresence(state, expecting([reviewer]), T0 + 3_000);
        expect(state.expected).toBeUndefined();
        expect(connecting(state, T0 + 3_000)).toBe(false);
        expect(shownAgents(state, T0 + 3_000)).toEqual([reviewer]);
        // Even a reading that still names it: present agents win.
        expect(initialPresence(expecting([reviewer], foreman), T0).expected).toBeUndefined();
    });

    test("the wait running out leaves a page nobody has watched", () => {
        let state = initialPresence(expecting([], foreman), T0);
        state = updatePresence(state, expecting([]), T0 + 60_000);
        expect(connecting(state, T0 + 60_000)).toBe(false);
        expect(state.everWatching).toBe(false);
        expect(shownAgents(state, T0 + 60_000)).toEqual([]);
    });

    test("after a watcher left: the grace period first, then the agent on its way", () => {
        let state = initialPresence(reading([reviewer]), T0);
        state = updatePresence(state, expecting([], foreman), T0 + 60_000);
        const due = T0 + 60_000 + DISCONNECT_MS;
        expect(connecting(state, due - 1)).toBe(false);
        expect(shownAgents(state, due - 1)).toEqual([reviewer]);
        expect(nextPresenceDeadline(state, T0 + 60_000)).toBe(due);
        expect(connecting(state, due)).toBe(true);
        expect(shownAgents(state, due)).toEqual([foreman]);
    });
});
