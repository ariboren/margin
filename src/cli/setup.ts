// `margin setup [--user] [--force]`: installs the Claude Code skill shipped in this package and
// prints the AGENTS.md snippet, asking first when a person is at the terminal. Also what tells an
// installed copy apart (current, an untouched older one, edited) and the record of where copies
// were installed, which `margin update` and the stale notice read.
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { withLock } from "../core/lock.ts";
import { repoRoot } from "../server/doc-location.ts";
import type { Env } from "../server/open-tab.ts";
import { deviceDir, ensureStateDir } from "../server/paths.ts";
import type { Io } from "./main.ts";

export const packageRoot = join(import.meta.dir, "..", "..");

export const skillSource = join(packageRoot, "skill/margin/SKILL.md");
export const snippetSource = join(packageRoot, "AGENTS.snippet.md");

export const SKILL_PATH = ".claude/skills/margin/SKILL.md";

export function packageVersion(root = packageRoot): string {
    const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return (manifest as { version: string }).version;
}

const STAMP = /^<!-- margin-skill (\S+) ([0-9a-f]{12}) -->\r?\n?/m;

/**
 * The skills released before the stamp existed, by the first 16 hex of their SHA-256, so an
 * untouched copy of one is recognised and not taken for the user's edits. The list is closed:
 * every later release is stamped. skill/generate.test.ts checks it against the tags.
 */
export const RELEASED_UNSTAMPED: Readonly<Record<string, string>> = {
    "175706ad4e4c298f": "0.1.0",
    "9b0a877ad956155d": "0.2.0",
    a59c7edcc8510945: "0.2.1",
    "245bcdf9d6a40d2e": "0.2.2",
    a1ab9646177c367b: "0.2.3",
    "3720d24fac677563": "0.3.0",
};

/** A checkout with `autocrlf` rewrites line ends, which is not an edit. */
function foldLines(text: string): string {
    return text.replaceAll("\r\n", "\n");
}

function sha256(text: string): string {
    return createHash("sha256").update(foldLines(text)).digest("hex");
}

/** Ends the generated skill with the version it came from and a hash of everything above. */
export function stampSkill(content: string, version: string): string {
    const body = `${content}\n`;
    return `${body}<!-- margin-skill ${version} ${sha256(body).slice(0, 12)} -->\n`;
}

interface ParsedSkill {
    body: string;
    stamp?: { version: string; hash: string };
}

/** The stamp line is found wherever it is, so text added below it reads as an edit, not as no stamp. */
function parseSkill(text: string): ParsedSkill {
    const match = STAMP.exec(text);
    if (!match) return { body: text };
    return {
        body: text.slice(0, match.index) + text.slice(match.index + match[0].length),
        stamp: { version: match[1]!, hash: match[2]! },
    };
}

/** Numeric on the three parts; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
    const split = (version: string) => {
        const dash = version.indexOf("-");
        const core = dash === -1 ? version : version.slice(0, dash);
        return {
            parts: core.split(".").map((part) => Number(part) || 0),
            pre: dash === -1 ? undefined : version.slice(dash + 1),
        };
    };
    const left = split(a);
    const right = split(b);
    for (let index = 0; index < 3; index++) {
        const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
        if (diff !== 0) return Math.sign(diff);
    }
    if (left.pre === right.pre) return 0;
    if (left.pre === undefined) return 1;
    if (right.pre === undefined) return -1;
    return Math.sign(left.pre.localeCompare(right.pre, undefined, { numeric: true }));
}

export interface SkillClass {
    /**
     * `current`: the content is this package's, whatever version the stamp names, so a release
     * that leaves the skill alone makes no copy stale. `older` and `newer`: untouched copies of
     * another version's skill. `edited`: anything else, which is the user's.
     */
    kind: "current" | "older" | "newer" | "edited";
    /** The margin version the copy came from, when the copy says or its hash is a release's. */
    version?: string;
}

