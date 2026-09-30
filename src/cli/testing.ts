// Shared setup for the CLI tests: a temp dir with a doc, its own state dir, and helpers that
// write the user's side of the log through the core API.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnchor } from "../core/anchor.ts";
import { appendEvents, readLog } from "../core/log.ts";
import type { EventInput, ThreadId } from "../core/model.ts";
import { createThread, foldLog, type DocState } from "../core/threads.ts";
import { run, type Io } from "./main.ts";

export const DOC = `# Title

## Findings

The cache is warm by the time the first tile renders, so the cold path rarely runs.

| Area | Owner | Note |
| --- | --- | --- |
| Tiles | Platform | Retry queue fills under load |
| Glyphs | Fonts | Loader is fine |
`;

export interface Sandbox {
    dir: string;
    doc: string;
    env: Record<string, string>;
    cleanup(): void;
    text(): string;
    state(): Promise<DocState>;
    comment(exact: string, text: string, options?: { draft?: boolean }): Promise<ThreadId>;
    append(...inputs: EventInput[]): Promise<void>;
    cli(argv: string[], options?: { stdin?: string; isTTY?: boolean }): Promise<CliResult>;
}

export interface CliResult {
    code: number;
    stdout: string;
}

export function sandbox(content = DOC): Sandbox {
    const dir = mkdtempSync(join(tmpdir(), "margin-cli-"));
    const doc = join(dir, "doc.md");
    writeFileSync(doc, content);
    const env = { MARGIN_STATE_DIR: join(dir, "state"), MARGIN_DEBOUNCE_MS: "0" };
    return {
        dir,
        doc,
        env,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
        text: () => readFileSync(doc, "utf8"),
        state: async () => foldLog((await readLog(doc)).events),
        async comment(exact, text, options = {}) {
            const source = readFileSync(doc, "utf8");
            const start = source.indexOf(exact);
            if (start === -1) throw new Error(`not in doc: ${exact}`);
            const anchor = createAnchor(source, { start, end: start + exact.length });
            const { id } = await createThread(doc, (next) => [
                {
                    type: "comment",
                    by: "user",
                    id: next,
                    anchor,
                    text,
                    draft: options.draft ?? false,
                },
            ]);
            return id;
        },
        async append(...inputs) {
            await appendEvents(doc, inputs);
        },
        async cli(argv, options = {}) {
            let stdout = "";
            const io: Io = {
                cwd: dir,
                env,
                isTTY: options.isTTY ?? false,
                write: (text) => {
                    stdout += text;
                },
                stdin: async () => options.stdin ?? "",
                signal: AbortSignal.timeout(5_000),
            };
            const code = await run(argv, io);
            return { code, stdout };
        },
    };
}
