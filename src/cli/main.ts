#!/usr/bin/env bun
// The `margin` bin. `run` is the whole CLI over an injectable Io, so tests and the budget check
// measure the same stdout the agent reads. Every command but `<doc>`, `stop` and `status` works
// with no daemon, straight on the core modules.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { LockTimeoutError } from "../core/lock.ts";
import type { Ack, ThreadId } from "../core/model.ts";
import type { Env } from "../server/open-tab.ts";
import { reply, resolveThread, show, suggest } from "./commands.ts";
import { isThreadId, resolveDoc, type DocTarget } from "./doc.ts";
import { formatAck, formatShow } from "./format.ts";
import { resolveAgent } from "./identity.ts";
import { pending, pendingWait } from "./pending.ts";
import { recordDoc } from "./registry.ts";
import { setup } from "./setup.ts";
import { watch } from "./watch.ts";

export interface Io {
    cwd: string;
    env: Env;
    /** stdout is a terminal: `margin <doc>` skips agent-help. */
    isTTY: boolean;
    write(text: string): void;
    stdin(): Promise<string>;
    /** One line typed in answer to `question`; set only when a person is at the terminal. */
    ask?(question: string): Promise<string>;
    /** Stops `watch` and `pending --wait`. */
    signal?: AbortSignal;
}

/** The commands that need the daemon. */
export interface ServerCommands {
    open(docPath: string, io: Io): Promise<number>;
    stop(io: Io): Promise<number>;
    status(io: Io): Promise<number>;
}

const options = {
    json: { type: "boolean" },
    wait: { type: "boolean" },
    once: { type: "boolean" },
    resolve: { type: "boolean" },
    apply: { type: "boolean" },
    replace: { type: "string" },
    find: { type: "string" },
    message: { type: "string", short: "m" },
    user: { type: "boolean" },
    force: { type: "boolean" },
    as: { type: "string" },
} as const;

export function agentHelp(): string {
    return readFileSync(join(import.meta.dir, "agent-help.md"), "utf8");
}

/** Heredocs end with a newline the replacement should not carry. */
export function stripFinalNewline(text: string): string {
    return text.replace(/\r?\n$/, "");
}

function ack(io: Io, value: Ack): number {
    io.write(`${formatAck(value)}\n`);
    return value.ok ? 0 : 1;
}

function docFailure(io: Io, target: Exclude<DocTarget, { ok: true }>): number {
    if ("ack" in target) return ack(io, target.ack);
    io.write(`err ${target.missing} not-found\n`);
    return 1;
}

function badArgs(io: Io, detail: string): number {
    return ack(io, { ok: false, error: "bad-args", detail });
}

function waitOptions(io: Io) {
    const debounce = Number(io.env.MARGIN_DEBOUNCE_MS);
    return {
        ...(io.env.MARGIN_DEBOUNCE_MS && Number.isFinite(debounce) ? { debounceMs: debounce } : {}),
        ...(io.signal ? { signal: io.signal } : {}),
    };
}

export async function run(argv: string[], io: Io, server?: ServerCommands): Promise<number> {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    } catch {
        return badArgs(io, "unknown option; text starting with - goes after --");
    }
    const { values, positionals } = parsed;
    const [command, ...rest] = positionals;
    const write = (text: string) => io.write(text);
    try {
        switch (command) {
            case undefined:
            case "agent-help":
                io.write(agentHelp());
                return 0;
            case "stop":
            case "status":
                if (!server) return badArgs(io, "no daemon support");
                return await server[command](io);
            case "setup":
                return await setup(io, { user: values.user, force: values.force });
            case "watch":
            case "pending": {
                const target = await resolveDoc({ explicit: rest[0], cwd: io.cwd, env: io.env });
                if (!target.ok) return docFailure(io, target);
                await recordDoc(target.path, io.env);
                const agent = resolveAgent({ as: values.as, env: io.env });
                if (command === "watch") {
                    await watch(target.path, write, {
                        ...waitOptions(io),
                        once: values.once,
                        agent,
                    });
                } else if (values.wait) {
                    await pendingWait(target.path, {
                        ...waitOptions(io),
                        json: values.json,
                        write,
                        agent,
                    });
                } else {
                    await pending(target.path, { json: values.json, write, agent });
                }
                return 0;
            }
            case "show":
            case "reply":
            case "resolve":
            case "suggest":
                return await threadCommand(command, rest, values, io);
            default: {
                if (!server) return badArgs(io, "no daemon support");
                const code = await server.open(command, io);
                if (code === 0 && !io.isTTY) io.write(agentHelp());
                return code;
            }
        }
    } catch (error) {
        if (error instanceof LockTimeoutError) return ack(io, { ok: false, error: "locked" });
        throw error;
    }
}

type Values = ReturnType<
    typeof parseArgs<{ options: typeof options; allowPositionals: true }>
>["values"];

async function threadCommand(
    command: "show" | "reply" | "resolve" | "suggest",
    args: string[],
    values: Values,
    io: Io,
): Promise<number> {
    const rest = [...args];
    const explicit = rest[0] !== undefined && !isThreadId(rest[0]) ? rest.shift() : undefined;
    const idArg = rest.shift();
    const id: ThreadId | undefined = idArg !== undefined && isThreadId(idArg) ? idArg : undefined;
    const creates = command === "suggest" && values.find !== undefined;
    if (!id && !creates) return badArgs(io, "thread id missing");
    if (id && creates) return badArgs(io, "--find starts a thread; drop the id");

    const target = await resolveDoc({ explicit, ...(id ? { id } : {}), cwd: io.cwd, env: io.env });
    if (!target.ok) return docFailure(io, target);
    const doc = target.path;
    const agent = resolveAgent({ as: values.as, env: io.env });

    switch (command) {
        case "show": {
            const result = await show(doc, id!);
            if ("ok" in result) return ack(io, result);
            io.write(`${values.json ? JSON.stringify(result) : formatShow(result)}\n`);
            return 0;
        }
        case "reply": {
            const text = rest[0] === "-" ? stripFinalNewline(await io.stdin()) : rest[0];
            if (!text) return badArgs(io, "reply text missing");
            return ack(io, await reply(doc, id!, text, { resolve: values.resolve, agent }));
        }
        case "resolve":
            return ack(io, await resolveThread(doc, id!, agent));
        case "suggest": {
            if (values.replace === undefined) return badArgs(io, "--replace missing");
            const replace =
                values.replace === "-" ? stripFinalNewline(await io.stdin()) : values.replace;
            return ack(
                io,
                await suggest(doc, {
                    ...(id ? { id } : { find: values.find }),
                    replace,
                    ...(values.message ? { note: values.message } : {}),
                    apply: values.apply ?? false,
                    agent,
                }),
            );
        }
    }
}

/** Reads one answer per call; input that ends before a line arrives answers with nothing. */
export function lineAsker(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
): NonNullable<Io["ask"]> {
    return async (question) => {
        const lines = createInterface({ input, output });
        try {
            const ended = new Promise<string>((resolve) => lines.once("close", () => resolve("")));
            return await Promise.race([lines.question(question), ended]);
        } finally {
            lines.close();
        }
    };
}

export function processIo(): Io {
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    return {
        cwd: process.cwd(),
        env: process.env,
        isTTY: process.stdout.isTTY === true,
        write: (text) => process.stdout.write(text),
        stdin: async () => await Bun.stdin.text(),
        ...(interactive ? { ask: lineAsker(process.stdin, process.stdout) } : {}),
    };
}

if (import.meta.main) {
    const { serverCommands } = await import("./open.ts");
    process.exitCode = await run(process.argv.slice(2), processIo(), serverCommands);
}
