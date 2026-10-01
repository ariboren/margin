import { describe, expect, test } from "bun:test";
import { detectClient, resolveAgent } from "./identity.ts";

describe("detectClient", () => {
    test("each client's marker, Claude Code first when nested", () => {
        expect(detectClient({ CLAUDECODE: "1" })).toBe("claude-code");
        expect(detectClient({ CODEX_THREAD_ID: "t" })).toBe("codex");
        expect(detectClient({ CODEX_CI: "1" })).toBe("codex");
        expect(detectClient({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
        expect(detectClient({ CURSOR_AGENT: "1" })).toBe("cursor");
        expect(detectClient({ CLAUDECODE: "1", CURSOR_AGENT: "1" })).toBe("claude-code");
    });

    test("CODEX_HOME alone is not Codex; nothing is unknown", () => {
        expect(detectClient({ CODEX_HOME: "/x", ORCA_CODEX_HOME: "/y" })).toBe("unknown");
        expect(detectClient({})).toBe("unknown");
    });
});

describe("resolveAgent", () => {
    test("--as, then MARGIN_AGENT, then the client's display name", () => {
        const env = { CLAUDECODE: "1", MARGIN_AGENT: "reviewer" };
        expect(resolveAgent({ as: "foreman", env })).toEqual({
            name: "foreman",
            client: "claude-code",
        });
        expect(resolveAgent({ env })).toEqual({ name: "reviewer", client: "claude-code" });
        expect(resolveAgent({ env: { CLAUDECODE: "1" } })).toEqual({
            name: "Claude Code",
            client: "claude-code",
        });
        expect(resolveAgent({ env: {} })).toEqual({ name: "Agent", client: "unknown" });
    });

    test("an empty --as falls through to the next source", () => {
        expect(resolveAgent({ as: " ", env: { MARGIN_AGENT: "x" } }).name).toBe("x");
    });
});
