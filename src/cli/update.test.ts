import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import budget from "../../budget.json";
import type { Io } from "./main.ts";
import {
    changeInstalls,
    noteInstall,
    packageVersion,
    readInstalls,
    skillSource,
    stampSkill,
} from "./setup.ts";
import {
    STALE_LINE_MAX,
    TOLD_EVERY_MS,
    detectInstaller,
    spawnRunner,
    staleLine,
    staleNotice,
    staleSentence,
    update,
    type UpdateDeps,
} from "./update.ts";

const INSTALLED = ".claude/skills/margin/SKILL.md";
const OLDER = stampSkill("An older skill.\n", "0.0.1");
const EDITED = "my own skill\n";

let dir: string;
let home: string;
let project: string;

beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "margin-update-")));
    home = join(dir, "home");
    project = join(dir, "project");
    mkdirSync(home);
    mkdirSync(project);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function put(path: string, text: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
}

const read = (path: string) => readFileSync(path, "utf8");

/** HOME and the device directory both inside the temp dir: the real ones are never touched. */
function sandboxEnv(): Io["env"] {
    return { HOME: home, MARGIN_STATE_DIR: join(dir, "state") };
}

interface Terminal extends Io {
    out(): string;
    err(): string;
    asked: string[];
}

function terminal(options: { answers?: string[]; isTTY?: boolean; cwd?: string } = {}): Terminal {
    let stdout = "";
    let stderr = "";
    const asked: string[] = [];
    const { answers } = options;
    return {
        cwd: options.cwd ?? project,
        env: sandboxEnv(),
        isTTY: options.isTTY ?? answers !== undefined,
        write: (text) => {
            stdout += text;
        },
        warn: (text) => {
            stderr += text;
        },
        stdin: async () => "",
        ...(answers
            ? {
                  ask: async (question: string) => {
                      asked.push(question);
                      return answers.shift() ?? "";
                  },
              }
            : {}),
        out: () => stdout,
        err: () => stderr,
        asked,
    };
}

/** A package as a package manager would lay it out, holding only what `update` reads. */
function fakePackage(root: string, version: string): string {
    put(join(root, "package.json"), JSON.stringify({ version }));
    put(join(root, "skill/margin/SKILL.md"), stampSkill(`Skill of ${version}.\n`, version));
    put(join(root, "src/cli/main.ts"), "");
    return root;
}

const skillOf = (version: string) => stampSkill(`Skill of ${version}.\n`, version);

interface Fake extends UpdateDeps {
    ran: string[][];
}

/** No package manager ever runs: the runner only records what it was asked to run. */
function fake(root: string, options: { bin?: string | null; onRun?: () => number | void } = {}) {
    const ran: string[][] = [];
    const deps: Fake = {
        root,
        ran,
        runner: async (argv) => {
            ran.push(argv);
            return (ran.length === 1 ? options.onRun?.() : undefined) ?? 0;
        },
        which: () => options.bin ?? null,
    };
    return deps;
}

describe("how margin was installed", () => {
    test("each package manager is known by where it keeps global installs", () => {
        expect(detectInstaller("/u/.bun/install/global/node_modules/margin-md")).toEqual({
            kind: "bun",
            argv: ["bun", "add", "-g", "margin-md@latest"],
        });
        expect(detectInstaller("/usr/local/lib/node_modules/margin-md")).toEqual({
            kind: "npm",
            argv: ["npm", "install", "-g", "margin-md@latest"],
        });
        expect(
            detectInstaller("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\margin-md"),
        ).toEqual({ kind: "npm", argv: ["npm", "install", "-g", "margin-md@latest"] });
        expect(detectInstaller("/opt/homebrew/Cellar/margin/0.3.0/libexec")).toEqual({
            kind: "brew",
            argv: ["brew", "upgrade", "ariboren/tap/margin"],
        });
    });

    test("a one-off run, a checkout and anything else update no package", () => {
        expect(detectInstaller("/tmp/bunx-501-margin-md@latest/node_modules/margin-md").kind).toBe(
            "bunx",
        );
        expect(detectInstaller("/u/.bun/install/cache/margin-md@0.3.0").kind).toBe("bunx");
        expect(detectInstaller("/u/.npm/_npx/abc/node_modules/margin-md").kind).toBe("npx");
        expect(detectInstaller(join(dir, "app/node_modules/margin-md")).kind).toBe("unknown");
        mkdirSync(join(dir, "checkout/.git"), { recursive: true });
        expect(detectInstaller(join(dir, "checkout")).kind).toBe("checkout");
    });
});

