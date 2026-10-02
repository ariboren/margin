import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentHelp } from "../src/cli/main.ts";
import { drifted, outputs, readHelp, render } from "./generate.ts";

describe("skill and AGENTS.md snippet", () => {
    test("are generated from the agent-help the CLI prints", () => {
        expect(readHelp()).toBe(agentHelp());
        expect(drifted()).toEqual([]);
    });

    test("carry the contract verbatim", () => {
        const help = readHelp();
        for (const path of Object.values(outputs)) {
            expect(readFileSync(path, "utf8")).toContain(`\`\`\`text\n${help}\`\`\``);
        }
    });

    test("the skill is a SKILL.md with a name, inside its own directory", () => {
        expect(outputs.skill.endsWith(join("margin", "SKILL.md"))).toBe(true);
        expect(render("x\n").skill).toMatch(/^---\nname: margin\ndescription: .+\n---\n/);
    });

    test("the chat rule sits above the fenced help, with both exceptions", () => {
        for (const text of Object.values(render("x\n"))) {
            const preamble = text.slice(0, text.indexOf("```text"));
            expect(preamble).toContain("Never end a margin turn with an empty reply");
            expect(preamble).toContain('"Margin watcher re-armed."');
            expect(preamble).toContain('"Answered in margin."');
            expect(preamble).toContain("a watch expiring, re-arming it, and letting one lapse");
            expect(preamble).toContain("Write more in chat only when");
            expect(preamble).toContain("A critical alert:");
            expect(preamble).toContain("A handoff point:");
        }
    });

    test("one watch for every doc is asked for above the fenced help", () => {
        for (const text of Object.values(render("x\n"))) {
            const preamble = text.slice(0, text.indexOf("```text"));
            expect(preamble).toContain("Keep one `margin watch`, with no path");
            expect(preamble).toContain("`MARGIN_SESSION`");
        }
    });

    test("a changed source shows as drift", () => {
        expect(drifted(`${readHelp()}extra line\n`)).toEqual(["skill", "snippet"]);
    });
});
