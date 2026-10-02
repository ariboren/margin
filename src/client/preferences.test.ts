import { describe, expect, test } from "bun:test";
import { defaultPrefs, parsePrefs } from "./preferences.ts";

describe("parsePrefs", () => {
    test("nothing stored gives the defaults: medium text and margins, double click to edit, resolved threads shown", () => {
        expect(parsePrefs({})).toEqual(defaultPrefs);
        expect(parsePrefs(null)).toEqual(defaultPrefs);
        expect(parsePrefs("junk")).toEqual(defaultPrefs);
        expect(defaultPrefs).toEqual({
            density: "md",
            margins: "md",
            editOn: "dblclick",
            showMargin: true,
            showOutline: true,
            showResolved: true,
        });
    });

    test("stored values win field by field", () => {
        expect(
            parsePrefs({
                density: "sm",
                margins: "sm",
                editOn: "click",
                showOutline: false,
                showResolved: false,
            }),
        ).toEqual({
            density: "sm",
            margins: "sm",
            editOn: "click",
            showMargin: true,
            showOutline: false,
            showResolved: false,
        });
    });

    test("values off the allowed set fall back", () => {
        const prefs = parsePrefs({
            margins: "huge",
            showOutline: "no",
            density: 3,
            editOn: "tripleclick",
        });
        expect(prefs.margins).toBe("md");
        expect(prefs.editOn).toBe("dblclick");
        expect(prefs.showOutline).toBe(true);
        expect(prefs.density).toBe("md");
    });
});
