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

function runSetup(options: SetupOptions = {}, cwd = dir, env: Io["env"] = { HOME: home }) {
    let stdout = "";
    const io: Io = {
        cwd,
        env,
        isTTY: false,
        write: (text) => {
            stdout += text;
        },
        stdin: async () => "",
    };
    const code = setup(io, options);
    return { code, stdout, first: stdout.split("\n")[0] };
}

describe("margin setup", () => {
    test("installs the package's skill in the project and prints the snippet", () => {
        const result = runSetup();
        expect(result.code).toBe(0);
        expect(result.first).toBe(`ok installed ${INSTALLED}`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(SKILL);
        expect(result.stdout.endsWith(SNIPPET)).toBe(true);
        expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    });

    test("a second run with the same skill writes nothing", () => {
        runSetup();
        const before = statSync(join(dir, INSTALLED)).mtimeMs;
        const result = runSetup();
        expect(result.code).toBe(0);
        expect(result.first).toBe(`ok unchanged ${INSTALLED}`);
        expect(statSync(join(dir, INSTALLED)).mtimeMs).toBe(before);
    });

    test("refuses a changed skill without --force, replaces it with", () => {
        runSetup();
        writeFileSync(join(dir, INSTALLED), "my own edits\n");
        const refused = runSetup();
        expect(refused.code).toBe(1);
        expect(refused.stdout).toBe(
            `err changed; ${INSTALLED} differs from this version, --force overwrites\n`,
        );
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe("my own edits\n");

        const forced = runSetup({ force: true });
        expect(forced.code).toBe(0);
        expect(forced.first).toBe(`ok replaced ${INSTALLED}`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(SKILL);
    });

    test("installs at the git root when run from a subdirectory", () => {
        mkdirSync(join(dir, ".git"));
        const sub = join(dir, "docs", "notes");
        mkdirSync(sub, { recursive: true });
        const result = runSetup({}, sub);
        expect(result.first).toBe(`ok installed ../../${INSTALLED}`);
        expect(readFileSync(join(dir, INSTALLED), "utf8")).toBe(SKILL);
        expect(existsSync(join(sub, ".claude"))).toBe(false);
    });

    test("--user installs under HOME and leaves the project alone", () => {
        const result = runSetup({ user: true });
        expect(result.first).toBe(`ok installed ~/${INSTALLED}`);
        expect(readFileSync(join(home, INSTALLED), "utf8")).toBe(SKILL);
        expect(existsSync(join(dir, ".claude"))).toBe(false);
    });

    test("--user without HOME is a short error", () => {
        const result = runSetup({ user: true }, dir, {});
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("err bad-args; HOME is not set\n");
    });

    test("never touches an existing AGENTS.md", () => {
        writeFileSync(join(dir, "AGENTS.md"), "# Mine\n");
        runSetup();
        runSetup({ force: true });
        expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# Mine\n");
    });
});
