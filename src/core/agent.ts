// What every side (CLI, daemon, page) says about an agent whose identity is partly or wholly
// unknown: older watcher files and log events carry none, and a sidecar from someone else's
// checkout may carry anything.
import type { AgentClient, AgentIdentity } from "./model.ts";

const CLIENT_NAMES: Record<AgentClient, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    unknown: "Agent",
};

/** A sanity cap, not a display cap: the page truncates for itself. */
export const MAX_NAME_LENGTH = 200;

export function clientName(client: AgentClient): string {
    return CLIENT_NAMES[client];
}

export function isAgentClient(value: unknown): value is AgentClient {
    return typeof value === "string" && Object.hasOwn(CLIENT_NAMES, value);
}

/** Whitespace collapsed to one space (the name is spliced into JSON and rendered inline). */
export function cleanName(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const name = raw.replace(/\s+/g, " ").trim();
    if (name === "") return undefined;
    return Array.from(name).slice(0, MAX_NAME_LENGTH).join("");
}

/** The identity read from a watcher or event written before identity existed. */
export const UNKNOWN_AGENT: AgentIdentity = { name: "Agent", client: "unknown" };

function own(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

/**
 * An identity as read from disk (a watcher file, a log event), made safe for the page: the
 * client must be one we know, else `unknown`; the name must be a usable string, else the
 * client's display name. Own properties only, so a key like `constructor` never resolves.
 */
export function readIdentity(value: unknown): AgentIdentity {
    const client = own(value, "client");
    const name = own(value, "name");
    const safeClient = isAgentClient(client) ? client : "unknown";
    return {
        name: (typeof name === "string" ? cleanName(name) : undefined) ?? clientName(safeClient),
        client: safeClient,
    };
}

/** One key per distinct agent: the same name on two clients is two agents. */
export function agentKey(agent: AgentIdentity): string {
    return `${agent.client}\n${agent.name}`;
}

/** The `agent` field of an event or message, left out rather than written as undefined. */
export function signed(agent: AgentIdentity | undefined): { agent?: AgentIdentity } {
    return agent === undefined ? {} : { agent };
}

/** `signed` for an event read back from the log: its `agent` is validated first. */
export function signedFromLog(agent: unknown): { agent?: AgentIdentity } {
    return agent === undefined ? {} : { agent: readIdentity(agent) };
}
