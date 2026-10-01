// A scripted stand-in for the agent: it reads `margin watch` and `margin pending` output the way
// the contract teaches (each compact watch line, then `pending` for the threads) and answers
// each thread by a policy. It runs the real CLI in-process, so what it records is
// the stdout an agent would read. `bun scripts/fake-agent.ts <doc>` runs it against a live doc.
import type { PendingReview, ThreadId, WakeReason } from "../src/core/model.ts";
import { isThreadId } from "../src/cli/doc.ts";
import type { CompactLine } from "../src/cli/format.ts";
import { run } from "../src/cli/main.ts";

export type Answer =
    { reply: string; resolve?: boolean } | { suggest: string; apply?: boolean; note?: string };

/** One thread the agent has to answer, from a `pending` block. */
export interface Task {
    id: ThreadId;
    quote: string;
    /** What the user said since the agent last answered. */
    messages: string[];
}

export type Policy = (task: Task) => Answer;

export interface Call {
    argv: string[];
    code: number;
    stdout: string;
}

export interface PendingThreadBlock {
    id: ThreadId;
    state: string;
    /** A doc note: no quote, line 0, empty path. */
    doc: boolean;
    line: number;
    path: string;
    quote: string;
    messages: { by: string; text: string }[];
    text: string;
}

export interface PendingEditBlock {
    line: number;
    path: string;
    hunks: string[];
    text: string;
}

export interface PendingOutput {
    threads: PendingThreadBlock[];
    edits: PendingEditBlock[];
    /** The header line, when the doc's status has something to say. */
    review?: PendingReview;
}

export interface Batch {
    line: CompactLine;
    tasks: Task[];
    /** The ack for each task, in order. */
    acks: string[];
}

/** Reads a JSON string literal at `from`; returns it and the index after it. */
function jsonString(text: string, from: number): [string, number] {
    if (text[from] !== '"') throw new Error(`expected a string at ${from}`);
    let end = from + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
    return [JSON.parse(text.slice(from, end + 1)) as string, end + 1];
}

const REASONS: readonly string[] = [
    "new",
    "reply",
    "rejected",
    "approved",
    "dropped",
    "reopened",
    "finish",
] satisfies WakeReason[];

function parseCompact(text: string): CompactLine {
    const groups: CompactLine["groups"] = [];
    let at = 0;
    while (at < text.length) {
        if (text[at] === " ") {
            at += 1;
            continue;
        }
        const group = groups.at(-1);
        if (text[at] === '"') {
            if (!group) throw new Error("compact line must start with a reason");
            [group.path, at] = jsonString(text, at);
            continue;
        }
        const end = text.indexOf(" ", at);
        const word = text.slice(at, end === -1 ? text.length : end);
        at += word.length;
        if (word === "|") continue;
        if (REASONS.includes(word)) {
            groups.push({ reason: word as WakeReason, ids: [] });
        } else if (group && isThreadId(word)) {
            group.ids.push(word);
        } else if (group && word === "doc") {
            group.doc = true;
        } else {
            throw new Error("unrecognised compact line");
        }
    }
    return { form: "compact", groups };
}

/** Parses one `margin watch` batch; undefined when nothing was printed. */
export function parseWatch(stdout: string): CompactLine | undefined {
    const text = stdout.replace(/\n$/, "");
    return text === "" ? undefined : parseCompact(text);
}

function unescapeLine(text: string): string {
    return text.replace(/\\n/g, "\n");
}

/** The header of `pending`: `approved changed: note`, `dropped`, `finish` or `reopened`. */
function parseReview(line: string): PendingReview | undefined {
    if (line === "finish") return { finish: true };
    if (line === "reopened") return { reopened: true };
    const verdict = /^(approved|dropped)( changed)?(?:: (.*))?$/.exec(line);
    if (!verdict) return undefined;
    return {
        verdict: verdict[1] as "approved" | "dropped",
        ...(verdict[2] ? { changed: true as const } : {}),
        ...(verdict[3] === undefined ? {} : { note: unescapeLine(verdict[3]) }),
    };
}

