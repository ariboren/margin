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

/** Runs the first opener that succeeds. Failing to open is not an error: the URL is printed. */
export async function openTab(url: string, env: Env = process.env): Promise<Opener> {
    for (const { opener, argv } of openCommands(url, env)) {
        try {
            const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
            if ((await proc.exited) === 0) {
                return opener;
            }
        } catch {
            // Binary not installed; try the next.
        }
    }
    return "none";
}
