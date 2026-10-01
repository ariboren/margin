import { describe, expect, test } from "bun:test";
import {
    MAX_NAME_LENGTH,
    UNKNOWN_AGENT,
    cleanName,
    isAgentClient,
    readIdentity,
    signedFromLog,
} from "./agent.ts";

describe("cleanName", () => {
    test("collapses whitespace and drops empty names", () => {
        expect(cleanName("  fore\n man\t ")).toBe("fore man");
        expect(cleanName("   ")).toBeUndefined();
        expect(cleanName(undefined)).toBeUndefined();
    });

    test("caps at the sanity limit by code point", () => {
        const long = "é".repeat(MAX_NAME_LENGTH + 5);
        expect(Array.from(cleanName(long)!)).toHaveLength(MAX_NAME_LENGTH);
    });
});

describe("isAgentClient", () => {
    test("the closed set only; prototype keys are not clients", () => {
        expect(isAgentClient("claude-code")).toBe(true);
        expect(isAgentClient("unknown")).toBe(true);
        for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", "x", 1]) {
            expect(isAgentClient(key)).toBe(false);
        }
    });
});

describe("readIdentity", () => {
    test("a well-formed identity reads as written, whitespace collapsed", () => {
        expect(readIdentity({ name: "foreman", client: "claude-code" })).toEqual({
            name: "foreman",
            client: "claude-code",
        });
        expect(readIdentity({ name: "  fore\n man ", client: "codex" })).toEqual({
            name: "fore man",
            client: "codex",
        });
    });

    test("a prototype key or unknown client reads as unknown; the name survives", () => {
        for (const client of ["__proto__", "constructor", "toString", "vim"]) {
            expect(readIdentity({ name: "ghost", client })).toEqual({
                name: "ghost",
                client: "unknown",
            });
        }
    });

    test("a name that is not a usable string becomes the client's display name", () => {
        expect(readIdentity({ name: () => "x", client: "codex" })).toEqual({
            name: "Codex",
            client: "codex",
        });
        for (const name of [7, null, ["a"], { toString: () => "x" }, "", "  ", undefined]) {
            expect(readIdentity({ name, client: "cursor" })).toEqual({
                name: "Cursor",
                client: "cursor",
            });
        }
    });

    test("an overlong name is capped at the write-side limit", () => {
        const { name } = readIdentity({ name: "a".repeat(MAX_NAME_LENGTH + 50), client: "codex" });
        expect(name).toBe("a".repeat(MAX_NAME_LENGTH));
    });

    test("inherited properties are not read", () => {
        const inherited = Object.create({ name: "ghost", client: "claude-code" }) as object;
        expect(readIdentity(inherited)).toEqual(UNKNOWN_AGENT);
        expect(readIdentity(JSON.parse('{"__proto__":{"name":"g","client":"codex"}}'))).toEqual(
            UNKNOWN_AGENT,
        );
    });

    test("anything that is not an object is the unknown agent", () => {
        for (const value of [undefined, null, "x", 3, true, [], () => 1]) {
            expect(readIdentity(value)).toEqual(UNKNOWN_AGENT);
        }
    });
});

describe("signedFromLog", () => {
    test("leaves an absent field out and validates a present one", () => {
        expect(signedFromLog(undefined)).toEqual({});
        expect(signedFromLog(null)).toEqual({ agent: UNKNOWN_AGENT });
        expect(signedFromLog({ name: "x", client: "constructor" })).toEqual({
            agent: { name: "x", client: "unknown" },
        });
    });
});
