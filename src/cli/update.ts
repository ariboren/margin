// Keeps the installed skill current. `margin update [--skill-only]` updates the package with the
// package manager that installed it, then refreshes every skill copy it knows of; the stale
// notice is the one line `margin <doc>` adds when a copy that applies there is out of date.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Io } from "./main.ts";
import {
    SKILL_PATH,
    changeInstalls,
    checkRecorded,
    choose,
    classifySkill,
    compareVersions,
    isStale,
    packageRoot,
    packageVersion,
    readInstalls,
    skillTargets,
    type SkillClass,
} from "./setup.ts";

/** Runs a command with the terminal attached and answers with its exit code. */
export type Runner = (argv: string[]) => Promise<number>;

export async function spawnRunner(argv: string[]): Promise<number> {
    try {
        const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        return await child.exited;
    } catch {
        // Not on PATH.
        return 127;
    }
}

export type Installer =
    | { kind: "bun" | "brew" | "npm"; argv: string[] }
    | { kind: "bunx" | "npx" | "checkout" | "unknown" };

/**
 * How this copy of the package got here, read off the real path of its root: each package manager
 * keeps global installs in a place of its own. Nothing is run to find out.
 */
export function detectInstaller(root: string): Installer {
    const path = root.replaceAll("\\", "/");
    // Before npm: the Homebrew formula also unpacks the npm tarball.
    if (path.includes("/Cellar/margin/")) {
        return { kind: "brew", argv: ["brew", "upgrade", "ariboren/tap/margin"] };
    }
    if (path.includes("/install/global/node_modules/")) {
        return { kind: "bun", argv: ["bun", "add", "-g", "margin-md@latest"] };
    }
    if (path.includes("/install/cache/") || path.includes("/bunx-")) return { kind: "bunx" };
    if (path.includes("/_npx/")) return { kind: "npx" };
    if (isNpmGlobal(root)) {
        return { kind: "npm", argv: ["npm", "install", "-g", "margin-md@latest"] };
    }
    return { kind: existsSync(join(root, ".git")) ? "checkout" : "unknown" };
}

/**
 * npm's global layout and nothing looser, since a wrong yes runs a global install nobody asked
 * for: the package sits in `<prefix>/lib/node_modules` with npm's `margin` link in
 * `<prefix>/bin` (on Windows `<prefix>/node_modules` with `margin.cmd` beside it), and the
 * directory holding `node_modules` has no `package.json`, which a project's own dependency
 * folder always has.
 */
function isNpmGlobal(root: string): boolean {
    const modules = dirname(root);
    const holder = dirname(modules);
    if (basename(root) !== "margin-md" || basename(modules) !== "node_modules") return false;
    if (existsSync(join(holder, "package.json"))) return false;
    if (basename(holder) === "lib") return existsSync(join(dirname(holder), "bin", "margin"));
    return existsSync(join(holder, "margin.cmd"));
}

const NOT_UPDATED: Record<Exclude<Installer["kind"], "bun" | "brew" | "npm">, string> = {
    bunx: " runs through bunx",
    npx: " runs through npx",
    checkout: " runs from a checkout",
    unknown: ": can't tell how it was installed",
};

const INSTALLED_WITH = { bun: "bun", brew: "Homebrew", npm: "npm" } as const;

/** The package root a `margin` bin on PATH runs, or undefined when it is not one margin knows. */
function rootOfBin(bin: string): string | undefined {
    let real: string;
    try {
        real = realpathSync(bin);
    } catch {
        return undefined;
    }
    const path = real.replaceAll("\\", "/");
    // Homebrew's bin is a wrapper script beside libexec, not a link into the package.
    if (/\/Cellar\/margin\/[^/]+\/bin\/margin$/.test(path)) {
        return join(dirname(dirname(real)), "libexec");
    }
    if (path.endsWith("/src/cli/main.ts")) return dirname(dirname(dirname(real)));
    return undefined;
}

function versionAt(root: string | undefined): string | undefined {
    if (root === undefined) return undefined;
    try {
        return packageVersion(root);
    } catch {
        return undefined;
    }
}

export interface UpdateOptions {
    /** Leave the package alone and only refresh the installed skill copies. */
    skillOnly?: boolean;
}

export interface UpdateDeps {
    /** Real path of the running package. */
    root: string;
    runner: Runner;
    which(bin: string): string | null;
}

