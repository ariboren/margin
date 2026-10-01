import { expect, test } from "bun:test";
import {
    fileOpenCommands,
    openableLink,
    revealCommands,
    revealFile,
    type RevealCommand,
} from "./open-file.ts";

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

const AWKWARD = "/r/my docs/a,b;rm -rf $(x) 'q' \"d\".md";

test("reveal on macOS: Finder with the file selected, never Orca", () => {
    expect(revealCommands("/r/docs/a.md", "darwin")).toEqual([
        { argv: ["open", "-R", "/r/docs/a.md"] },
    ]);
});

test("reveal on Linux: the file manager's ShowItems with a reply timeout, then the folder", () => {
    const [select, folder] = revealCommands("/r/docs/a.md", "linux");
    expect(select).toEqual({
        argv: [
            "dbus-send",
            "--session",
            "--print-reply",
            "--reply-timeout=2000",
            "--dest=org.freedesktop.FileManager1",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
            "array:string:file:///r/docs/a.md",
            "string:",
        ],
        timeoutMs: 3000,
    });
    expect(folder).toEqual({ argv: ["xdg-open", "/r/docs"] });
});

test("an awkward path stays one argv element and never becomes a shell string", () => {
    expect(revealCommands(AWKWARD, "darwin")).toEqual([{ argv: ["open", "-R", AWKWARD] }]);
    const [select, folder] = revealCommands(AWKWARD, "linux");
    expect(folder!.argv).toEqual(["xdg-open", "/r/my docs"]);
    const uris = select!.argv.filter((arg) => arg.startsWith("array:string:"));
    expect(uris).toHaveLength(1);
    const uri = uris[0]!.slice("array:string:".length);
    // dbus-send would split the array on a literal comma.
    expect(uri).not.toMatch(/[, ]/);
    expect(decodeURIComponent(new URL(uri).pathname)).toBe(AWKWARD);
    for (const platform of ["darwin", "linux"] as const) {
        for (const { argv } of revealCommands(AWKWARD, platform)) {
            expect(["sh", "bash", "zsh", "-c"]).not.toContain(argv[0]!);
            expect(argv).not.toContain("-c");
        }
    }
});

function runner(outcomes: (number | Error)[]) {
    const ran: RevealCommand[] = [];
    const envs: unknown[] = [];
    return {
        ran,
        envs,
        run: async (command: RevealCommand, env: unknown) => {
            ran.push(command);
            envs.push(env);
            const outcome = outcomes.shift() ?? 0;
            if (outcome instanceof Error) {
                throw outcome;
            }
            return outcome;
        },
    };
}

test("revealFile stops at the first command that exits 0", async () => {
    const mac = runner([0]);
    const env = { ORCA_WORKTREE_ID: "x" };
    expect(await revealFile("/r/a.md", env, mac.run, "darwin")).toBe("system");
    expect(mac.ran.map(({ argv }) => argv[0])).toEqual(["open"]);
    expect(mac.envs).toEqual([env]);
    const linux = runner([0]);
    expect(await revealFile("/r/a.md", {}, linux.run, "linux")).toBe("system");
    expect(linux.ran.map(({ argv }) => argv[0])).toEqual(["dbus-send"]);
});

test("revealFile opens the folder when ShowItems fails, times out or dbus-send is missing", async () => {
    for (const first of [1, 143, new Error("ENOENT")]) {
        const linux = runner([first, 0]);
        expect(await revealFile("/r/a.md", {}, linux.run, "linux")).toBe("system");
        expect(linux.ran.map(({ argv }) => argv[0])).toEqual(["dbus-send", "xdg-open"]);
    }
});

test("revealFile reports none when nothing worked", async () => {
    expect(await revealFile("/r/a.md", {}, runner([1]).run, "darwin")).toBe("none");
    const linux = runner([new Error("ENOENT"), new Error("ENOENT")]);
    expect(await revealFile("/r/a.md", {}, linux.run, "linux")).toBe("none");
    expect(linux.ran).toHaveLength(2);
});
