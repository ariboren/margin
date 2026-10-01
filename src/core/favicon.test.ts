import { describe, expect, test } from "bun:test";
import { faviconHref, faviconSvg } from "./favicon.ts";

/** WCAG 2 contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
    const luminance = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map((i) => {
            const c = parseInt(hex.slice(i, i + 2), 16) / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
}

describe("favicon", () => {
    test("is one solid dot in the state's colour on a 16 px grid", () => {
        const svg = (fill: string) =>
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="${fill}"/></svg>`;
        expect(faviconSvg("ok")).toBe(svg("#2d9854"));
        expect(faviconSvg("warn")).toBe(svg("#ae7b12"));
        expect(faviconSvg("err")).toBe(svg("#d64535"));
        expect(faviconSvg("accent")).toBe(svg("#4a7cc9"));
        expect(faviconSvg(null)).toBe(svg("#808080"));
    });

    test("every fill clears 3:1 against a light and a dark tab bar", () => {
        const fills = [null, "ok", "warn", "err", "accent"] as const;
        for (const dot of fills) {
            const fill = /fill="(#[0-9a-f]{6})"/.exec(faviconSvg(dot))![1]!;
            expect(contrast(fill, "#f0f0f0")).toBeGreaterThanOrEqual(3);
            expect(contrast(fill, "#1e1e1e")).toBeGreaterThanOrEqual(3);
        }
    });

    test("is a data URI the browser can decode back to the SVG", () => {
        const href = faviconHref("err");
        expect(href).toStartWith("data:image/svg+xml,");
        expect(decodeURIComponent(href.slice("data:image/svg+xml,".length))).toBe(
            faviconSvg("err"),
        );
    });
});