describe("margin update --skill-only", () => {
    test("refreshes the project's, the user's and every recorded copy, and reports each", async () => {
        const root = fakePackage(join(dir, "pkg"), "1.0.0");
        const mine = put(join(project, INSTALLED), OLDER);
        const users = put(join(home, INSTALLED), OLDER);
        const elsewhere = put(join(dir, "other", INSTALLED), OLDER);
        const upToDate = put(join(dir, "fresh", INSTALLED), skillOf("1.0.0"));
        const gone = join(dir, "gone", INSTALLED);
        await changeInstalls(sandboxEnv(), (installs) => {
            put(gone, OLDER);
            for (const path of [elsewhere, upToDate, gone]) noteInstall(installs, path);
            installs.told[elsewhere] = { version: "1.0.0", at: 1 };
        });
        rmSync(join(dir, "gone"), { recursive: true });

        const io = terminal();
        const deps = fake(root);
        expect(await update(io, { skillOnly: true }, deps)).toBe(0);
        expect(deps.ran).toEqual([]);
        expect(io.out()).toBe(
            [
                `ok updated ${project}`,
                `ok updated user (~/${INSTALLED})`,
                `ok current ${join(dir, "fresh")}`,
                `ok updated ${join(dir, "other")}`,
                "",
            ].join("\n"),
        );
        for (const path of [mine, users, elsewhere]) expect(read(path)).toBe(skillOf("1.0.0"));
        expect(readInstalls(sandboxEnv())).toEqual({
            copies: [mine, users, upToDate, elsewhere],
            told: {},
            kept: {},
        });
    });

    test("never installs a copy where there was none", async () => {
        const io = terminal();
        expect(
            await update(io, { skillOnly: true }, fake(fakePackage(join(dir, "pkg"), "1.0.0"))),
        ).toBe(0);
        expect(io.out()).toBe("ok no skill installed; margin setup installs one\n");
        expect(existsSync(join(project, ".claude"))).toBe(false);
        expect(existsSync(join(home, ".claude"))).toBe(false);
    });

    test("with nobody at the terminal an edited copy is kept, named, and is not a failure", async () => {
        const root = fakePackage(join(dir, "pkg"), "1.0.0");
        put(join(project, INSTALLED), EDITED);
        put(join(home, INSTALLED), OLDER.replace("An older", "My own"));
        const io = terminal();
        expect(await update(io, { skillOnly: true }, fake(root))).toBe(0);
        expect(io.out()).toBe(
            [
                `kept ${project}: edited; run margin update at a terminal to choose, or margin setup --force there overwrites`,
                `kept user (~/${INSTALLED}): edited; run margin update at a terminal to choose, or margin setup --user --force overwrites`,
                "",
            ].join("\n"),
        );
        expect(read(join(project, INSTALLED))).toBe(EDITED);
        expect(readInstalls(sandboxEnv()).kept).toEqual({});
    });

    test("at a terminal an edited copy is replaced only on yes; keep is the default and is noted", async () => {
        const root = fakePackage(join(dir, "pkg"), "1.0.0");
        const mine = put(join(project, INSTALLED), EDITED);
        const users = put(join(home, INSTALLED), EDITED);
        const io = terminal({ answers: ["", "y"] });
        expect(await update(io, { skillOnly: true }, fake(root))).toBe(0);
        expect(io.asked).toEqual([
            `${project} has changes that are not margin's. Replace it with 1.0.0's? [y/N] `,
            `user (~/${INSTALLED}) has changes that are not margin's. Replace it with 1.0.0's? [y/N] `,
        ]);
        expect(io.out()).toBe(`kept ${project}\nok updated user (~/${INSTALLED})\n`);
        expect(read(mine)).toBe(EDITED);
        expect(read(users)).toBe(skillOf("1.0.0"));
        expect(readInstalls(sandboxEnv()).kept).toEqual({ [mine]: "1.0.0" });
    });

    test("a copy from a newer margin is left alone", async () => {
        const root = fakePackage(join(dir, "pkg"), "1.0.0");
        const newer = put(join(project, INSTALLED), skillOf("2.0.0"));
        const io = terminal({ answers: [] });
        expect(await update(io, { skillOnly: true }, fake(root))).toBe(0);
        expect(io.out()).toBe(`left ${project}: from a newer margin (2.0.0)\n`);
        expect(io.asked).toEqual([]);
        expect(read(newer)).toBe(skillOf("2.0.0"));
    });

    test("a copy that cannot be written is an error line and exit 1", async () => {
        const root = fakePackage(join(dir, "pkg"), "1.0.0");
        const mine = put(join(project, INSTALLED), OLDER);
        chmodSync(mine, 0o400);
        const io = terminal();
        expect(await update(io, { skillOnly: true }, fake(root))).toBe(1);
        expect(io.out()).toBe(`err ${project}: not written (EACCES)\n`);
    });

    test("a record that cannot be written does not fail the refresh", async () => {
        const root = fakePackage(join(dir, "pkg"), "1.0.0");
        put(join(project, INSTALLED), OLDER);
        writeFileSync(join(dir, "state"), "not a directory");
        const io = terminal();
        expect(await update(io, { skillOnly: true }, fake(root))).toBe(0);
        expect(io.out()).toBe(`ok updated ${project}\n`);
    });

    test("the real package, from this checkout, refreshes with its own skill", async () => {
        const mine = put(join(project, INSTALLED), OLDER);
        const io = terminal();
        expect(await update(io, { skillOnly: true })).toBe(0);
        expect(read(mine)).toBe(read(skillSource));
    });
});