export function classifySkill(
    text: string,
    skill: string,
    version: string,
    released: Readonly<Record<string, string>> = RELEASED_UNSTAMPED,
): SkillClass {
    const copy = parseSkill(text);
    const from = copy.stamp?.version;
    if (foldLines(copy.body) === foldLines(parseSkill(skill).body)) {
        return { kind: "current", ...(from ? { version: from } : {}) };
    }
    if (!copy.stamp) {
        const shipped = released[sha256(text).slice(0, 16)];
        return shipped ? { kind: "older", version: shipped } : { kind: "edited" };
    }
    if (sha256(copy.body).slice(0, 12) !== copy.stamp.hash) {
        return { kind: "edited", version: from };
    }
    return { kind: compareVersions(from!, version) > 0 ? "newer" : "older", version: from };
}

/**
 * Out of date: an untouched older copy, or an edited one that started from an older margin (or
 * from before the stamp, which is older than any stamped release).
 */
export function isStale(state: SkillClass, version: string): boolean {
    if (state.kind === "older") return true;
    if (state.kind !== "edited") return false;
    return state.version === undefined || compareVersions(state.version, version) < 0;
}

/** Where Claude Code looks for project skills: the git root of cwd, else cwd. */
export function projectRoot(cwd: string): string {
    return repoRoot(join(cwd, ".claude")) ?? cwd;
}

