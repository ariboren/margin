import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createAnchor } from "../core/anchor.ts";
import { readLog } from "../core/log.ts";
import { createThread } from "../core/threads.ts";
import { connectedAgents } from "../server/presence.ts";
import {
    agentHelp,
    lineAsker,
    run,
    stripFinalNewline,
    type Io,
    type ServerCommands,
} from "./main.ts";
import { DOC, sandbox, type Sandbox } from "./testing.ts";

const MAIN = join(import.meta.dir, "main.ts");

let box: Sandbox;

beforeEach(() => {
    box = sandbox();
});

afterEach(() => {
    box.cleanup();
});

/** The real bin in a child process, cwd in the sandbox, no daemon anywhere. */
function margin(
    args: string[],
    options: { stdin?: string; env?: Record<string, string>; cwd?: string } = {},
) {
    const result = Bun.spawnSync(["bun", MAIN, ...args], {
        cwd: options.cwd ?? box.dir,
        env: { ...process.env, ...box.env, ...options.env },
        stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    });
    return { code: result.exitCode, stdout: result.stdout.toString() };
}

describe("every contract command against a temp dir with no daemon", () => {
    test("watch, pending, show, reply, suggest, resolve and agent-help", async () => {
        await box.comment("cold path", "Why rarely?");
        expect(margin(["watch", "doc.md", "--once"])).toEqual({
            code: 0,
            stdout: 'new c1 "Findings"\n',
        });
        expect(margin(["pending", "doc.md"]).stdout).toStartWith("c1 open L5 Findings\n");
        expect(JSON.parse(margin(["pending", "doc.md", "--json"]).stdout)).toMatchObject({
            threads: [{ id: "c1", state: "working" }],
            edits: [],
        });
        expect(margin(["show", "c1"]).stdout).toContain("\nunit:\nThe cache is warm");
        expect(margin(["reply", "c1", "Checking"]).stdout).toBe("ok c1 replied\n");
        expect(margin(["suggest", "c1", "--replace", "slow path", "-m", "Renamed"]).stdout).toBe(
            "ok c1 replied\n",
        );
        expect(margin(["suggest", "c1", "--replace", "slow path", "--apply"]).stdout).toBe(
            "ok c1 replied\n",
        );
        expect(box.text()).toBe(DOC.replace("cold path", "slow path"));
        expect(margin(["suggest", "--find", "first tile", "--replace", "first image"]).stdout).toBe(
            "ok c2 replied\n",
        );
        expect(margin(["resolve", "c2"]).stdout).toBe("ok c2 resolved\n");
        expect(margin(["reply", "c1", "Done", "--resolve"]).stdout).toBe("ok c1 resolved\n");
        expect(margin(["agent-help"]).stdout).toBe(agentHelp());
        expect(margin(["pending", "doc.md"]).stdout).toBe("none\n");
    });

    test("pending --wait blocks until a comment lands", async () => {
        const child = Bun.spawn(["bun", MAIN, "pending", "doc.md", "--wait"], {
            cwd: box.dir,
            env: { ...process.env, ...box.env },
            stdout: "pipe",
        });
        await Bun.sleep(500);
        await box.comment("cold path", "Why?");
        expect(await child.exited).toBe(0);
        expect(await new Response(child.stdout).text()).toStartWith("c1 open L5 Findings\n");
    });

    test("--replace - round-trips backticks, $ and backslashes from stdin", async () => {
        await box.comment("cold path", "Rename");
        margin(["pending", "doc.md"]);
        const replacement = "`$HOME` and ${x} and $(pwd) and \\n and 'q' \"dq\"";
        expect(
            margin(["suggest", "c1", "--replace", "-", "--apply"], { stdin: `${replacement}\n` })
                .stdout,
        ).toBe("ok c1 replied\n");
        expect(readFileSync(box.doc, "utf8")).toBe(DOC.replace("cold path", replacement));
    });

    test("reply - takes markdown with backticks and $ from stdin", async () => {
        await box.comment("cold path", "Why?");
        margin(["pending", "doc.md"]);
        const text = "- use `$HOME`\n- not $(pwd) or 'q' \"dq\"";
        expect(margin(["reply", "c1", "-"], { stdin: `${text}\n` }).stdout).toBe("ok c1 replied\n");
        expect((await box.state()).threads.get("c1")!.messages.at(-1)).toMatchObject({
            by: "agent",
            text,
        });
    });

    test("a doc path works before the id", async () => {
        await box.comment("cold path", "Why?");
        expect(margin(["reply", "doc.md", "c1", "Hi"]).stdout).toBe("ok c1 replied\n");
    });

    test("--as, then MARGIN_AGENT, name the agent on what it writes and on its presence", async () => {
        await box.comment("cold path", "Why?");
        margin(["reply", "doc.md", "c1", "Hi", "--as", "foreman"], {
            env: { MARGIN_AGENT: "reviewer" },
        });
        margin(["resolve", "doc.md", "c1"], { env: { MARGIN_AGENT: "reviewer", CLAUDECODE: "1" } });
        // Run under Claude Code, the suite inherits a real session whose title would be the name.
        margin(["pending", "doc.md"], {
            env: { MARGIN_AGENT: "", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "" },
        });
        const events = (await readLog(box.doc)).events;
        expect(events.filter((event) => event.by === "agent").map((event) => event.agent)).toEqual([
            expect.objectContaining({ name: "foreman" }),
            { name: "reviewer", client: "claude-code" },
            { name: "Claude Code", client: "claude-code" },
        ]);
        const watcher = Bun.spawn(["bun", MAIN, "watch", "doc.md", "--as", "foreman"], {
            cwd: box.dir,
            env: { ...process.env, ...box.env, CLAUDECODE: "1" },
            stdout: "ignore",
            stderr: "ignore",
        });
        try {
            const deadline = Date.now() + 20_000;
            while (connectedAgents(box.doc).length === 0 && Date.now() < deadline) {
                await Bun.sleep(20);
            }
            expect(connectedAgents(box.doc)).toEqual([{ name: "foreman", client: "claude-code" }]);
        } finally {
            watcher.kill("SIGTERM");
            await watcher.exited;
        }
    }, 30_000);

    test("MARGIN_DOC picks the doc", async () => {
        await box.comment("cold path", "Why?");
        expect(margin(["reply", "c1", "Hi"], { env: { MARGIN_DOC: box.doc } }).stdout).toBe(
            "ok c1 replied\n",
        );
    });

    test("an id held by several recent docs asks for the doc", async () => {
        mkdirSync(join(box.dir, "b"));
        const second = join(box.dir, "b", "doc.md");
        copyFileSync(box.doc, second);
        await box.comment("cold path", "A");
        margin(["pending", "doc.md"]);
        margin(["pending", "b/doc.md"]);
        expect(margin(["reply", "c1", "Hi"]).stdout).toBe("ok c1 replied\n");

        await createThread(second, (id) => [
            {
                type: "comment",
                by: "user",
                id,
                anchor: createAnchor(DOC, { start: 0, end: 7 }),
                text: "B",
                draft: false,
            },
        ]);
        expect(margin(["reply", "c1", "Hi"])).toEqual({
            code: 1,
            stdout: "err c1 not-unique; pass the doc: b/doc.md doc.md\n",
        });
        expect(margin(["reply", "c7", "Hi"])).toEqual({
            code: 1,
            stdout: "err c7 not-found; pass the doc: b/doc.md doc.md\n",
        });
    });

    test("an id finds its doc from another directory; a write only while unresolved", async () => {
        const elsewhere = join(box.dir, "elsewhere");
        mkdirSync(elsewhere);
        await box.comment("cold path", "Why?");
        margin(["pending", "doc.md"]);
        const doc = realpathSync(box.doc);

        expect(margin(["show", "c1"], { cwd: elsewhere }).stdout).toStartWith("c1 working ");
        expect(margin(["reply", "c1", "Hi", "--resolve"], { cwd: elsewhere })).toEqual({
            code: 0,
            stdout: "ok c1 resolved\n",
        });
        expect(margin(["show", "c1"], { cwd: elsewhere }).stdout).toStartWith("c1 resolved ");
        expect(margin(["reply", "c1", "Again"], { cwd: elsewhere })).toEqual({
            code: 1,
            stdout: `err c1 not-found; pass the doc: ${doc}\n`,
        });
        expect(margin(["show", "c7"], { cwd: elsewhere })).toEqual({
            code: 1,
            stdout: `err c7 not-found; pass the doc: ${doc}\n`,
        });
    });

    test("a write never crosses from a resolved thread here to an open one elsewhere", async () => {
        const inner = join(box.dir, "inner");
        mkdirSync(inner);
        const local = join(inner, "doc.md");
        copyFileSync(box.doc, local);
        await createThread(local, (id) => [
            { type: "comment", by: "user", id, text: "Local", draft: false },
        ]);
        margin(["pending", "inner/doc.md"]);
        expect(margin(["resolve", "inner/doc.md", "c1"]).stdout).toBe("ok c1 resolved\n");
        await box.note("Outside");
        margin(["pending", "doc.md"]);

        const refused = {
            code: 1,
            stdout: `err c1 not-unique; pass the doc: doc.md ${realpathSync(box.doc)}\n`,
        };
        expect(margin(["resolve", "c1"], { cwd: inner })).toEqual(refused);
        expect(margin(["reply", "c1", "Hi"], { cwd: inner })).toEqual(refused);
        const outside = (await box.state()).threads.get("c1")!;
        expect(outside.state).toBe("working");
        expect(outside.messages).toHaveLength(1);

        expect(margin(["resolve", "doc.md", "c1"]).stdout).toBe("ok c1 resolved\n");
        expect(margin(["reply", "c1", "Hi"], { cwd: inner })).toEqual({
            code: 1,
            stdout: "err c1 resolved\n",
        });
    });

    test("with no recent docs the error says to pass the doc", () => {
        expect(margin(["show", "c1"])).toEqual({
            code: 1,
            stdout: "err c1 not-found; pass the doc\n",
        });
    });

    for (const args of [["watch", "--once"], ["pending", "--wait"], ["pending"]]) {
        test(`${args.join(" ")} on a missing doc fails fast and creates nothing`, () => {
            mkdirSync(join(box.dir, "empty"));
            for (const doc of ["empty/nope.md", "empty"]) {
                const result = Bun.spawnSync(["bun", MAIN, args[0]!, doc, ...args.slice(1)], {
                    cwd: box.dir,
                    env: { ...process.env, ...box.env },
                    stdin: "ignore",
                    timeout: 5_000,
                });
                expect({ code: result.exitCode, stdout: result.stdout.toString() }).toEqual({
                    code: 1,
                    stdout: `err ${doc} not-found\n`,
                });
            }
            expect(existsSync(join(box.dir, "empty", ".margin"))).toBe(false);
        });
    }

    for (const args of [
        ["reply", "c1", "Hi"],
        ["resolve", "c1"],
        ["suggest", "c1", "--replace", "x"],
    ]) {
        test(`${args[0]} on a mistyped doc names the doc and creates nothing`, async () => {
            await box.comment("cold path", "Why?");
            mkdirSync(join(box.dir, "empty"));
            const result = margin([args[0]!, "empty/nope.md", ...args.slice(1)]);
            expect(result).toEqual({ code: 1, stdout: "err empty/nope.md not-found\n" });
            expect(existsSync(join(box.dir, "empty", ".margin"))).toBe(false);
        });
    }

    test("MARGIN_DOC naming no file is the same error", () => {
        expect(margin(["show", "c1"], { env: { MARGIN_DOC: "gone.md" } })).toEqual({
            code: 1,
            stdout: "err gone.md not-found\n",
        });
    });

    test("bad arguments are a short error", () => {
        expect(margin(["reply"]).stdout).toBe("err bad-args; thread id missing\n");
        expect(margin(["suggest", "c1"]).code).toBe(1);
        expect(margin(["reply", "c1", "--nope"]).stdout).toStartWith("err bad-args;");
    });

    test("--version and -v print the package version", async () => {
        const manifest: unknown = await Bun.file(
            join(import.meta.dir, "../../package.json"),
        ).json();
        const expected = `${(manifest as { version: string }).version}\n`;
        expect(margin(["--version"])).toEqual({ code: 0, stdout: expected });
        expect(margin(["-v"])).toEqual({ code: 0, stdout: expected });
    });

    test("setup --user --force installs the skill under HOME", () => {
        const home = join(box.dir, "home");
        const result = margin(["setup", "--user", "--force"], { env: { HOME: home } });
        expect(result.code).toBe(0);
        expect(result.stdout).toStartWith("ok installed ~/.claude/skills/margin/SKILL.md\n");
        expect(existsSync(join(home, ".claude/skills/margin/SKILL.md"))).toBe(true);
    });
});

