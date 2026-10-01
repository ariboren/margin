// Who this agent is, for presence and for the events it writes: `--as`, then `MARGIN_AGENT`,
// then the display name of the client that spawned us, which is read from the markers clients
// set in their child processes.
import { cleanName, clientName } from "../core/agent.ts";
import type { AgentClient, AgentIdentity } from "../core/model.ts";
import type { Env } from "../server/open-tab.ts";

/**
 * Claude Code first: it sets `CLAUDECODE` in every subprocess, and when it runs inside Cursor's
 * terminal the innermost client is the one talking to us. `CODEX_HOME` is not a Codex marker; a
 * host like Orca sets it for every agent it launches.
 */
export function detectClient(env: Env): AgentClient {
    if (env.CLAUDECODE) return "claude-code";
    if (env.CODEX_THREAD_ID || env.CODEX_CI || env.CODEX_SANDBOX) return "codex";
    if (env.CURSOR_AGENT) return "cursor";
    return "unknown";
}

export function resolveAgent(input: { as?: string | undefined; env: Env }): AgentIdentity {
    const client = detectClient(input.env);
    const name = cleanName(input.as) ?? cleanName(input.env.MARGIN_AGENT) ?? clientName(client);
    return { name, client };
}
