import { dirname, extname } from "node:path";
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
