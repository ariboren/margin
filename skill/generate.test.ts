import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentHelp } from "../src/cli/main.ts";
import { RELEASED_UNSTAMPED, classifySkill, packageVersion } from "../src/cli/setup.ts";
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

    test("the skill ends with a stamp, outside the fenced help; the snippet has none", () => {
        const help = readHelp();
        const { skill, snippet } = render(help, "1.2.3");
        expect(skill).toMatch(/```\n\n<!-- margin-skill 1\.2\.3 [0-9a-f]{12} -->\n$/);
        expect(skill).toContain(`\`\`\`text\n${help}\`\`\`\n`);
        expect(snippet).not.toContain("margin-skill");
        expect(readFileSync(outputs.skill, "utf8")).toBe(render(help, packageVersion()).skill);
        expect(classifySkill(skill, render(help, "1.2.4").skill, "1.2.4").kind).toBe("current");
    });

    test("the hashes of the skills released before the stamp match the tags", () => {
        const tagged = (version: string) =>
            Bun.spawnSync(["git", "show", `v${version}:skill/margin/SKILL.md`], {
                cwd: join(import.meta.dir, ".."),
            });
        const versions = Object.values(RELEASED_UNSTAMPED);
        expect(versions).toEqual(["0.1.0", "0.2.0", "0.2.1", "0.2.2", "0.2.3", "0.3.0"]);
        // A shallow checkout has no tags to compare against. CI fetches them, so there a missing
        // tag fails the test instead of passing it unrun.
        if (tagged("0.3.0").exitCode !== 0 && !process.env.CI) return;
        for (const [hash, version] of Object.entries(RELEASED_UNSTAMPED)) {
            const show = tagged(version);
            expect(show.exitCode).toBe(0);
            const text = show.stdout.toString();
            expect(createHash("sha256").update(text).digest("hex").slice(0, 16)).toBe(hash);
            expect(classifySkill(text, readFileSync(outputs.skill, "utf8"), "99.0.0")).toEqual({
                kind: "older",
                version,
            });
        }
    });

    test("a changed source shows as drift", () => {
        expect(drifted(`${readHelp()}extra line\n`)).toEqual(["skill", "snippet"]);
    });
});
