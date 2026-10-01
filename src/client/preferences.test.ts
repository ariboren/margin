import { describe, expect, test } from "bun:test";
import { defaultPrefs, parsePrefs } from "./preferences.ts";

describe("parsePrefs", () => {
    test("nothing stored gives the defaults: large margins, outline shown, double click to edit", () => {
        expect(parsePrefs({})).toEqual(defaultPrefs);
        expect(parsePrefs(null)).toEqual(defaultPrefs);
        expect(parsePrefs("junk")).toEqual(defaultPrefs);
        expect(defaultPrefs.margins).toBe("lg");
        expect(defaultPrefs.showOutline).toBe(true);
        expect(defaultPrefs.editOn).toBe("dblclick");
    });

    test("stored values win field by field", () => {
        expect(
            parsePrefs({
                density: "sm",
                margins: "sm",
                editOn: "click",
                showOutline: false,
                showResolved: true,
            }),
        ).toEqual({
            density: "sm",
            margins: "sm",
            editOn: "click",
            showMargin: true,
            showOutline: false,
            showResolved: true,
        });
    });

    test("values off the allowed set fall back", () => {
        const prefs = parsePrefs({
            margins: "huge",
            showOutline: "no",
            density: 3,
            editOn: "tripleclick",
        });
        expect(prefs.margins).toBe("lg");
        expect(prefs.editOn).toBe("dblclick");
        expect(prefs.showOutline).toBe(true);
        expect(prefs.density).toBe("md");
    });
});
