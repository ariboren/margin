// The tab icon: one dot in a state colour. Shared by the daemon's first paint and the client.

export type Dot = "ok" | "warn" | "err" | "accent";

/*
 * Fixed mid-tones: CSS variables do not resolve inside a favicon and the tab bar's colour cannot
 * be read, so each clears 3:1 against both a light (#f0f0f0) and a dark (#1e1e1e) bar.
 */
const DOT_COLOURS: Record<Dot, string> = {
    ok: "#2d9854",
    warn: "#ae7b12",
    err: "#d64535",
    accent: "#4a7cc9",
};
/** Before the page knows any state (the daemon's first paint). */
const NEUTRAL = "#808080";

/** One solid dot filling the 16 px square, with a little room at the edge. */
export function faviconSvg(dot: Dot | null): string {
    const fill = dot === null ? NEUTRAL : DOT_COLOURS[dot];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="${fill}"/></svg>`;
}

export function faviconHref(dot: Dot | null): string {
    return `data:image/svg+xml,${encodeURIComponent(faviconSvg(dot))}`;
}
