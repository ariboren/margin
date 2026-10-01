import { dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { orcaCli, type Env } from "./open-tab.ts";

export type FileOpener = "orca" | "system" | "none";

/**
 * What a link in the doc may open. `open` and `xdg-open` launch whatever they are handed, so a
 * link to `run.command`, `.app`, `.sh` or `.desktop` in an AI-written doc would run on click;
 * only text and document types pass. Not `.py` (the Python Launcher runs it), nor `.html` or
 * `.svg` (they open in a browser, scripts and all, from file://).
 */
const OPENABLE = new Set([
    ".md",
    ".markdown",
    ".mdx",
    ".txt",
    ".ts",
    ".js",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".go",
    ".rs",
    ".css",
    ".csv",
    ".pdf",
    ".png",
    ".jpg",
]);

/** Judged on the realpath, so a `.md` name on a symlink to an executable does not pass. */
export function openableLink(realPath: string): boolean {
    return OPENABLE.has(extname(realPath).toLowerCase());
}

/**
 * Commands to try in order for opening a file in a normal file tab. Inside Orca (any `ORCA_*`
 * name) that is Orca's editor, run from the file's directory so Orca finds its worktree; it
 * refuses files outside every worktree, so the OS default app is the fallback.
 */
export function fileOpenCommands(
    path: string,
    env: Env,
    platform: NodeJS.Platform = process.platform,
): { opener: Exclude<FileOpener, "none">; argv: string[]; cwd?: string }[] {
    const commands: { opener: Exclude<FileOpener, "none">; argv: string[]; cwd?: string }[] = [];
    const orca = orcaCli(env);
    if (orca) {
        commands.push({
            opener: "orca",
            argv: [...orca, "file", "open", path, "--json"],
            cwd: dirname(path),
        });
    }
    commands.push({
        opener: "system",
        argv: platform === "darwin" ? ["open", path] : ["xdg-open", path],
    });
    return commands;
}

/** Spawns argv arrays only, never a shell string: the path cannot inject a command. */
export async function openFile(path: string, env: Env): Promise<FileOpener> {
    for (const { opener, argv, cwd } of fileOpenCommands(path, env)) {
        try {
            const proc = Bun.spawn(argv, {
                cwd,
                env,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
            });
            if ((await proc.exited) === 0) {
                return opener;
            }
        } catch {
            // Binary not installed; try the next.
        }
    }
    return "none";
}

/** How long the file manager gets to answer over D-Bus before the folder is opened instead. */
const SHOW_ITEMS_REPLY_MS = 2_000;

export interface RevealCommand {
    argv: string[];
    /** Kills a command that outlives it, so a silent bus cannot hold the request. */
    timeoutMs?: number;
}

/**
 * Commands to try in order for showing a file in the system file manager; never Orca, whose
 * editor is what "open" is for. Finder selects the file. On Linux the freedesktop `ShowItems`
 * call selects it where a file manager answers, and the folder opens otherwise.
 */
export function revealCommands(
    path: string,
    platform: NodeJS.Platform = process.platform,
): RevealCommand[] {
    if (platform === "darwin") {
        return [{ argv: ["open", "-R", path] }];
    }
    // dbus-send splits an array argument on commas, so one in the path must not stay literal.
    const uri = pathToFileURL(path).href.replaceAll(",", "%2C");
    return [
        {
            argv: [
                "dbus-send",
                "--session",
                // Without a reply dbus-send exits 0 even when no file manager is listening.
                "--print-reply",
                `--reply-timeout=${SHOW_ITEMS_REPLY_MS}`,
                "--dest=org.freedesktop.FileManager1",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                `array:string:${uri}`,
                "string:",
            ],
            timeoutMs: SHOW_ITEMS_REPLY_MS + 1_000,
        },
        { argv: ["xdg-open", dirname(path)] },
    ];
}

/** Runs one command and resolves with its exit code; rejects if the binary is missing. */
export type RevealRun = (command: RevealCommand, env: Env) => Promise<number>;

async function spawnReveal({ argv, timeoutMs }: RevealCommand, env: Env): Promise<number> {
    const proc = Bun.spawn(argv, {
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    });
    return await proc.exited;
}

/** Spawns argv arrays only, like `openFile`. A failed, timed out or missing command tries the next. */
export async function revealFile(
    path: string,
    env: Env,
    run: RevealRun = spawnReveal,
    platform: NodeJS.Platform = process.platform,
): Promise<FileOpener> {
    for (const command of revealCommands(path, platform)) {
        try {
            if ((await run(command, env)) === 0) {
                return "system";
            }
        } catch {
            // Binary not installed; try the next.
        }
    }
    return "none";
}
