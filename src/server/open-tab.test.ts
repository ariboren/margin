import { describe, expect, test } from "bun:test";
import { createdPageId, openCommands, openTab, type Run } from "./open-tab.ts";

const url = "http://127.0.0.1:9/d/x/doc.md?t=y";

describe("openCommands", () => {
    test("uses the system browser outside Orca", () => {
        expect(openCommands(url, {}, "darwin")).toEqual([
            { opener: "browser", argv: ["open", url] },
        ]);
        expect(openCommands(url, {}, "linux")[0]?.argv).toEqual(["xdg-open", url]);
    });

    test("tries an Orca tab first when any ORCA_ variable is set", () => {
        const [first, second] = openCommands(url, { ORCA_WORKTREE_ID: "w" }, "darwin");
        expect(first).toEqual({
            opener: "orca",
            argv: ["orca", "tab", "create", "--url", url, "--json"],
        });
        expect(second?.opener).toBe("browser");
    });

    test("follows the orca-cli binary rules", () => {
        expect(openCommands(url, { ORCA_DEV_REPO_ROOT: "/r" })[0]?.argv[0]).toBe("orca-dev");
        expect(
            openCommands(url, { ORCA_X: "1", ORCA_CLI_COMMAND: "wsl orca" })[0]?.argv.slice(0, 2),
        ).toEqual(["wsl", "orca"]);
    });

    test("opens nothing with MARGIN_NO_OPEN", () => {
        expect(openCommands(url, { MARGIN_NO_OPEN: "1", ORCA_X: "1" })).toEqual([]);
    });
});

describe("openTab in Orca", () => {
    const env = { ORCA_WORKTREE_ID: "w" };
    const created = JSON.stringify({ ok: true, result: { browserPageId: "page-7" } });

    function recorder(
        responses: ((argv: string[]) => Promise<{ code: number; stdout: string }>)[],
    ) {
        const calls: string[][] = [];
        const captured: boolean[] = [];
        const run: Run = async (argv, capture) => {
            calls.push(argv);
            captured.push(capture);
            const next = responses.shift();
            if (!next) {
                throw new Error("unexpected command");
            }
            return next(argv);
        };
        return { calls, captured, run };
    }

    test("focuses the new tab by its page id", async () => {
        const { calls, run } = recorder([
            async () => ({ code: 0, stdout: created }),
            async () => ({ code: 0, stdout: "{}" }),
        ]);
        expect(await openTab(url, env, run)).toBe("orca");
        expect(calls[1]).toEqual([
            "orca",
            "tab",
            "switch",
            "--page",
            "page-7",
            "--focus",
            "--json",
        ]);
    });

    test("still counts as opened when the switch fails", async () => {
        const failing = recorder([
            async () => ({ code: 0, stdout: created }),
            async () => ({ code: 1, stdout: "" }),
        ]);
        expect(await openTab(url, env, failing.run)).toBe("orca");
        expect(failing.calls).toHaveLength(2);

        const missing = recorder([
            async () => ({ code: 0, stdout: created }),
            async () => {
                throw new Error("spawn failed");
            },
        ]);
        expect(await openTab(url, env, missing.run)).toBe("orca");
    });

    test("skips the switch when the create output has no page id", async () => {
        for (const stdout of ["not json", "", "null", JSON.stringify({ ok: true, result: {} })]) {
            const { calls, run } = recorder([async () => ({ code: 0, stdout })]);
            expect(await openTab(url, env, run)).toBe("orca");
            expect(calls).toHaveLength(1);
        }
    });

    test("falls back to the system browser when the Orca tab fails", async () => {
        const { calls, run } = recorder([
            async () => ({ code: 1, stdout: "" }),
            async () => ({ code: 0, stdout: "" }),
        ]);
        expect(await openTab(url, env, run)).toBe("browser");
        expect(calls).toHaveLength(2);
        expect(calls[1]?.includes("switch")).toBe(false);
    });

    test("reads stdout only from tab create", async () => {
        const inOrca = recorder([
            async () => ({ code: 0, stdout: created }),
            async () => ({ code: 0, stdout: "{}" }),
        ]);
        await openTab(url, env, inOrca.run);
        expect(inOrca.captured).toEqual([true, false]);

        const outside = recorder([async () => ({ code: 0, stdout: "" })]);
        expect(await openTab(url, {}, outside.run)).toBe("browser");
        expect(outside.captured).toEqual([false]);

        const fallback = recorder([
            async () => ({ code: 1, stdout: "" }),
            async () => ({ code: 0, stdout: "" }),
        ]);
        await openTab(url, env, fallback.run);
        expect(fallback.captured).toEqual([true, false]);
    });

    test("reads the page id from the create output", () => {
        expect(createdPageId(created)).toBe("page-7");
        expect(createdPageId(JSON.stringify({ result: { browserPageId: 3 } }))).toBeUndefined();
    });
});
