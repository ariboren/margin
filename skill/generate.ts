// Generates the Claude Code skill and the AGENTS.md snippet from src/cli/agent-help.md, the
// canonical agent contract, so the three texts never drift. `--check` exits 1 when a file on
// disk differs from what the source renders to; generate.test.ts asserts the same.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");

const sourcePath = join(root, "src/cli/agent-help.md");

export const outputs = {
    skill: join(root, "skill/margin/SKILL.md"),
    snippet: join(root, "AGENTS.snippet.md"),
} as const;

type Output = keyof typeof outputs;

const generated =
    "Generated from `margin agent-help` by `bun run skill`; edit src/cli/agent-help.md.";

function fenced(help: string): string {
    return `\`\`\`text\n${help.replace(/\n?$/, "\n")}\`\`\`\n`;
}

export function render(help: string): Record<Output, string> {
    return {
        skill: [
            "---",
            "name: margin",
            "description: Answer review threads on a markdown doc through the margin CLI. Use when a doc is open in margin, when `margin watch` or `margin pending` prints a batch, or when a thread id like c3 needs a reply or suggestion.",
            "---",
            "",
            generated,
            "",
            fenced(help),
        ].join("\n"),
        snippet: ["## margin (markdown review threads)", "", generated, "", fenced(help)].join(
            "\n",
        ),
    };
}

export function readHelp(): string {
    return readFileSync(sourcePath, "utf8");
}

function readOutput(path: string): string | undefined {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
}

/** The outputs whose file on disk differs from the source's rendering. */
export function drifted(help = readHelp()): Output[] {
    const rendered = render(help);
    return (Object.keys(outputs) as Output[]).filter(
        (key) => readOutput(outputs[key]) !== rendered[key],
    );
}

function generate(help = readHelp()): void {
    const rendered = render(help);
    for (const key of Object.keys(outputs) as Output[]) {
        mkdirSync(dirname(outputs[key]), { recursive: true });
        writeFileSync(outputs[key], rendered[key]);
    }
}

if (import.meta.main) {
    if (process.argv.includes("--check")) {
        const stale = drifted();
        for (const key of stale) {
            console.error(`${relative(root, outputs[key])} is out of date; run bun run skill`);
        }
        process.exit(stale.length === 0 ? 0 : 1);
    }
    generate();
}
