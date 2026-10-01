// Who is here, who left and when: one fold of the daemon's presence readings behind the agent
// chip beside the filename and the tab icon, so the grace period and the names exist once.
import { UNKNOWN_AGENT, agentKey } from "../../core/agent.ts";
import type { AgentIdentity, Connection, IsoTime } from "../../core/model.ts";

/** How long an agent must be gone before the page says so; a Monitor re-arm gap is shorter. */
export const DISCONNECT_MS = 10_000;
/** Without a presence reading (the mockup), recent agent activity counts as watching. */
export const SEEN_MS = 15 * 60_000;

export interface PresenceReading {
    /** The daemon's list; undefined where there is no daemon. */
    agents: AgentIdentity[] | undefined;
    /** Last claim or cursor, the fallback reading. */
    seenAt: IsoTime | undefined;
    connection: Connection;
}

interface Departure {
    agent: AgentIdentity;
    since: number;
}

export interface PresenceState {
    connection: Connection;
    /** Agents in the latest reading. */
    present: AgentIdentity[];
    /** Agents seen earlier and not present now, with when they left; latest last. */
    departed: Departure[];
    everWatching: boolean;
    loadedAt: number;
}

/** The list the daemon sent, or the one inferred from activity where there is no daemon. */
export function agentsFrom(reading: PresenceReading, now: number): AgentIdentity[] {
    if (reading.agents !== undefined) {
        return reading.agents;
    }
    const seen = reading.seenAt !== undefined && now - Date.parse(reading.seenAt) < SEEN_MS;
    return seen ? [UNKNOWN_AGENT] : [];
}

export function initialPresence(reading: PresenceReading, now: number): PresenceState {
    const present = agentsFrom(reading, now);
    return {
        connection: reading.connection,
        present,
        departed: [],
        everWatching: present.length > 0,
        loadedAt: now,
    };
}

function sameAgents(a: AgentIdentity[], b: AgentIdentity[]): boolean {
    return a.length === b.length && a.every((agent, i) => agentKey(agent) === agentKey(b[i]!));
}

/**
 * Folds a reading in. An agent back within the grace period leaves the departed list, so a
 * watcher re-arming between batches never reads as gone.
 */
export function updatePresence(
    state: PresenceState,
    reading: PresenceReading,
    now: number,
): PresenceState {
    const present = agentsFrom(reading, now);
    if (sameAgents(present, state.present) && reading.connection === state.connection) {
        return state;
    }
    const presentKeys = new Set(present.map(agentKey));
    const departed = state.departed.filter((d) => !presentKeys.has(agentKey(d.agent)));
    for (const agent of state.present) {
        if (!presentKeys.has(agentKey(agent))) {
            departed.push({ agent, since: now });
        }
    }
    return {
        connection: reading.connection,
        present,
        departed,
        everWatching: state.everWatching || present.length > 0,
        loadedAt: state.loadedAt,
    };
}

/** When nobody is here, when the page started waiting: the latest departure or the load. */
function absentSince(state: PresenceState): number {
    const last = state.departed[state.departed.length - 1];
    return last ? Math.max(last.since, state.loadedAt) : state.loadedAt;
}

/** Nobody here for the grace period or longer. */
export function announcedAbsence(state: PresenceState, now: number): boolean {
    return state.present.length === 0 && now - absentSince(state) >= DISCONNECT_MS;
}

/** Still within the grace period after the last agent left: shown as connected. */
export function inGrace(state: PresenceState, now: number): boolean {
    return state.present.length === 0 && state.everWatching && !announcedAbsence(state, now);
}

/** The agents the page should show: those here, or during grace and after, those last seen. */
export function shownAgents(state: PresenceState): AgentIdentity[] {
    if (state.present.length > 0) {
        return state.present;
    }
    return state.departed.map((d) => d.agent);
}

/** When the presence view next changes on its own, without a new reading; null when it does not. */
export function nextPresenceDeadline(state: PresenceState, now: number): number | null {
    if (state.present.length > 0) {
        return null;
    }
    const due = absentSince(state) + DISCONNECT_MS;
    return due > now ? due : null;
}
