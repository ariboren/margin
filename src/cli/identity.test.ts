import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectClient, resolveAgent, sessionKey } from "./identity.ts";

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

describe("Claude Code session title", () => {
    const sessionId = "9eaa6981-1816-430e-89b0-9d001c8d2f1f";

    function claudeEnv(lines: object[], extra: Record<string, string> = {}) {
        const home = mkdtempSync(join(tmpdir(), "margin-identity-"));
        const project = join(home, ".claude/projects/-some-other-cwd");
        mkdirSync(project, { recursive: true });
        writeFileSync(
            join(project, `${sessionId}.jsonl`),
            lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
        );
        return { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: sessionId, HOME: home, ...extra };
    }

    test("the latest AI title names the agent", () => {
        const env = claudeEnv([
            { type: "ai-title", aiTitle: "First guess", sessionId },
            { type: "user", message: { content: 'quoting "ai-title" in a prompt' } },
            { type: "ai-title", aiTitle: "Margin theme review", sessionId },
        ]);
        expect(resolveAgent({ env })).toEqual({
            name: "Margin theme review",
            client: "claude-code",
        });
    });

    test("a title the user set wins over a later AI title", () => {
        const env = claudeEnv([
            { type: "custom-title", customTitle: "margin foreman", sessionId },
            { type: "ai-title", aiTitle: "Margin theme review", sessionId },
        ]);
        expect(resolveAgent({ env }).name).toBe("margin foreman");
    });

    test("a cleared custom title gives the AI title back", () => {
        const env = claudeEnv([
            { type: "custom-title", customTitle: "margin foreman", sessionId },
            { type: "ai-title", aiTitle: "Margin theme review", sessionId },
            { type: "custom-title", customTitle: "", sessionId },
        ]);
        expect(resolveAgent({ env }).name).toBe("Margin theme review");
    });

    test("--as and MARGIN_AGENT still come first", () => {
        const env = claudeEnv([{ type: "ai-title", aiTitle: "Margin theme review", sessionId }], {
            MARGIN_AGENT: "reviewer",
        });
        expect(resolveAgent({ as: "foreman", env }).name).toBe("foreman");
        expect(resolveAgent({ env }).name).toBe("reviewer");
    });

    test("only a Claude Code session is looked up", () => {
        const env = claudeEnv([{ type: "ai-title", aiTitle: "Margin theme review", sessionId }]);
        expect(resolveAgent({ env: { ...env, CLAUDECODE: undefined } }).name).toBe("Agent");
    });

    test("no transcript, no title or an unusable id falls back to the client", () => {
        const untitled = claudeEnv([{ type: "user", message: { content: "hi" } }]);
        expect(resolveAgent({ env: untitled }).name).toBe("Claude Code");
        expect(
            resolveAgent({ env: { ...untitled, CLAUDE_CODE_SESSION_ID: "../../etc/passwd" } }).name,
        ).toBe("Claude Code");
        expect(resolveAgent({ env: { ...untitled, HOME: "/nonexistent-margin-home" } }).name).toBe(
            "Claude Code",
        );
    });
});

describe("sessionKey", () => {
    const CLAUDE = "0a1b2c3d-0000-4000-8000-0123456789ab";

    test("MARGIN_SESSION, then the Claude Code session, then the Codex thread", () => {
        const env = {
            MARGIN_SESSION: "mine",
            CLAUDE_CODE_SESSION_ID: CLAUDE,
            CODEX_THREAD_ID: "t1",
        };
        expect(sessionKey(env)).toBe("margin:mine");
        expect(sessionKey({ ...env, MARGIN_SESSION: " " })).toBe(`claude-code:${CLAUDE}`);
        expect(sessionKey({ CODEX_THREAD_ID: "t1" })).toBe("codex:t1");
    });

    test("no id, or a Claude Code id of the wrong shape, is no session", () => {
        expect(sessionKey({})).toBeUndefined();
        expect(sessionKey({ CLAUDECODE: "1", CURSOR_AGENT: "1" })).toBeUndefined();
        expect(sessionKey({ CLAUDE_CODE_SESSION_ID: "../x" })).toBeUndefined();
    });

    test("a name and an id that spell the same are different sessions", () => {
        expect(sessionKey({ MARGIN_SESSION: CLAUDE })).not.toBe(
            sessionKey({ CLAUDE_CODE_SESSION_ID: CLAUDE }),
        );
    });
});
