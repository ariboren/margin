import { describe, expect, test } from "bun:test";
import type { AgentIdentity } from "../../core/model.ts";
import {
    DISCONNECT_MS,
    SEEN_MS,
    agentsFrom,
    announcedAbsence,
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
        expect(shownAgents(state)).toEqual([foreman]);
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
        expect(shownAgents(state)).toEqual([foreman]);
        expect(nextPresenceDeadline(state, due)).toBeNull();
    });

    test("one of two leaving keeps the chip on the other, with no deadline", () => {
        let state = initialPresence(reading([foreman, reviewer]), T0);
        state = updatePresence(state, reading([foreman]), T0 + 60_000);
        expect(shownAgents(state)).toEqual([foreman]);
        expect(inGrace(state, T0 + 61_000)).toBe(false);
        expect(nextPresenceDeadline(state, T0 + 60_000)).toBeNull();
    });

    test("a fresh page without an agent is absent after the grace and shows nobody", () => {
        const state = initialPresence(reading([]), T0);
        expect(announcedAbsence(state, T0 + DISCONNECT_MS - 1)).toBe(false);
        expect(announcedAbsence(state, T0 + DISCONNECT_MS)).toBe(true);
        expect(shownAgents(state)).toEqual([]);
    });
});
