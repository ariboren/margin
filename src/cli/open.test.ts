import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { agentHelp } from "./main.ts";
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

test("a missing doc is a short error", () => {
    expect(margin(["missing.md"])).toEqual({
        code: 1,
        stdout: "err not-found; no such file: missing.md\n",
    });
});
