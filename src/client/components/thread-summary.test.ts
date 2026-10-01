import { describe, expect, test } from "bun:test";
import type { Message, Thread } from "../../core/model.ts";
import { previewText, summarize } from "./thread-summary.ts";

const at = "2026-09-30T12:00:00.000Z";

function message(by: Message["by"], text: string, seq = 1): Message {
    return { seq, at, by, text };
}

function thread(partial: Partial<Thread>): Thread {
    return {
        id: "c1",
        state: "open",
        anchor: { exact: "the quoted  words", prefix: "", suffix: "", hint: 0 },
        detached: false,
        createdBy: "user",
        messages: [],
        claimed: false,
        lastActivity: at,
        ...partial,
    };
}

describe("previewText", () => {
    test("keeps the first block as plain text, markdown flattened", () => {
        expect(previewText("Use **strict** mode and `tsc`.\n\nSecond paragraph.")).toBe(
            "Use strict mode and tsc.",
        );
    });

    test("a heading, a list and a quote give their first text", () => {
        expect(previewText("## Plan\nmore")).toBe("Plan");
        expect(previewText("- first item\n- second")).toBe("first item");
        expect(previewText("> quoted *line*")).toBe("quoted line");
    });

    test("line breaks and runs of space collapse to one space", () => {
        expect(previewText("one\ntwo   three")).toBe("one two three");
    });

    test("a link reads as its text; a code block as its code", () => {
        expect(previewText("see [the spec](https://x.y) now")).toBe("see the spec now");
        expect(previewText("```\nlet a = 1;\n```")).toBe("let a = 1;");
    });

    test("empty text gives an empty preview", () => {
        expect(previewText("")).toBe("");
        expect(previewText("   \n")).toBe("");
    });
});

describe("summarize", () => {
    test("names the last speaker and the start of the last message", () => {
        const summary = summarize(
            thread({
                messages: [
                    message("user", "Is this right?", 1),
                    message("agent", "Yes, **it is**.", 2),
                ],
            }),
        );
        expect(summary).toEqual({ speaker: "Agent", preview: "Yes, it is." });
    });

    test("the user's own message reads as You", () => {
        expect(summarize(thread({ messages: [message("user", "Tighten this.")] })).speaker).toBe(
            "You",
        );
    });

    test("a suggestion without a note falls back to the suggestion label", () => {
        const base = { seq: 1, replace: "new text", status: "pending" as const };
        expect(summarize(thread({ suggestion: { ...base, by: "agent" } }))).toEqual({
            preview: "Agent suggests an edit",
        });
        expect(summarize(thread({ suggestion: { ...base, by: "user" } }))).toEqual({
            preview: "Your suggested edit",
        });
    });

    test("with no message and no suggestion, the quote stands in, squashed", () => {
        expect(summarize(thread({}))).toEqual({ preview: "the quoted words" });
    });
});
