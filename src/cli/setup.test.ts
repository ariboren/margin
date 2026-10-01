import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "./main.ts";
import { setup, skillSource, snippetSource, type SetupOptions } from "./setup.ts";

const SKILL = readFileSync(skillSource, "utf8");
const SNIPPET = readFileSync(snippetSource, "utf8");
const INSTALLED = ".claude/skills/margin/SKILL.md";

let dir: string;
let home: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "margin-setup-"));
    home = join(dir, "home");
    mkdirSync(home);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

async function runSetup(
    options: SetupOptions = {},
    cwd = dir,
    env: Io["env"] = { HOME: home },
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
    runSetup(options, dir, { HOME: home }, answers);

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