function defaultDeps(): UpdateDeps {
    return { root: realpathSync(packageRoot), runner: spawnRunner, which: Bun.which };
}

export async function update(
    io: Io,
    options: UpdateOptions = {},
    deps: UpdateDeps = defaultDeps(),
): Promise<number> {
    const { root, runner } = deps;
    // Read before anything runs: the package manager replaces these files under this process.
    const before = packageVersion(root);
    const skill = readFileSync(join(root, "skill/margin/SKILL.md"), "utf8");
    const refresh = async () => await refreshSkills(io, skill, before);
    if (options.skillOnly) return (await refresh()) ? 0 : 1;

    const installer = detectInstaller(root);
    if (!("argv" in installer)) {
        io.write(
            `margin ${before}${NOT_UPDATED[installer.kind]}; package not updated, refreshing the skill only\n`,
        );
        return (await refresh()) ? 0 : 1;
    }
    io.write(`margin ${before}, installed with ${INSTALLED_WITH[installer.kind]}\n`);
    io.write(`running: ${installer.argv.join(" ")}\n`);
    const code = await runner(installer.argv);
    if (code !== 0) {
        io.write(
            `err update failed (${installer.argv[0]} exited ${code}); refreshing the skill from ${before}\n`,
        );
        await refresh();
        return 1;
    }

    // The new version's own code refreshes the skill, so the bin has to be the install that was
    // just updated: Homebrew moves the package to a new directory, bun and npm replace it in place.
    const bin = deps.which("margin");
    const binRoot = bin === null ? undefined : rootOfBin(bin);
    const sameInstall =
        binRoot !== undefined &&
        (installer.kind === "brew" ? detectInstaller(binRoot).kind === "brew" : binRoot === root);
    const after = versionAt(sameInstall ? binRoot : installer.kind === "brew" ? undefined : root);
    if (after === before) {
        io.write(
            installer.kind === "brew"
                ? `margin ${before}: brew had nothing newer; the tap may not have the latest release yet\n`
                : `margin ${before} is already the latest\n`,
        );
        return (await refresh()) ? 0 : 1;
    }
    if (after !== undefined) io.write(`margin ${before} -> ${after}\n`);
    if (sameInstall && after !== undefined) {
        // `--skill-only` never reaches this line again, so the hand-over cannot loop.
        return (await runner([bin!, "update", "--skill-only"])) === 0 ? 0 : 1;
    }
    const ok = await refresh();
    io.write(`skill refreshed from ${before}; run margin update --skill-only to finish\n`);
    return ok ? 0 : 1;
}

/** The copy by its full path, so a prompt never asks about a file it does not name. */
function location(path: string, user: string | undefined): string {
    return path === user ? `user (~/${SKILL_PATH})` : path;
}

function reason(error: unknown): string {
    return (error as NodeJS.ErrnoException).code ?? "failed";
}

/**
 * Brings every copy margin knows of to `skill`: the recorded ones, the current project's and the
 * user's. Only existing copies: nothing is installed where there was none. Answers false when a
 * copy could not be written.
 */
