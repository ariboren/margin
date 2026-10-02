// Generates the Claude Code skill and the AGENTS.md snippet from src/cli/agent-help.md, the
// canonical agent contract, so the three texts never drift. `--check` exits 1 when a file on
// disk differs from what the source renders to; generate.test.ts asserts the same.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { packageVersion, stampSkill } from "../src/cli/setup.ts";

const root = join(import.meta.dir, "..");

const sourcePath = join(root, "src/cli/agent-help.md");

export const outputs = {
    skill: join(root, "skill/margin/SKILL.md"),
    snippet: join(root, "AGENTS.snippet.md"),
} as const;

type Output = keyof typeof outputs;

const generated =
    "Generated from `margin agent-help` by `bun run skill`; edit src/cli/agent-help.md.";

/** Outside the fenced help, so the agent-help byte ceiling does not pay for them. */
const opening =
    "Open a doc for the user with `margin <doc>`, once. The first line it prints is the page URL and the rest is the help below, so read it with `head -1`. Run again while the tab is open, it prints the same URL and opens no second tab.";

const watching =
    "Keep one `margin watch`, with no path, for every doc you open. It follows the docs your session opens, including ones opened after it started, so never start a second watch. If its first line starts with `only`, margin found no session id and is watching that one doc: set `MARGIN_SESSION` to a name of your own on every margin command, run `margin pending <doc>` on each doc so the session lists it, then start the watch again. Or keep one watch per doc, each named by its path.";

const silence =
    'Never end a margin turn with an empty reply, which the user sees as a blank bullet. End it with a two-or-three-word confirmation and nothing else, for example "Margin watcher re-armed." after re-arming the watch and "Answered in margin." after handling threads. No summary of what you wrote in the doc, no status, no question. That covers answering a thread, a watch expiring, re-arming it, and letting one lapse. The user reads your replies in the page, so a chat echo repeats the doc and interrupts them, and a note that a watch expired gives them nothing to act on. Write more in chat only when they asked for updates there, for a critical alert, or at a handoff point. A critical alert: comments cannot reach you (the watch or the daemon is broken), an answer failed, or something needs the user that the doc cannot carry. A handoff point: the user approved, declined or asked you to finish the doc and that changes what you do next, or work the doc set in motion is done.';

const naming =
    "The page names you after your session, the title in your tab, so leave `--as` and `MARGIN_AGENT` off unless the user asks for another name.";

function fenced(help: string): string {
    return `\`\`\`text\n${help.replace(/\n?$/, "\n")}\`\`\`\n`;
}

/**
 * The skill ends with a stamp naming this version, which is how an installed copy is told from an
 * older or an edited one. The snippet has none: margin never installs it.
 */
export function render(help: string, version = packageVersion()): Record<Output, string> {
    return {
        skill: stampSkill(
            [
                "---",
                "name: margin",
                "description: Answer review threads on a markdown doc through the margin CLI. Use when a doc is open in margin, when `margin watch` or `margin pending` prints a batch, or when a thread id like c3 needs a reply or suggestion.",
                "---",
                "",
                generated,
                "",
                opening,
                "",
                watching,
                "",
                silence,
                "",
                naming,
                "",
                fenced(help),
            ].join("\n"),
            version,
        ),
        snippet: [
            "## margin (markdown review threads)",
            "",
            generated,
            "",
            opening,
            "",
            watching,
            "",
            silence,
            "",
            naming,
            "",
            fenced(help),
        ].join("\n"),
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
