// `margin setup [--user] [--force]`: installs the Claude Code skill shipped in this package and
// prints the AGENTS.md snippet. AGENTS.md is the user's file, so it is never written.
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

export function setup(io: Io, options: SetupOptions = {}): number {
    const home = io.env.HOME;
    if (options.user && !home) {
        io.write("err bad-args; HOME is not set\n");
        return 1;
    }
    const target = join(options.user ? home! : projectRoot(io.cwd), SKILL_PATH);
    const shown = options.user ? `~/${SKILL_PATH}` : relative(io.cwd, target);
    const skill = readFileSync(skillSource, "utf8");
    const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;

    let outcome: "installed" | "unchanged" | "replaced";
    if (current === undefined) {
        outcome = "installed";
    } else if (current === skill) {
        outcome = "unchanged";
    } else if (options.force) {
        outcome = "replaced";
    } else {
        io.write(`err changed; ${shown} differs from this version, --force overwrites\n`);
        return 1;
    }
    if (outcome !== "unchanged") {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, skill);
    }
    io.write(`ok ${outcome} ${shown}\n`);
    io.write(
        `\nFor other agents, add this to AGENTS.md:\n\n${readFileSync(snippetSource, "utf8")}`,
    );
    return 0;
}
