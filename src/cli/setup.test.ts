import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "./main.ts";
import {
    SKILL_INSTALLS_MAX,
    changeInstalls,
    classifySkill,
    compareVersions,
    isStale,
    noteInstall,
    packageVersion,
    readInstalls,
    setup,
    skillSource,
    skillTargets,
    snippetSource,
    stampSkill,
    type SetupOptions,
} from "./setup.ts";

const SKILL = readFileSync(skillSource, "utf8");
const SNIPPET = readFileSync(snippetSource, "utf8");
const INSTALLED = ".claude/skills/margin/SKILL.md";

let dir: string;
let home: string;

beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "margin-setup-")));
    home = join(dir, "home");
    mkdirSync(home);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** HOME and the device directory both inside the temp dir: the real ones are never touched. */
function sandboxEnv(): Io["env"] {
    return { HOME: home, MARGIN_STATE_DIR: join(dir, "state") };
}

async function runSetup(
    options: SetupOptions = {},
    cwd = dir,
    env: Io["env"] = sandboxEnv(),
    answers?: string[],
) {
    let stdout = "";
    const asked: string[] = [];
    const io: Io = {
        cwd,
        env,
        isTTY: answers !== undefined,
        write: (text) => {
            stdout += text;
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
    };
    const code = await setup(io, options);
    return { code, stdout, first: stdout.split("\n")[0], asked };
}

const interactive = (answers: string[], options: SetupOptions = {}) =>
    runSetup(options, dir, sandboxEnv(), answers);

describe("margin setup", () => {
    test("installs the package's skill in the project and prints the snippet", async () => {
        const result = await runSetup();
        expect(result.code).toBe(0);
        expect(result.first).toBe(`ok installed ${INSTALLED}`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(SKILL);
        expect(result.stdout.endsWith(SNIPPET)).toBe(true);
        expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    });

    test("a second run with the same skill writes nothing", async () => {
        await runSetup();
        const before = statSync(join(dir, INSTALLED)).mtimeMs;
        const result = await runSetup();
        expect(result.code).toBe(0);
        expect(result.first).toBe(`ok unchanged ${INSTALLED}`);
        expect(statSync(join(dir, INSTALLED)).mtimeMs).toBe(before);
    });

    test("refuses a changed skill without --force, replaces it with", async () => {
        await runSetup();
        writeFileSync(join(dir, INSTALLED), "my own edits\n");
        const refused = await runSetup();
        expect(refused.code).toBe(1);
        expect(refused.stdout).toBe(
            `err changed; ${INSTALLED} differs from this version, --force overwrites\n`,
        );
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe("my own edits\n");

        const forced = await runSetup({ force: true });
        expect(forced.code).toBe(0);
        expect(forced.first).toBe(`ok replaced ${INSTALLED}`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(SKILL);
    });

    test("installs at the git root when run from a subdirectory", async () => {
        mkdirSync(join(dir, ".git"));
        const sub = join(dir, "docs", "notes");
        mkdirSync(sub, { recursive: true });
        const result = await runSetup({}, sub);
        expect(result.first).toBe(`ok installed ../../${INSTALLED}`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(SKILL);
        expect(existsSync(join(sub, ".claude"))).toBe(false);
    });

    test("--user installs under HOME and leaves the project alone", async () => {
        const result = await runSetup({ user: true });
        expect(result.first).toBe(`ok installed ~/${INSTALLED}`);
        expect(readFileSync(join(home, INSTALLED), "utf8")).toBe(SKILL);
        expect(existsSync(join(dir, ".claude"))).toBe(false);
    });

    test("--user without HOME is a short error", async () => {
        const result = await runSetup({ user: true }, dir, {});
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("err bad-args; HOME is not set\n");
    });

    test("never touches an existing AGENTS.md", async () => {
        writeFileSync(join(dir, "AGENTS.md"), "# Mine\n");
        await runSetup();
        await runSetup({ force: true });
        await interactive(["p", "y", "y"]);
        expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# Mine\n");
    });
});

describe("margin setup at a terminal", () => {
    test("asks where to install and whether to print the snippet; Enter takes the defaults", async () => {
        const result = await interactive(["", ""]);
        expect(result.code).toBe(0);
        expect(result.asked).toHaveLength(2);
        expect(result.asked[0]).toContain(`this project (${INSTALLED})`);
        expect(result.stdout).toBe(`ok installed ${INSTALLED}\n`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(SKILL);
    });

    test("u installs for all projects, y prints the snippet", async () => {
        const result = await interactive(["U", "yes"]);
        expect(result.first).toBe(`ok installed ~/${INSTALLED}`);
        expect(result.stdout.endsWith(SNIPPET)).toBe(true);
        expect(readFileSync(join(home, INSTALLED), "utf8")).toBe(SKILL);
        expect(existsSync(join(dir, ".claude"))).toBe(false);
    });

    test("n installs nothing and still offers the snippet", async () => {
        const result = await interactive(["n", "n"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("ok skipped\n");
        expect(result.asked).toHaveLength(2);
        expect(existsSync(join(dir, ".claude"))).toBe(false);
        expect(existsSync(join(home, ".claude"))).toBe(false);
    });

    test("an answer that is none of the choices is asked again", async () => {
        const result = await interactive(["what?", "u", ""]);
        expect(result.asked).toHaveLength(3);
        expect(result.asked[1]).toBe(result.asked[0]);
        expect(result.first).toBe(`ok installed ~/${INSTALLED}`);
    });

    test("a skill that differs is kept unless the answer is yes", async () => {
        await runSetup();
        writeFileSync(join(dir, INSTALLED), "my own edits\n");

        const kept = await interactive(["p", "", ""]);
        expect(kept.code).toBe(0);
        expect(kept.asked[1]).toContain(`${INSTALLED} differs from this version`);
        expect(kept.stdout).toBe(`ok kept ${INSTALLED}\n`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe("my own edits\n");

        const replaced = await interactive(["p", "y", ""]);
        expect(replaced.stdout).toBe(`ok replaced ${INSTALLED}\n`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(SKILL);
    });

    test("a flag answers its own question", async () => {
        await runSetup({ user: true });
        writeFileSync(join(home, INSTALLED), "my own edits\n");
        const result = await interactive([""], { user: true, force: true });
        expect(result.asked).toHaveLength(1);
        expect(result.asked[0]).toContain("AGENTS.md");
        expect(result.stdout).toBe(`ok replaced ~/${INSTALLED}\n`);
    });
});

const VERSION = packageVersion();
/** The package's skill without its stamp. */
const CONTENT = SKILL.slice(0, SKILL.lastIndexOf("\n<!-- margin-skill "));
const OLDER = stampSkill("An older skill.\n", "0.0.1");

describe("the stamp and what it tells apart", () => {
    test("the package's skill ends with its version and a hash of the rest", () => {
        expect(SKILL).toBe(stampSkill(CONTENT, VERSION));
        expect(SKILL).toMatch(/```\n\n<!-- margin-skill \S+ [0-9a-f]{12} -->\n$/);
        expect(classifySkill(SKILL, SKILL, VERSION)).toEqual({ kind: "current", version: VERSION });
    });

    test("the same content under an older version's stamp is current: only content counts", () => {
        const sameSkill = stampSkill(CONTENT, "0.0.1");
        expect(sameSkill).not.toBe(SKILL);
        const state = classifySkill(sameSkill, SKILL, VERSION);
        expect(state).toEqual({ kind: "current", version: "0.0.1" });
        expect(isStale(state, VERSION)).toBe(false);
        // A release that bumps the version and leaves the skill alone.
        const bumped = classifySkill(SKILL, stampSkill(CONTENT, "99.0.0"), "99.0.0");
        expect(bumped.kind).toBe("current");
        expect(isStale(bumped, "99.0.0")).toBe(false);
    });

    test("an untouched copy of another version is older or newer by its stamp", () => {
        expect(classifySkill(OLDER, SKILL, VERSION)).toEqual({ kind: "older", version: "0.0.1" });
        const newer = stampSkill("A newer skill.\n", "99.0.0");
        const state = classifySkill(newer, SKILL, VERSION);
        expect(state).toEqual({ kind: "newer", version: "99.0.0" });
        expect(isStale(state, VERSION)).toBe(false);
        // The same version with other content is a build of this version: replaced, never kept.
        expect(classifySkill(stampSkill("x\n", VERSION), SKILL, VERSION).kind).toBe("older");
    });

    test("line ends rewritten by a checkout are not an edit", () => {
        const crlf = OLDER.replaceAll("\n", "\r\n");
        expect(classifySkill(crlf, SKILL, VERSION).kind).toBe("older");
        expect(classifySkill(SKILL.replaceAll("\n", "\r\n"), SKILL, VERSION).kind).toBe("current");
    });

    test("a stamped copy whose text changed is edited, stale only when it started older", () => {
        const edited = OLDER.replace("An older", "My own");
        const state = classifySkill(edited, SKILL, VERSION);
        expect(state).toEqual({ kind: "edited", version: "0.0.1" });
        expect(isStale(state, VERSION)).toBe(true);
        // Text added below the stamp is an edit of this version, not an unstamped copy.
        expect(classifySkill(`${SKILL}my own rule\n`, SKILL, VERSION)).toEqual({
            kind: "edited",
            version: VERSION,
        });
        const editedCurrent = classifySkill(SKILL.replace("margin", "MARGIN"), SKILL, VERSION);
        expect(editedCurrent).toEqual({ kind: "edited", version: VERSION });
        expect(isStale(editedCurrent, VERSION)).toBe(false);
    });

    test("an unstamped copy is edited unless it is a released skill, byte for byte", () => {
        const state = classifySkill("my own skill\n", SKILL, VERSION);
        expect(state).toEqual({ kind: "edited" });
        expect(isStale(state, VERSION)).toBe(true);

        const shipped = "A skill some release shipped.\n";
        const released = {
            [createHash("sha256").update(shipped).digest("hex").slice(0, 16)]: "0.0.2",
        };
        expect(classifySkill(shipped, SKILL, VERSION, released)).toEqual({
            kind: "older",
            version: "0.0.2",
        });
        expect(classifySkill(shipped.replaceAll("\n", "\r\n"), SKILL, VERSION, released).kind).toBe(
            "older",
        );
        expect(classifySkill(`${shipped}mine\n`, SKILL, VERSION, released).kind).toBe("edited");
        expect(classifySkill(shipped, SKILL, VERSION).kind).toBe("edited");
    });

    test("versions compare by number, a prerelease before its release", () => {
        expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
        expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
        expect(compareVersions("0.3", "0.3.1")).toBe(-1);
        expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
        expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
        expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
        expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.1")).toBe(0);
    });
});

describe("margin setup and copies of other versions", () => {
    test("an untouched older copy is replaced with no question and no --force", async () => {
        mkdirSync(join(dir, ".claude/skills/margin"), { recursive: true });
        writeFileSync(join(dir, INSTALLED), OLDER);
        const piped = await runSetup();
        expect(piped.code).toBe(0);
        expect(piped.first).toBe(`ok replaced ${INSTALLED}`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(SKILL);

        writeFileSync(join(dir, INSTALLED), OLDER);
        const typed = await interactive(["p", ""]);
        expect(typed.asked).toHaveLength(2);
        expect(typed.stdout).toBe(`ok replaced ${INSTALLED}\n`);
    });

    test("the same content under an older stamp is unchanged and not rewritten", async () => {
        mkdirSync(join(dir, ".claude/skills/margin"), { recursive: true });
        const sameSkill = stampSkill(CONTENT, "0.0.1");
        writeFileSync(join(dir, INSTALLED), sameSkill);
        expect((await runSetup()).first).toBe(`ok unchanged ${INSTALLED}`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(sameSkill);
    });

    test("a copy from a newer margin is kept unless forced or the answer is yes", async () => {
        mkdirSync(join(dir, ".claude/skills/margin"), { recursive: true });
        const newer = stampSkill("A newer skill.\n", "99.0.0");
        writeFileSync(join(dir, INSTALLED), newer);
        const piped = await runSetup();
        expect(piped.code).toBe(0);
        expect(piped.stdout).toStartWith(
            `ok kept ${INSTALLED}\nfrom a newer margin (99.0.0); --force overwrites\n`,
        );
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(newer);

        const typed = await interactive(["p", "", ""]);
        expect(typed.asked[1]).toContain("is from a newer margin (99.0.0)");
        expect(typed.stdout).toBe(`ok kept ${INSTALLED}\n`);
        expect((await runSetup({ force: true })).first).toBe(`ok replaced ${INSTALLED}`);
    });
});

describe("the record of installed copies", () => {
    test("setup records each place it installs to, newest first, 0600", async () => {
        await runSetup();
        await runSetup({ user: true });
        const env = sandboxEnv();
        expect(readInstalls(env).copies).toEqual([join(home, INSTALLED), join(dir, INSTALLED)]);
        await runSetup();
        expect(readInstalls(env).copies).toEqual([join(dir, INSTALLED), join(home, INSTALLED)]);
        expect(statSync(join(dir, "state/skill-installs.json")).mode & 0o777).toBe(0o600);
    });

    test("keeping an edited copy at the terminal is noted for this version", async () => {
        await runSetup();
        writeFileSync(join(dir, INSTALLED), "my own edits\n");
        await interactive(["p", "", ""]);
        expect(readInstalls(sandboxEnv()).kept).toEqual({ [join(dir, INSTALLED)]: VERSION });
        await runSetup({ force: true });
        expect(readInstalls(sandboxEnv()).kept).toEqual({});
    });

    test("a copy that is gone leaves the record, with what was noted about it", async () => {
        const env = sandboxEnv();
        await runSetup();
        await runSetup({ user: true });
        await changeInstalls({ cwd: dir, env }, (installs) => {
            installs.told[join(dir, INSTALLED)] = { version: VERSION, at: 1 };
            installs.kept[join(dir, INSTALLED)] = VERSION;
        });
        rmSync(join(dir, ".claude"), { recursive: true });
        const installs = await changeInstalls({ cwd: dir, env }, () => {});
        expect(installs).toEqual({ copies: [join(home, INSTALLED)], told: {}, kept: {} });
        expect(readInstalls(env)).toEqual(installs);
    });

    test("the record keeps the newest copies up to its cap", async () => {
        const env = sandboxEnv();
        const paths = Array.from({ length: SKILL_INSTALLS_MAX + 3 }, (_, index) => {
            const path = join(dir, `p${index}`, INSTALLED);
            mkdirSync(join(path, ".."), { recursive: true });
            writeFileSync(path, SKILL);
            return path;
        });
        const installs = await changeInstalls({ cwd: dir, env }, (record) => {
            for (const path of paths) noteInstall(record, path);
        });
        expect(installs.copies).toHaveLength(SKILL_INSTALLS_MAX);
        expect(installs.copies[0]).toBe(paths.at(-1)!);
    });

    test("a torn or foreign record reads as empty", () => {
        const env = sandboxEnv();
        mkdirSync(join(dir, "state"));
        const empty = { copies: [], told: {}, kept: {} };
        expect(readInstalls(env)).toEqual(empty);
        writeFileSync(join(dir, "state/skill-installs.json"), "{");
        expect(readInstalls(env)).toEqual(empty);
        writeFileSync(join(dir, "state/skill-installs.json"), "[1]");
        expect(readInstalls(env)).toEqual(empty);
        writeFileSync(
            join(dir, "state/skill-installs.json"),
            JSON.stringify({
                copies: ["/a", 2],
                told: { "/a": { version: 1 } },
                kept: { "/a": 3 },
            }),
        );
        expect(readInstalls(env)).toEqual({ copies: ["/a"], told: {}, kept: {} });
    });

    test("a record that cannot be written does not fail the install", async () => {
        writeFileSync(join(dir, "state"), "not a directory");
        const result = await runSetup();
        expect(result.code).toBe(0);
        expect(result.first).toBe(`ok installed ${INSTALLED}`);
    });

    test("a .claude linked into another directory stays on record for its own user only", async () => {
        mkdirSync(join(dir, "dotfiles/claude"), { recursive: true });
        symlinkSync(join(dir, "dotfiles/claude"), join(home, ".claude"));
        await runSetup({ user: true });
        const real = join(dir, "dotfiles/claude/skills/margin/SKILL.md");
        expect(readInstalls(sandboxEnv()).copies).toEqual([real]);
        // Read back from the record alone, the path is not named like a skill copy: dropped.
        const stranger = { cwd: dir, env: { ...sandboxEnv(), HOME: join(dir, "elsewhere") } };
        expect((await changeInstalls(stranger, () => {})).copies).toEqual([]);
        expect(readFileSync(real, "utf8")).toBe(SKILL);
    });

    test("a copy reached through a symlink has one name", async () => {
        await runSetup({ user: true });
        const link = join(dir, "link-home");
        symlinkSync(home, link);
        const targets = skillTargets({ cwd: dir, env: { HOME: link } });
        expect(targets.user).toBe(join(home, INSTALLED));
        expect(skillTargets({ cwd: dir, env: {} }).user).toBeUndefined();
    });
});
