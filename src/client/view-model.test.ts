import { describe, expect, test } from "bun:test";
import { createAnchor } from "../core/anchor.ts";
import { parseDoc } from "../core/blocks.ts";
import type { DocSnapshot, Thread, ThreadState } from "../core/model.ts";
import { buildView, headingSlugs } from "./view-model.ts";

const source = "# Title\n\nOne sentence here. Another sentence there.\n";

function snapshotWith(states: ThreadState[]): DocSnapshot {
    const threads: Thread[] = states.map((state, index) => {
        const exact = index === 0 ? "One sentence" : "Another sentence";
        const start = source.indexOf(exact);
        return {
            id: `c${index + 1}`,
            state,
            anchor: createAnchor(source, { start, end: start + exact.length }),
            detached: false,
            createdBy: "user",
            messages: [],
            claimed: false,
            autoApply: false,
            lastActivity: "2026-09-30T12:00:00Z",
        };
    });
    return {
        path: "doc.md",
        doc: parseDoc(source),
        threads,
        edits: [],
        settings: { hold: false, suggestionsOnly: false, autoApply: false },
        missing: false,
        version: 1,
    };
}

describe("buildView decorations", () => {
    test("resolved threads leave their text unmarked by default", () => {
        const view = buildView(snapshotWith(["open", "resolved"]));
        expect(view.decorations.map((decoration) => [decoration.id, decoration.kind])).toEqual([
            ["c1", "comment"],
        ]);
        expect(view.order).toEqual(["c1"]);
    });

    test("show resolved paints them with the faint kind", () => {
        const view = buildView(snapshotWith(["open", "resolved"]), true);
        expect(view.decorations.map((decoration) => [decoration.id, decoration.kind])).toEqual([
            ["c1", "comment"],
            ["c2", "resolved"],
        ]);
    });
});

describe("headingSlugs", () => {
    test("GitHub-style anchors, repeats numbered", () => {
        expect(
            headingSlugs([
                "1. Verdict",
                "What's next?",
                "A/B & C — notes",
                "Überblick",
                "Setup",
                "Setup",
                "Setup-1",
                "snake_case `code`",
            ]),
        ).toEqual([
            "1-verdict",
            "whats-next",
            "ab--c--notes",
            "überblick",
            "setup",
            "setup-1",
            "setup-1-1",
            "snake_case-code",
        ]);
    });
});
