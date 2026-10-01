import { describe, expect, test } from "bun:test";
import type { AgentIdentity, ThreadId } from "../../core/model.ts";
import {
    agentChipFor,
    agentMessage,
    agentTipLine,
    chipStatusLine,
    chipTipLines,
    shouldPulse,
    type AgentChipKind,
    type AgentChipModel,
} from "./agent-chip.tsx";
import {
    DISCONNECT_MS,
    initialPresence,
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

describe("agentChipFor", () => {
    test("connected: the first agent named, the rest counted and listed", () => {
        const state = initialPresence(reading([foreman, reviewer]), T0);
        const model = agentChipFor(state, [], T0);
        expect(model).toMatchObject({ kind: "connected", label: "foreman", extra: 1 });
        expect(chipTipLines(model)).toEqual(["foreman · Claude Code", "reviewer · Codex"]);
    });

    test("stalled while connected names the threads", () => {
        const state = initialPresence(reading([foreman]), T0);
        const model = agentChipFor(state, ["c3", "c5"], T0);
        expect(model.kind).toBe("stalled");
        expect(chipTipLines(model)).toEqual(["foreman · Claude Code", "Stalled on c3, c5"]);
    });

    test("within the grace period the chip still reads as connected", () => {
        let state = initialPresence(reading([foreman]), T0);
        state = updatePresence(state, reading([]), T0 + 60_000);
        expect(agentChipFor(state, [], T0 + 60_000 + DISCONNECT_MS - 1)).toMatchObject({
            kind: "connected",
            label: "foreman",
        });
    });

    test("disconnected keeps the last known name and says what a click does", () => {
        let state = initialPresence(reading([foreman]), T0);
        state = updatePresence(state, reading([]), T0 + 60_000);
        const model = agentChipFor(state, ["c3"], T0 + 60_000 + DISCONNECT_MS);
        expect(model).toMatchObject({ kind: "disconnected", label: "foreman", extra: 0 });
        expect(chipTipLines(model)).toEqual([
            "foreman · Claude Code",
            "Agent disconnected. Click to copy a message for your agent.",
        ]);
    });

    test("never seen: no agent, from the start", () => {
        const model = agentChipFor(initialPresence(reading([]), T0), [], T0);
        expect(model).toMatchObject({ kind: "none", label: "No agent", agents: [] });
        expect(chipTipLines(model)).toEqual([
            "No agent connected. Click to copy a message for your agent.",
        ]);
    });

    test("the daemon away freezes the last state", () => {
        let state = initialPresence(reading([foreman]), T0);
        state = updatePresence(state, reading([foreman], "lost" as never), T0 + 1_000);
        const model = agentChipFor(state, ["c3"], T0 + 1_000);
        expect(model).toMatchObject({ kind: "offline", label: "foreman" });
        expect(chipTipLines(model)).toEqual([
            "foreman · Claude Code",
            "Disconnected from margin · reconnecting",
            "If this persists, run margin on the file again or reload the page",
        ]);
    });

    test("without a reading, recent activity shows a generic agent", () => {
        const seenAt = new Date(T0 - 1_000).toISOString();
        const state = initialPresence({ agents: undefined, seenAt, connection: "live" }, T0);
        expect(agentChipFor(state, [], T0)).toMatchObject({ kind: "connected", label: "Agent" });
        expect(chipTipLines(agentChipFor(state, [], T0))).toEqual(["Agent"]);
    });
});

describe("chipStatusLine", () => {
    const model = (
        kind: AgentChipKind,
        agents: AgentIdentity[],
        stalled: ThreadId[] = [],
    ): AgentChipModel => ({
        kind,
        agents,
        label: agents[0]?.name ?? "No agent",
        extra: Math.max(0, agents.length - 1),
        stalled,
    });

    test("names the first agent and counts the rest", () => {
        expect(chipStatusLine(model("connected", [foreman]))).toBe("foreman connected");
        expect(chipStatusLine(model("connected", [foreman, reviewer]))).toBe(
            "foreman and 1 more connected",
        );
        expect(chipStatusLine(model("disconnected", [foreman]))).toBe("foreman disconnected");
        expect(chipStatusLine(model("stalled", [foreman], ["c3", "c5"]))).toBe(
            "foreman stalled on c3, c5",
        );
    });

    test("states with no agent say so without a name", () => {
        expect(chipStatusLine(model("none", []))).toBe("No agent connected");
        expect(chipStatusLine(model("offline", [foreman]))).toBe(
            "Disconnected from margin, reconnecting",
        );
    });
});

describe("shouldPulse", () => {
    test("only on a change after the first state", () => {
        expect(shouldPulse(null, "connected")).toBe(false);
        expect(shouldPulse("connected", "connected")).toBe(false);
        expect(shouldPulse("none", "connected")).toBe(true);
        expect(shouldPulse("connected", "offline")).toBe(true);
    });
});

describe("agentTipLine", () => {
    test("names the client only when it differs from the name, ignoring case", () => {
        expect(agentTipLine({ name: "Claude Code", client: "claude-code" })).toBe("Claude Code");
        expect(agentTipLine({ name: "claude code", client: "claude-code" })).toBe("claude code");
        expect(agentTipLine(foreman)).toBe("foreman · Claude Code");
    });
});

describe("agentMessage", () => {
    test("names the doc by its relative path and the command by its absolute one", () => {
        expect(agentMessage({ path: "/repo/docs/plan.md", relativePath: "docs/plan.md" })).toBe(
            "Please watch my margin review of docs/plan.md: run `margin watch /repo/docs/plan.md` under Monitor (see `margin agent-help`) and answer my comments in the doc.",
        );
    });

    test("falls back to the file name outside a repository", () => {
        expect(agentMessage({ path: "/tmp/notes.md", relativePath: "" })).toStartWith(
            "Please watch my margin review of notes.md:",
        );
    });
});