describe("margin update", () => {
    const bunRoot = () => join(dir, "bun/install/global/node_modules/margin-md");

    /** The bin a global install puts on PATH: a link to the package's main.ts. */
    function linkBin(root: string): string {
        const bin = join(dir, "bin/margin");
        mkdirSync(dirname(bin), { recursive: true });
        symlinkSync(join(root, "src/cli/main.ts"), bin);
        return bin;
    }

    test("says the command, runs it, then hands the skill to the new version", async () => {
        const root = fakePackage(bunRoot(), "1.0.0");
        const bin = linkBin(root);
        put(join(project, INSTALLED), OLDER);
        const io = terminal();
        const deps = fake(root, { bin, onRun: () => void fakePackage(root, "1.1.0") });
        expect(await update(io, {}, deps)).toBe(0);
        expect(deps.ran).toEqual([
            ["bun", "add", "-g", "margin-md@latest"],
            [bin, "update", "--skill-only"],
        ]);
        expect(io.out()).toBe(
            [
                "margin 1.0.0, installed with bun",
                "running: bun add -g margin-md@latest",
                "margin 1.0.0 -> 1.1.0",
                "",
            ].join("\n"),
        );
        // The old version's process leaves the copies to the new one.
        expect(read(join(project, INSTALLED))).toBe(OLDER);
    });

    test("the new version failing to refresh is exit 1", async () => {
        const root = fakePackage(bunRoot(), "1.0.0");
        const deps = fake(root, {
            bin: linkBin(root),
            onRun: () => void fakePackage(root, "1.1.0"),
        });
        deps.runner = async (argv) => {
            deps.ran.push(argv);
            if (argv[0] === "bun") fakePackage(root, "1.1.0");
            return argv[0] === "bun" ? 0 : 2;
        };
        expect(await update(terminal(), {}, deps)).toBe(1);
        expect(deps.ran).toHaveLength(2);
    });

    test("already the latest: the skill is refreshed here, nothing is re-run", async () => {
        const root = fakePackage(join(dir, "usr/lib/node_modules/margin-md"), "1.0.0");
        put(join(project, INSTALLED), OLDER);
        const io = terminal();
        const deps = fake(root, { bin: linkBin(root) });
        expect(await update(io, {}, deps)).toBe(0);
        expect(deps.ran).toEqual([["npm", "install", "-g", "margin-md@latest"]]);
        expect(io.out()).toBe(
            [
                "margin 1.0.0, installed with npm",
                "running: npm install -g margin-md@latest",
                "margin 1.0.0 is already the latest",
                `ok updated ${project}`,
                "",
            ].join("\n"),
        );
    });

    test("a failed package manager is exit 1; the skill is still refreshed from this version", async () => {
        const root = fakePackage(bunRoot(), "1.0.0");
        put(join(project, INSTALLED), OLDER);
        const io = terminal();
        const deps = fake(root, { bin: linkBin(root), onRun: () => 1 });
        expect(await update(io, {}, deps)).toBe(1);
        expect(deps.ran).toHaveLength(1);
        expect(io.out()).toBe(
            [
                "margin 1.0.0, installed with bun",
                "running: bun add -g margin-md@latest",
                "err update failed (bun exited 1); refreshing the skill from 1.0.0",
                `ok updated ${project}`,
                "",
            ].join("\n"),
        );
        expect(read(join(project, INSTALLED))).toBe(skillOf("1.0.0"));
    });

    for (const [name, bin] of [
        ["no margin on PATH", () => null],
        [
            "a margin on PATH that is another install",
            () => linkBin(fakePackage(join(dir, "else"), "3.0.0")),
        ],
        [
            "a margin on PATH that is no package's bin",
            () => put(join(dir, "bin/margin"), "#!/bin/sh\n"),
        ],
        ["a margin on PATH that is gone", () => join(dir, "bin/nothing")],
    ] as const) {
        test(`${name}: refreshes from the old version and says how to finish, without re-running`, async () => {
            const root = fakePackage(bunRoot(), "1.0.0");
            put(join(project, INSTALLED), OLDER);
            const io = terminal();
            const deps = fake(root, { bin: bin(), onRun: () => void fakePackage(root, "1.1.0") });
            expect(await update(io, {}, deps)).toBe(0);
            expect(deps.ran).toHaveLength(1);
            expect(io.out()).toBe(
                [
                    "margin 1.0.0, installed with bun",
                    "running: bun add -g margin-md@latest",
                    "margin 1.0.0 -> 1.1.0",
                    `ok updated ${project}`,
                    "skill refreshed from 1.0.0; run margin update --skill-only to finish",
                    "",
                ].join("\n"),
            );
            expect(read(join(project, INSTALLED))).toBe(skillOf("1.0.0"));
        });
    }

    describe("Homebrew", () => {
        const cellar = (version: string) => join(dir, "brew/Cellar/margin", version);

        /** Homebrew's bin is a wrapper script in the keg, linked from the prefix. */
        function brewBin(version: string): string {
            put(join(cellar(version), "bin/margin"), "#!/bin/sh\n");
            const bin = join(dir, "brew/bin/margin");
            rmSync(bin, { force: true });
            mkdirSync(dirname(bin), { recursive: true });
            symlinkSync(join(cellar(version), "bin/margin"), bin);
            return bin;
        }

        test("the upgrade moves the package, and the new bin finishes", async () => {
            const root = fakePackage(join(cellar("1.0.0"), "libexec"), "1.0.0");
            const bin = brewBin("1.0.0");
            const io = terminal();
            const deps = fake(root, {
                bin,
                onRun: () => {
                    fakePackage(join(cellar("1.1.0"), "libexec"), "1.1.0");
                    brewBin("1.1.0");
                    rmSync(cellar("1.0.0"), { recursive: true });
                },
            });
            expect(await update(io, {}, deps)).toBe(0);
            expect(deps.ran).toEqual([
                ["brew", "upgrade", "ariboren/tap/margin"],
                [bin, "update", "--skill-only"],
            ]);
            expect(io.out()).toBe(
                [
                    "margin 1.0.0, installed with Homebrew",
                    "running: brew upgrade ariboren/tap/margin",
                    "margin 1.0.0 -> 1.1.0",
                    "",
                ].join("\n"),
            );
        });

        test("nothing to upgrade says the tap may be behind, not that this is the latest", async () => {
            const root = fakePackage(join(cellar("1.0.0"), "libexec"), "1.0.0");
            put(join(project, INSTALLED), OLDER);
            const io = terminal();
            const deps = fake(root, { bin: brewBin("1.0.0") });
            expect(await update(io, {}, deps)).toBe(0);
            expect(deps.ran).toHaveLength(1);
            expect(io.out()).toBe(
                [
                    "margin 1.0.0, installed with Homebrew",
                    "running: brew upgrade ariboren/tap/margin",
                    "margin 1.0.0: brew had nothing newer; the tap may not have the latest release yet",
                    `ok updated ${project}`,
                    "",
                ].join("\n"),
            );
        });

        test("no bin to hand over to: refreshes from the old version and says how to finish", async () => {
            const root = fakePackage(join(cellar("1.0.0"), "libexec"), "1.0.0");
            const io = terminal();
            const deps = fake(root, { bin: null });
            expect(await update(io, {}, deps)).toBe(0);
            expect(deps.ran).toHaveLength(1);
            expect(io.out()).toEndWith(
                "ok no skill installed; margin setup installs one\nskill refreshed from 1.0.0; run margin update --skill-only to finish\n",
            );
        });
    });

    for (const [where, reason] of [
        ["bunx-501-margin-md@latest/node_modules/margin-md", " runs through bunx"],
        ["npm/_npx/abc/node_modules/margin-md", " runs through npx"],
        ["app/node_modules/margin-md", ": can't tell how it was installed"],
        ["checkout", " runs from a checkout"],
    ] as const) {
        test(`margin that${reason.replace(":", "")}: says so and only refreshes the skill`, async () => {
            const root = fakePackage(join(dir, where), "1.0.0");
            if (where === "checkout") mkdirSync(join(root, ".git"));
            put(join(project, INSTALLED), OLDER);
            const io = terminal();
            const deps = fake(root);
            expect(await update(io, {}, deps)).toBe(0);
            expect(deps.ran).toEqual([]);
            expect(io.out()).toBe(
                `margin 1.0.0${reason}; package not updated, refreshing the skill only\nok updated ${project}\n`,
            );
        });
    }

    test("the default runner answers with the exit code, 127 for a command that is not there", async () => {
        expect(await spawnRunner([process.execPath, "-e", "process.exit(3)"])).toBe(3);
        expect(await spawnRunner([join(dir, "no-such-command")])).toBe(127);
    });
});