function io(isTTY = false): Io & { out: () => string } {
    let stdout = "";
    return {
        cwd: box.dir,
        env: box.env,
        isTTY,
        write: (text) => {
            stdout += text;
        },
        stdin: async () => "",
        out: () => stdout,
    };
}

describe("margin <doc>", () => {
    const server: ServerCommands = {
        async open(_path, target) {
            target.write("http://127.0.0.1:1/d/x/doc.md?t=token\n");
            return 0;
        },
        stop: async () => 0,
        status: async () => 0,
    };

    test("prints agent-help after the URL when stdout is not a TTY", async () => {
        const target = io(false);
        expect(await run(["doc.md"], target, server)).toBe(0);
        expect(target.out()).toBe(`http://127.0.0.1:1/d/x/doc.md?t=token\n${agentHelp()}`);
    });

    test("prints only the URL on a terminal", async () => {
        const target = io(true);
        await run(["doc.md"], target, server);
        expect(target.out()).toBe("http://127.0.0.1:1/d/x/doc.md?t=token\n");
    });
});

test("agent-help stays within its ceiling in budget.json", () => {
    const { agentHelp: ceiling } = JSON.parse(
        readFileSync(join(import.meta.dir, "../../budget.json"), "utf8"),
    ) as { agentHelp: number };
    expect(new TextEncoder().encode(agentHelp()).length).toBeLessThanOrEqual(ceiling);
});

test("one trailing newline is stripped from stdin, no more", () => {
    expect(stripFinalNewline("a\n")).toBe("a");
    expect(stripFinalNewline("a\r\n")).toBe("a");
    expect(stripFinalNewline("a\n\n")).toBe("a\n");
    expect(stripFinalNewline("a")).toBe("a");
});

describe("lineAsker", () => {
    test("prints the question and answers with the typed line", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        const ask = lineAsker(input, output);
        const answer = ask("Overwrite it? [y/N] ");
        input.write("y\n");
        expect(await answer).toBe("y");
        expect(output.read()?.toString()).toContain("Overwrite it? [y/N] ");
    });

    test("input that ends unanswered is an empty answer, so the default applies", async () => {
        const input = new PassThrough();
        const ask = lineAsker(input, new PassThrough());
        const answer = ask("Overwrite it? [y/N] ");
        input.end();
        expect(await answer).toBe("");
    });
});
