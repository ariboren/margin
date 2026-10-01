import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { routes, TOKEN_PARAM, type WireSnapshot } from "../server/protocol.ts";
import { agentHelp, type Io } from "./main.ts";
import { openingAgent, serverCommands } from "./open.ts";
import { recentDocs } from "./registry.ts";
import { sandbox, type Sandbox } from "./testing.ts";

const MAIN = join(import.meta.dir, "main.ts");

let box: Sandbox;

beforeEach(() => {
    box = sandbox();
});

afterEach(() => {
    margin(["stop"]);
    box.cleanup();
});

/** No client marker and no name: the tests may themselves run under an agent. */
const NOBODY = {
    CLAUDECODE: undefined,
    CODEX_THREAD_ID: undefined,
    CODEX_CI: undefined,
    CODEX_SANDBOX: undefined,
    CURSOR_AGENT: undefined,
    MARGIN_AGENT: undefined,
};

function margin(args: string[]) {
    const result = Bun.spawnSync(["bun", MAIN, ...args], {
        cwd: box.dir,
        env: { ...process.env, ...box.env, MARGIN_NO_OPEN: "1" },
    });
    return { code: result.exitCode, stdout: result.stdout.toString() };
}

test("margin <doc> starts a daemon, prints the URL, then agent-help when piped", () => {
    const opened = margin(["doc.md"]);
    expect(opened.code).toBe(0);
    const [url, ...rest] = opened.stdout.split("\n");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\S+$/);
    expect(rest.join("\n")).toBe(agentHelp());
    expect(recentDocs(box.env)).toHaveLength(1);

    const status = margin(["status"]).stdout;
    expect(status).toMatch(/^pid \d+ port \d+\n/);
    expect(status).toContain("doc.md tabs=0");

    expect(margin(["stop"]).stdout).toBe("stopped\n");
    expect(margin(["status"]).stdout).toBe("not running\n");
});

describe("openingAgent", () => {
    test("a person at a terminal is nobody, whatever the environment says", () => {
        expect(openingAgent({ isTTY: true, env: { CLAUDECODE: "1" } })).toBeUndefined();
        expect(openingAgent({ isTTY: true, env: { MARGIN_AGENT: "foreman" } })).toBeUndefined();
    });

    test("a pipe or script that nothing names is nobody", () => {
        expect(openingAgent({ isTTY: false, env: {} })).toBeUndefined();
    });

    test("a detected client or a given name is the agent", () => {
        expect(openingAgent({ isTTY: false, env: { CODEX_CI: "1" } })).toEqual({
            name: "Codex",
            client: "codex",
        });
        expect(openingAgent({ isTTY: false, env: { MARGIN_AGENT: "foreman" } })).toEqual({
            name: "foreman",
            client: "unknown",
        });
    });
});

async function snapshotBehind(url: string): Promise<WireSnapshot> {
    const html = await (await fetch(url)).text();
    const docId = /"docId":"([0-9a-f]+)"/.exec(html)![1]!;
    const page = new URL(url);
    const token = page.searchParams.get(TOKEN_PARAM);
    return (await (
        await fetch(`${page.origin}${routes.snapshot(docId)}?${TOKEN_PARAM}=${token}`)
    ).json()) as WireSnapshot;
}

/** The commands run in this process, as `margin` would call them. */
async function command(
    run: (io: Io) => Promise<number>,
    options: { isTTY: boolean; env?: Record<string, string | undefined> },
) {
    let stdout = "";
    const code = await run({
        cwd: box.dir,
        env: { ...process.env, ...NOBODY, ...box.env, MARGIN_NO_OPEN: "1", ...options.env },
        isTTY: options.isTTY,
        write: (text) => {
            stdout += text;
        },
        stdin: async () => "",
    });
    return { code, stdout };
}

test("an agent's open tells the page who to expect; a person's and an unnamed pipe's do not", async () => {
    const open = (io: Io) => serverCommands.open(box.doc, io);
    const bare = await command(open, { isTTY: false });
    expect(bare.code).toBe(0);
    const url = bare.stdout.trim();
    expect("expected" in (await snapshotBehind(url))).toBe(false);

    const person = await command(open, { isTTY: true, env: { MARGIN_AGENT: "foreman" } });
    expect(person.stdout).toBe(bare.stdout);
    expect("expected" in (await snapshotBehind(url))).toBe(false);

    const agent = await command(open, { isTTY: false, env: { MARGIN_AGENT: "foreman" } });
    expect(agent.stdout).toBe(bare.stdout);
    expect((await snapshotBehind(url)).expected).toEqual({ name: "foreman", client: "unknown" });

    const status = await command((io) => serverCommands.status(io), { isTTY: false });
    expect(status.stdout).toMatch(/^pid \d+ port \d+\n.*doc\.md tabs=0\n$/);
    expect(await command((io) => serverCommands.stop(io), { isTTY: false })).toEqual({
        code: 0,
        stdout: "stopped\n",
    });
    expect((await command((io) => serverCommands.status(io), { isTTY: false })).stdout).toBe(
        "not running\n",
    );
    expect(await command((io) => serverCommands.open("missing.md", io), { isTTY: false })).toEqual({
        code: 1,
        stdout: "err not-found; no such file: missing.md\n",
    });
});

test("a missing doc is a short error", () => {
    expect(margin(["missing.md"])).toEqual({
        code: 1,
        stdout: "err not-found; no such file: missing.md\n",
    });
});