/** One name per file, so a copy reached through a symlink is not listed twice. */
function canonical(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** The copies that apply to an agent working in `cwd`: the project's and the user's. */
export function skillTargets(io: Pick<Io, "cwd" | "env">): { project: string; user?: string } {
    const home = io.env.HOME;
    return {
        project: canonical(join(projectRoot(io.cwd), SKILL_PATH)),
        ...(home ? { user: canonical(join(home, SKILL_PATH)) } : {}),
    };
}

const SKILL_SEGMENTS = SKILL_PATH.split("/");

function namedAsSkill(path: string): boolean {
    const parts = path.split(/[\\/]/);
    return SKILL_SEGMENTS.every(
        (segment, index) => parts[parts.length - SKILL_SEGMENTS.length + index] === segment,
    );
}

function isRegularFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

/**
 * Whether a path read from the record may be read and written as a skill copy. The record is a
 * file anyone on the account can alter, so a path in it is only trusted when it is absolute, is
 * named `.claude/skills/margin/SKILL.md`, is a regular file, and is still so named once symlinks
 * are resolved: a link out of a skill directory is not followed.
 */
export function checkRecorded(path: string): "ok" | "gone" | "not-a-skill" {
    if (!isAbsolute(path) || !namedAsSkill(path)) return "not-a-skill";
    let real: string;
    try {
        real = realpathSync(path);
    } catch {
        return "gone";
    }
    return namedAsSkill(real) && isRegularFile(real) ? "ok" : "not-a-skill";
}

export const SKILL_INSTALLS_MAX = 50;

export interface SkillInstalls {
    /** Absolute paths of the installed SKILL.md files, newest first. */
    copies: string[];
    /** When the stale notice last named a copy, and for which margin version. */
    told: Record<string, { version: string; at: number }>;
    /** The margin version for which the user chose to keep their edited copy. */
    kept: Record<string, string>;
}

function installsPaths(env: Env): { file: string; lock: string } {
    const dir = deviceDir(env);
    return { file: join(dir, "skill-installs.json"), lock: join(dir, "skill-installs.lock") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readInstalls(env: Env): SkillInstalls {
    const installs: SkillInstalls = { copies: [], told: {}, kept: {} };
    try {
        const stored: unknown = JSON.parse(readFileSync(installsPaths(env).file, "utf8"));
        if (!isRecord(stored)) return installs;
        if (Array.isArray(stored.copies)) {
            installs.copies = stored.copies.filter((item) => typeof item === "string");
        }
        for (const [path, entry] of Object.entries(isRecord(stored.told) ? stored.told : {})) {
            if (
                isRecord(entry) &&
                typeof entry.version === "string" &&
                typeof entry.at === "number"
            ) {
                installs.told[path] = { version: entry.version, at: entry.at };
            }
        }
        for (const [path, entry] of Object.entries(isRecord(stored.kept) ? stored.kept : {})) {
            if (typeof entry === "string") installs.kept[path] = entry;
        }
    } catch {
        // Missing or torn: nothing recorded.
    }
    return installs;
}

/**
 * Changes the record under its lock. On every change a path leaves the record, with what was
 * noted about it, when its file is gone or it does not pass `checkRecorded`; the list keeps the
 * newest `SKILL_INSTALLS_MAX`. The copies that apply where the command runs come from the working
 * directory and HOME, not from the record, so they only need to be files: a `.claude` that is a
 * link into a dotfiles directory stays on record for its own user.
 */
export async function changeInstalls(
    io: Pick<Io, "cwd" | "env">,
    change: (installs: SkillInstalls) => void,
): Promise<SkillInstalls> {
    const { env } = io;
    const paths = installsPaths(env);
    ensureStateDir(deviceDir(env));
    const targets = skillTargets(io);
    const here = new Set([targets.project, targets.user]);
    return await withLock(paths.lock, () => {
        const installs = readInstalls(env);
        change(installs);
        installs.copies = [...new Set(installs.copies)]
            .filter((path) => (here.has(path) ? isRegularFile(path) : checkRecorded(path) === "ok"))
            .slice(0, SKILL_INSTALLS_MAX);
        const listed = new Set(installs.copies);
        for (const notes of [installs.told, installs.kept]) {
            for (const path of Object.keys(notes)) {
                if (!listed.has(path)) delete notes[path];
            }
        }
        const temp = `${paths.file}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(installs), { mode: 0o600 });
        renameSync(temp, paths.file);
        return installs;
    });
}

/** Puts `path` first in the record. `kept` notes the user's choice to keep it for `version`. */
export function noteInstall(installs: SkillInstalls, path: string, kept?: string): void {
    installs.copies = [path, ...installs.copies.filter((item) => item !== path)];
    delete installs.told[path];
    if (kept === undefined) delete installs.kept[path];
    else installs.kept[path] = kept;
}

/** Asks until the answer starts with one of `keys`; an empty answer takes `fallback`. */
export async function choose<K extends string>(
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

export interface SetupOptions {
    /** `~/.claude/skills` instead of the project's. */
    user?: boolean;
    /** Overwrite a skill that differs from this package's. */
    force?: boolean;
}

/**
 * With a person at the terminal (`io.ask`), every choice a flag did not already make is asked:
 * where the skill goes, whether to overwrite one that differs, and whether to print the snippet.
 * Without one the flags decide, so an agent or a script never waits on a prompt. An untouched
 * copy of an older margin's skill is nobody's choice to keep: it is replaced without a question.
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
    const version = packageVersion();
    const state = existsSync(target)
        ? classifySkill(readFileSync(target, "utf8"), skill, version)
        : undefined;

    let outcome: "installed" | "unchanged" | "replaced" | "kept";
    let note = "";
    if (state === undefined) {
        outcome = "installed";
    } else if (state.kind === "current") {
        outcome = "unchanged";
    } else if (state.kind === "older" || options.force) {
        outcome = "replaced";
    } else if (io.ask) {
        const question =
            state.kind === "newer"
                ? `${shown} is from a newer margin (${state.version}). Overwrite it with ${version}'s? [y/N] `
                : `${shown} differs from this version (your own edits, or a margin this one does not know). Overwrite it? [y/N] `;
        outcome = (await choose(io.ask, question, ["y", "n"], "n")) === "y" ? "replaced" : "kept";
    } else if (state.kind === "newer") {
        outcome = "kept";
        note = `from a newer margin (${state.version}); --force overwrites\n`;
    } else {
        io.write(`err changed; ${shown} differs from this version, --force overwrites\n`);
        return 1;
    }
    if (outcome === "installed" || outcome === "replaced") {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, skill);
    }
    try {
        await changeInstalls(io, (installs) =>
            noteInstall(installs, canonical(target), outcome === "kept" ? version : undefined),
        );
    } catch {
        // The skill is installed either way; an unrecorded copy is still found from its project.
    }
    io.write(`ok ${outcome} ${shown}\n${note}`);
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
