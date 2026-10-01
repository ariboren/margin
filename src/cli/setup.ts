// `margin setup [--user] [--force]`: installs the Claude Code skill shipped in this package and
// prints the AGENTS.md snippet, asking first when a person is at the terminal.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { repoRoot } from "../server/doc-location.ts";
import type { Io } from "./main.ts";

const packageRoot = join(import.meta.dir, "..", "..");

export const skillSource = join(packageRoot, "skill/margin/SKILL.md");
export const snippetSource = join(packageRoot, "AGENTS.snippet.md");

const SKILL_PATH = ".claude/skills/margin/SKILL.md";

export interface SetupOptions {
    /** `~/.claude/skills` instead of the project's. */
    user?: boolean;
    /** Overwrite a skill that differs from this package's. */
    force?: boolean;
}

/** Where Claude Code looks for project skills: the git root of cwd, else cwd. */
function projectRoot(cwd: string): string {
    return repoRoot(join(cwd, ".claude")) ?? cwd;
}

/** Asks until the answer starts with one of `keys`; an empty answer takes `fallback`. */
async function choose<K extends string>(
    ask: NonNullable<Io["ask"]>,
    question: string,
    keys: readonly K[],
    fallback: K,
): Promise<K> {
    for (;;) {
        const answer = (await ask(question)).trim().toLowerCase();
        if (answer === "") return fallback;
        const key = keys.find((candidate) => answer.startsWith(candidate));
        if (key !== undefined) return key;
    }
}

/**
 * With a person at the terminal (`io.ask`), every choice a flag did not already make is asked:
 * where the skill goes, whether to overwrite one that differs, and whether to print the snippet.
 * Without one the flags decide, so an agent or a script never waits on a prompt.
 */
export async function setup(io: Io, options: SetupOptions = {}): Promise<number> {
    const home = io.env.HOME;
    const project = join(projectRoot(io.cwd), SKILL_PATH);
    let user = options.user === true;
    if (io.ask && !user) {
        const where = await choose(
            io.ask,
            [
                "Install the Claude Code skill?",
                `  p  this project (${relative(io.cwd, project)})`,
                `  u  all your projects (~/${SKILL_PATH})`,
                "  n  don't install",
                "[P/u/n] ",
            ].join("\n"),
            ["p", "u", "n"],
            "p",
        );
        if (where === "n") {
            io.write("ok skipped\n");
            return await snippet(io);
        }
        user = where === "u";
    }
    if (user && !home) {
        io.write("err bad-args; HOME is not set\n");
        return 1;
    }
    const target = user ? join(home!, SKILL_PATH) : project;
    const shown = user ? `~/${SKILL_PATH}` : relative(io.cwd, target);
    const skill = readFileSync(skillSource, "utf8");
    const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;

    let outcome: "installed" | "unchanged" | "replaced" | "kept";
    if (current === undefined) {
        outcome = "installed";
    } else if (current === skill) {
        outcome = "unchanged";
    } else if (options.force) {
        outcome = "replaced";
    } else if (io.ask) {
        const overwrite = await choose(
            io.ask,
            `${shown} differs from this version (an older margin's, or your own edits). Overwrite it? [y/N] `,
            ["y", "n"],
            "n",
        );
        outcome = overwrite === "y" ? "replaced" : "kept";
    } else {
        io.write(`err changed; ${shown} differs from this version, --force overwrites\n`);
        return 1;
    }
    if (outcome === "installed" || outcome === "replaced") {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, skill);
    }
    io.write(`ok ${outcome} ${shown}\n`);
    return await snippet(io);
}

/** AGENTS.md is the user's file: the snippet is shown for them to paste, never written. */
async function snippet(io: Io): Promise<number> {
    if (io.ask) {
        const show = await choose(
            io.ask,
            "Print the snippet to paste into AGENTS.md for other agents (Codex, Cursor)? [y/N] ",
            ["y", "n"],
            "n",
        );
        if (show === "n") return 0;
    }
    io.write(
        `\nFor other agents, add this to AGENTS.md:\n\n${readFileSync(snippetSource, "utf8")}`,
    );
    return 0;
}
