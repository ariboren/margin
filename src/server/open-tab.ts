export type Env = Record<string, string | undefined>;

export type Opener = "orca" | "browser" | "none";

/** The Orca CLI's argv prefix when running inside Orca (any `ORCA_*` name), else undefined. */
export function orcaCli(env: Env): string[] | undefined {
    if (!Object.keys(env).some((name) => name.startsWith("ORCA_"))) {
        return undefined;
    }
    return (
        env.ORCA_CLI_COMMAND?.trim().split(/\s+/) ?? [env.ORCA_DEV_REPO_ROOT ? "orca-dev" : "orca"]
    );
}

/**
 * Commands to try in order. Inside Orca (any `ORCA_*` variable) the tab opens in Orca's browser,
 * with the binary chosen per the orca-cli skill; the system browser is the fallback.
 * `MARGIN_NO_OPEN` turns opening off (tests, headless use).
 */
export function openCommands(
    url: string,
    env: Env,
    platform: NodeJS.Platform = process.platform,
): { opener: Exclude<Opener, "none">; argv: string[] }[] {
    if (env.MARGIN_NO_OPEN) {
        return [];
    }
    const commands: { opener: Exclude<Opener, "none">; argv: string[] }[] = [];
    const orca = orcaCli(env);
    if (orca) {
        commands.push({ opener: "orca", argv: [...orca, "tab", "create", "--url", url, "--json"] });
    }
    commands.push({
        opener: "browser",
        argv: platform === "darwin" ? ["open", url] : ["xdg-open", url],
    });
    return commands;
}

/**
 * Runs one command; resolves with its exit code, plus stdout when `capture` is set. Rejects if the
 * binary is missing. Only capture from commands that exit on their own: `xdg-open` can hand the
 * inherited stdout to the browser, so reading it to EOF would wait for the browser to quit.
 */
export type Run = (argv: string[], capture: boolean) => Promise<{ code: number; stdout: string }>;

async function spawnRun(
    argv: string[],
    capture: boolean,
): Promise<{ code: number; stdout: string }> {
    if (!capture) {
        const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        return { code: await proc.exited, stdout: "" };
    }
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
}

/** The new tab's page id from `orca tab create --json` output, or undefined when absent. */
export function createdPageId(stdout: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(stdout);
        const id = (parsed as { result?: { browserPageId?: unknown } } | null)?.result
            ?.browserPageId;
        return typeof id === "string" && id !== "" ? id : undefined;
    } catch {
        return undefined;
    }
}

/**
 * `tab create` opens the tab behind whatever the user is looking at, so bring it forward. The
 * tab is already open, so any failure here leaves it open but unfocused.
 */
async function focusOrcaTab(orca: string[], createStdout: string, run: Run): Promise<void> {
    const id = createdPageId(createStdout);
    if (!id) {
        return;
    }
    try {
        await run([...orca, "tab", "switch", "--page", id, "--focus", "--json"], false);
    } catch {
        // Unfocused is still opened.
    }
}

/** Runs the first opener that succeeds. Failing to open is not an error: the URL is printed. */
export async function openTab(
    url: string,
    env: Env = process.env,
    run: Run = spawnRun,
): Promise<Opener> {
    for (const { opener, argv } of openCommands(url, env)) {
        let result: { code: number; stdout: string };
        try {
            result = await run(argv, opener === "orca");
        } catch {
            // Binary not installed; try the next.
            continue;
        }
        if (result.code !== 0) {
            continue;
        }
        const orca = orcaCli(env);
        if (opener === "orca" && orca) {
            await focusOrcaTab(orca, result.stdout, run);
        }
        return opener;
    }
    return "none";
}