/** Parses plain-text `margin pending` output. */
export function parsePending(stdout: string): PendingOutput {
    const out: PendingOutput = { threads: [], edits: [] };
    const text = stdout.replace(/\n$/, "");
    if (text === "none") return out;
    const blocks: string[][] = [];
    const lines = text.split("\n");
    const review = parseReview(lines[0]!);
    if (review) {
        out.review = review;
        lines.shift();
    }
    for (const line of lines) {
        if (line.startsWith("  ")) blocks.at(-1)?.push(line);
        else blocks.push([line]);
    }
    for (const block of blocks) {
        const [head, ...body] = block as [string, ...string[]];
        const edit = /^edit L(\d+) ?(.*)$/.exec(head);
        if (edit) {
            out.edits.push({
                line: Number(edit[1]),
                path: edit[2]!,
                hunks: body.map((line) => line.slice(2)),
                text: block.join("\n"),
            });
            continue;
        }
        // `c3 open doc` is a doc note: no clip line, so its messages start at once.
        const thread = /^(c\d+) (\S+)(?: detached)?(?: L(\d+) ?(.*)| doc)$/.exec(head);
        const id = thread?.[1];
        if (!thread || !id || !isThreadId(id)) throw new Error("unrecognised pending block");
        const doc = thread[3] === undefined;
        const context = doc ? "" : (body[0]?.slice(2) ?? "");
        const open = context.indexOf("[[");
        const close = context.lastIndexOf("]]");
        const messages = body
            .slice(doc ? 0 : 1)
            .map((line) => /^ {2}(user|agent): (.*)$/.exec(line))
            .filter((match) => match !== null)
            .map((match) => ({ by: match[1]!, text: unescapeLine(match[2]!) }));
        out.threads.push({
            id,
            state: thread[2]!,
            doc,
            line: doc ? 0 : Number(thread[3]),
            path: thread[4] ?? "",
            quote: doc ? "" : unescapeLine(context.slice(open + 2, close)),
            messages,
            text: block.join("\n"),
        });
    }
    return out;
}

export interface FakeAgentOptions {
    doc: string;
    cwd: string;
    env: Record<string, string | undefined>;
}

export class FakeAgent {
    /** Every CLI call in order, with its stdout: the agent's whole reading. */
    readonly calls: Call[] = [];

    constructor(private readonly options: FakeAgentOptions) {}

    async margin(argv: string[], stdin = "", signal?: AbortSignal): Promise<Call> {
        let stdout = "";
        const code = await run(argv, {
            cwd: this.options.cwd,
            env: this.options.env,
            isTTY: false,
            write: (text) => {
                stdout += text;
            },
            stdin: async () => stdin,
            ...(signal ? { signal } : {}),
        });
        const call = { argv, code, stdout };
        this.calls.push(call);
        return call;
    }

    /** One batch from `margin watch --once`, or undefined if none came within `timeoutMs`. */
    async watchOnce(timeoutMs?: number): Promise<CompactLine | undefined> {
        const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
        const call = await this.margin(["watch", this.options.doc, "--once"], "", signal);
        return parseWatch(call.stdout);
    }

    async pending(): Promise<PendingOutput> {
        return parsePending((await this.margin(["pending", this.options.doc])).stdout);
    }

    /** Answers with one CLI call; suggestions go through `--replace -` like a heredoc would. */
    async answer(id: ThreadId, answer: Answer): Promise<string> {
        const { doc } = this.options;
        if ("reply" in answer) {
            const argv = ["reply", doc, id, answer.reply, ...(answer.resolve ? ["--resolve"] : [])];
            return (await this.margin(argv)).stdout.trimEnd();
        }
        const argv = [
            "suggest",
            doc,
            id,
            "--replace",
            "-",
            ...(answer.apply ? ["--apply"] : []),
            ...(answer.note ? ["-m", answer.note] : []),
        ];
        return (await this.margin(argv, `${answer.suggest}\n`)).stdout.trimEnd();
    }

    /** Waits for one batch, reads its threads through `pending`, and answers each. */
    async handleBatch(policy: Policy, timeoutMs?: number): Promise<Batch | undefined> {
        const line = await this.watchOnce(timeoutMs);
        if (!line) return undefined;
        const tasks = (await this.pending()).threads.map((thread) => ({
            id: thread.id,
            quote: thread.quote,
            messages: thread.messages
                .filter((message) => message.by === "user")
                .map((message) => message.text),
        }));
        const acks: string[] = [];
        for (const task of tasks) acks.push(await this.answer(task.id, policy(task)));
        return { line, tasks, acks };
    }
}

/** For trying the UI by hand: `replace: <text>` gets a suggestion, anything else a reply. */
const demoPolicy: Policy = (task) => {
    const last = task.messages.at(-1) ?? "";
    const match = /^replace: ([\s\S]+)$/.exec(last);
    return match ? { suggest: match[1]! } : { reply: "Noted, done." };
};

if (import.meta.main) {
    const doc = process.argv[2];
    if (!doc) {
        console.error("usage: bun scripts/fake-agent.ts <doc>");
        process.exit(2);
    }
    const agent = new FakeAgent({ doc, cwd: process.cwd(), env: process.env });
    for (;;) {
        const batch = await agent.handleBatch(demoPolicy);
        if (batch) console.log(batch.acks.join("\n"));
    }
}
