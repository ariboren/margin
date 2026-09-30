import { useEffect, useState } from "preact/hooks";

export type Density = "sm" | "md" | "lg";

/** Per-viewer display choices; they never reach the store or the agent. */
export interface ViewPrefs {
    density: Density;
    showMargin: boolean;
    showResolved: boolean;
}

const storageKey = "margin:view";
const defaults: ViewPrefs = { density: "md", showMargin: true, showResolved: false };

function load(): ViewPrefs {
    try {
        const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Partial<ViewPrefs>;
        return {
            density: ["sm", "md", "lg"].includes(stored.density ?? "")
                ? stored.density!
                : defaults.density,
            showMargin:
                typeof stored.showMargin === "boolean" ? stored.showMargin : defaults.showMargin,
            showResolved:
                typeof stored.showResolved === "boolean"
                    ? stored.showResolved
                    : defaults.showResolved,
        };
    } catch {
        return defaults;
    }
}

export function useViewPrefs(): [ViewPrefs, (change: Partial<ViewPrefs>) => void] {
    const [prefs, setPrefs] = useState(load);
    useEffect(() => {
        document.documentElement.dataset.density = prefs.density;
        try {
            localStorage.setItem(storageKey, JSON.stringify(prefs));
        } catch {
            // Storage can be blocked; the choice still applies for this page.
        }
    }, [prefs]);
    return [prefs, (change) => setPrefs((current) => ({ ...current, ...change }))];
}
