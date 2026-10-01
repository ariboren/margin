import { describe, expect, test } from "bun:test";
import { ringStep, submitKeyLabel, textareaClass } from "./unit-editor.tsx";

describe("submitKeyLabel", () => {
    test("Apple platforms show the command key", () => {
        for (const platform of ["MacIntel", "macOS", "iPhone", "iPad"]) {
            expect(submitKeyLabel(platform)).toBe("⌘↵");
        }
    });

    test("everything else, including an unknown platform, shows Ctrl", () => {
        for (const platform of ["Win32", "Windows", "Linux x86_64", "Android", ""]) {
            expect(submitKeyLabel(platform)).toBe("Ctrl+↵");
        }
    });
});

describe("textareaClass", () => {
    test("prose edits in the reading serif, down to a single list item or table cell", () => {
        for (const kind of [
            "paragraph",
            "heading",
            "blockquote",
            "listItem",
            "tableCell",
            "footnoteDefinition",
        ] as const) {
            expect(textareaClass(kind)).toBe("unit-textarea");
        }
    });

    test("code, frontmatter, raw HTML, definitions and whole lists or tables edit in mono", () => {
        for (const kind of [
            "code",
            "yaml",
            "toml",
            "html",
            "definition",
            "list",
            "table",
        ] as const) {
            expect(textareaClass(kind)).toBe("unit-textarea mono");
        }
    });
});

describe("ringStep", () => {
    test("Tab walks the editor and the dock's buttons and wraps to the editor", () => {
        expect([0, 1, 2].map((index) => ringStep(index, 3, false))).toEqual([1, 2, 0]);
    });

    test("Shift+Tab walks back and wraps from the editor to the last button", () => {
        expect([0, 1, 2].map((index) => ringStep(index, 3, true))).toEqual([2, 0, 1]);
    });
});