describe("the stale skill notice on margin <doc>", () => {
    const VERSION = packageVersion();
    const SKILL = read(skillSource);
    const agentLine = `margin skill 0.0.1 < ${VERSION}: tell the user to run margin update\n`;

    test("nothing installed, or everything current: no output and no record", async () => {
        const io = terminal();
        await staleNotice(io);
        put(join(project, INSTALLED), SKILL);
        put(
            join(home, INSTALLED),
            stampSkill(SKILL.slice(0, SKILL.lastIndexOf("\n<!--")), "0.0.1"),
        );
        await staleNotice(io);
        expect(io.out() + io.err()).toBe("");
        expect(existsSync(join(dir, "state"))).toBe(false);
    });

    test("an agent is told on stderr, once a day, and the copy is recorded", async () => {
        const mine = put(join(project, INSTALLED), OLDER);
        const io = terminal();
        await staleNotice(io, 1_000);
        expect(io.err()).toBe(agentLine);
        expect(io.out()).toBe("");
        expect(readInstalls(sandboxEnv())).toEqual({
            copies: [mine],
            told: { [mine]: { version: VERSION, at: 1_000 } },
            kept: {},
        });
        await staleNotice(io, 1_000 + TOLD_EVERY_MS - 1);
        expect(io.err()).toBe(agentLine);
        await staleNotice(io, 1_000 + TOLD_EVERY_MS);
        expect(io.err()).toBe(agentLine + agentLine);
    });

    test("a person is told on stdout, in a sentence naming which copy", async () => {
        put(join(project, INSTALLED), OLDER);
        const first = terminal({ isTTY: true });
        await staleNotice(first, 1);
        expect(first.out()).toBe(
            "The margin skill for this project is out of date. Run margin update to refresh it.\n",
        );
        expect(first.err()).toBe("");

        put(join(home, INSTALLED), EDITED);
        const second = terminal({ isTTY: true });
        await staleNotice(second, 2);
        expect(second.out()).toBe(
            "The margin skill for all your projects is out of date. Run margin update to refresh it.\n",
        );
        expect(staleSentence(["project", "user"])).toBe(
            "The margin skill for this project and for all your projects is out of date. Run margin update to refresh it.\n",
        );
    });

    test("an unstamped copy shows no version to compare", async () => {
        put(join(home, INSTALLED), EDITED);
        const io = terminal();
        await staleNotice(io);
        expect(io.err()).toBe("margin skill old: tell the user to run margin update\n");
    });

    test("silent once the copy is current, or kept by the user for this version", async () => {
        const mine = put(join(project, INSTALLED), EDITED);
        await changeInstalls(sandboxEnv(), (installs) => noteInstall(installs, mine, VERSION));
        const io = terminal();
        await staleNotice(io);
        expect(io.err()).toBe("");
        // Kept for another version: this one says so again.
        await changeInstalls(sandboxEnv(), (installs) => noteInstall(installs, mine, "0.0.1"));
        await staleNotice(io);
        expect(io.err()).toBe("margin skill old: tell the user to run margin update\n");

        writeFileSync(mine, SKILL);
        await staleNotice(io, Date.now() + 2 * TOLD_EVERY_MS);
        expect(io.err()).toBe("margin skill old: tell the user to run margin update\n");
    });

    test("a project that is the home directory is one copy, and a newer copy is not stale", async () => {
        put(join(home, INSTALLED), stampSkill("A newer skill.\n", "99.0.0"));
        const io = terminal({ cwd: home });
        await staleNotice(io);
        expect(io.err()).toBe("");
        put(join(home, INSTALLED), OLDER);
        await staleNotice(io);
        expect(io.err()).toBe(agentLine);
    });

    test("nowhere to say it, or a record that cannot be written: nothing, and no failure", async () => {
        put(join(project, INSTALLED), OLDER);
        const { warn: _warn, ...mute } = terminal();
        await staleNotice(mute);
        expect(existsSync(join(dir, "state"))).toBe(false);

        writeFileSync(join(dir, "state"), "not a directory");
        const io = terminal();
        await staleNotice(io);
        expect(io.err()).toBe("");
    });

    test("the agent line stays within its ceiling in budget.json, whatever the versions", () => {
        expect(STALE_LINE_MAX).toBe(budget.staleSkill);
        const widest = staleLine("10.10.10", "10.10.11");
        expect(Buffer.byteLength(widest)).toBeLessThanOrEqual(budget.staleSkill);
        expect(widest).toBe(
            "margin skill 10.10.10 < 10.10.11: tell the user to run margin update\n",
        );
        const old = "margin skill old: tell the user to run margin update\n";
        expect(staleLine("1.0.0-beta.10", "1.0.0-beta.11")).toBe(old);
        expect(staleLine("0.4.0", "0.4.0")).toBe(old);
        expect(staleLine(undefined, "0.4.0")).toBe(old);
        expect(staleLine("0.3.0", "0.4.0")).toBe(
            "margin skill 0.3.0 < 0.4.0: tell the user to run margin update\n",
        );
    });
});
