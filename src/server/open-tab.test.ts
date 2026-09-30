import { describe, expect, test } from "bun:test";
import { openCommands } from "./open-tab.ts";

const url = "http://127.0.0.1:9/d/x?t=y";

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
