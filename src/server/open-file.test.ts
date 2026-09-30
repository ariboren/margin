import { expect, test } from "bun:test";
import { fileOpenCommands, openableLink } from "./open-file.ts";

test("inside Orca: Orca's editor from the file's directory, then the OS app", () => {
    expect(fileOpenCommands("/r/docs/a.md", { ORCA_WORKTREE_ID: "x" }, "darwin")).toEqual([
        {
            opener: "orca",
            argv: ["orca", "file", "open", "/r/docs/a.md", "--json"],
            cwd: "/r/docs",
        },
        { opener: "system", argv: ["open", "/r/docs/a.md"] },
    ]);
});

test("the Orca binary follows ORCA_CLI_COMMAND, then a dev checkout", () => {
    const [wsl] = fileOpenCommands("/a.md", { ORCA_CLI_COMMAND: "orca.exe --wsl" }, "linux");
    expect(wsl!.argv.slice(0, 2)).toEqual(["orca.exe", "--wsl"]);
    const [dev] = fileOpenCommands("/a.md", { ORCA_DEV_REPO_ROOT: "/o" }, "linux");
    expect(dev!.argv[0]).toBe("orca-dev");
});

test("outside Orca: the OS default app only, as an argv array", () => {
    expect(fileOpenCommands("/a b;rm.md", {}, "linux")).toEqual([
        { opener: "system", argv: ["xdg-open", "/a b;rm.md"] },
    ]);
});

test("links open only text and document types, judged case-insensitively", () => {
    for (const path of ["/r/a.md", "/r/b.MD", "/r/c.json", "/r/d.pdf", "/r/e.png", "/r/f.tsx.ts"]) {
        expect(openableLink(path)).toBe(true);
    }
    for (const path of [
        "/r/run.command",
        "/r/x.sh",
        "/r/App.app",
        "/r/x.desktop",
        "/r/x.exe",
        "/r/Makefile",
        "/r/x.md.command",
        "/r/.md",
        "/r/tool.py",
        "/r/page.html",
        "/r/icon.SVG",
    ]) {
        expect(openableLink(path)).toBe(false);
    }
});