async function refreshSkills(io: Io, skill: string, version: string): Promise<boolean> {
    const targets = skillTargets(io);
    // The project's and the user's come from where the command runs. A recorded path comes from a
    // file, so it is checked before it is read or written, and one that fails is never touched.
    const paths = [targets.project, targets.user].filter(
        (path): path is string => path !== undefined && existsSync(path),
    );
    for (const path of readInstalls(io.env).copies) {
        if (paths.includes(path)) continue;
        const check = checkRecorded(path);
        if (check === "ok") paths.push(path);
        else if (check === "not-a-skill") {
            io.write(`skipped ${path}: not a margin skill copy, dropped from the record\n`);
        }
    }
    const settled = new Map<string, string | undefined>();
    let ok = true;
    for (const path of paths) {
        const where = location(path, targets.user);
        let state: SkillClass;
        try {
            state = classifySkill(readFileSync(path, "utf8"), skill, version);
        } catch (error) {
            io.write(`err ${where}: not read (${reason(error)})\n`);
            ok = false;
            continue;
        }
        if (state.kind === "current") {
            io.write(`ok current ${where}\n`);
            settled.set(path, undefined);
            continue;
        }
        if (state.kind === "newer") {
            io.write(`left ${where}: from a newer margin (${state.version})\n`);
            continue;
        }
        if (state.kind === "edited") {
            if (!io.ask) {
                const force =
                    path === targets.user
                        ? "margin setup --user --force overwrites"
                        : "margin setup --force in that project overwrites";
                io.write(
                    `kept ${where}: edited; run margin update at a terminal to choose, or ${force}\n`,
                );
                continue;
            }
            const replace = await choose(
                io.ask,
                `${where} has changes that are not margin's. Replace it with ${version}'s? [y/N] `,
                ["y", "n"],
                "n",
            );
            if (replace === "n") {
                io.write(`kept ${where}\n`);
                settled.set(path, version);
                continue;
            }
        }
        try {
            writeFileSync(path, skill);
            io.write(`ok updated ${where}\n`);
            settled.set(path, undefined);
        } catch (error) {
            io.write(`err ${where}: not written (${reason(error)})\n`);
            ok = false;
        }
    }
    if (paths.length === 0) io.write("ok no skill installed; margin setup installs one\n");
    try {
        await changeInstalls(io, (installs) => {
            installs.copies = [...paths, ...installs.copies];
            for (const [path, kept] of settled) {
                delete installs.told[path];
                if (kept === undefined) delete installs.kept[path];
                else installs.kept[path] = kept;
            }
        });
    } catch {
        // The copies are refreshed either way; the record only widens what the next run finds.
    }
    return ok;
}

/** A copy named by the notice is not named again for this long, unless margin is updated. */
export const TOLD_EVERY_MS = 24 * 60 * 60 * 1000;

/** The ceiling in budget.json; a line that would pass it drops the versions. */
export const STALE_LINE_MAX = 70;

/** What an agent reads on stderr. `from` is the stale copy's version when it is known and older. */
export function staleLine(from: string | undefined, to: string): string {
    const rest = ": tell the user to run margin update\n";
    const line = `margin skill ${from} < ${to}${rest}`;
    const comparable = from !== undefined && compareVersions(from, to) < 0;
    return comparable && Buffer.byteLength(line) <= STALE_LINE_MAX
        ? line
        : `margin skill old${rest}`;
}

/** What a person reads at the terminal. */
export function staleSentence(where: ("project" | "user")[]): string {
    const names = { project: "for this project", user: "for all your projects" };
    return `The margin skill ${where.map((key) => names[key]).join(" and ")} is out of date. Run margin update to refresh it.\n`;
}

/**
 * After `margin <doc>`: says so when the project's or the user's installed skill is out of date.
 * A person reads it after the URL. An agent reads it on stderr, because the skill has it read
 * stdout with `head -1`, which would cut the line off. Silent once the copy is current, once the
 * user chose to keep it for this version, and for a day after it was last said. Never fails the
 * open.
 */
export async function staleNotice(io: Io, now = Date.now()): Promise<void> {
    const out = io.isTTY ? io.write : io.warn;
    if (!out) return;
    try {
        const version = packageVersion();
        const skill = readFileSync(join(packageRoot, "skill/margin/SKILL.md"), "utf8");
        const targets = skillTargets(io);
        const stale: { path: string; where: "project" | "user"; from?: string }[] = [];
        for (const where of ["project", "user"] as const) {
            const path = targets[where];
            if (path === undefined || stale.some((copy) => copy.path === path)) continue;
            if (!existsSync(path)) continue;
            const state = classifySkill(readFileSync(path, "utf8"), skill, version);
            if (isStale(state, version)) stale.push({ path, where, from: state.version });
        }
        if (stale.length === 0) return;
        const { told, kept } = readInstalls(io.env);
        const due = stale.filter(({ path }) => {
            if (kept[path] === version) return false;
            const last = told[path];
            return !(last?.version === version && now - last.at < TOLD_EVERY_MS);
        });
        if (due.length === 0) return;
        await changeInstalls(io, (installs) => {
            for (const { path } of due) {
                if (!installs.copies.includes(path)) installs.copies.unshift(path);
                installs.told[path] = { version, at: now };
            }
        });
        out(
            io.isTTY
                ? staleSentence(due.map((copy) => copy.where))
                : staleLine(due[0]!.from, version),
        );
    } catch {
        // A notice is never worth a failed open.
    }
}
