import { useEffect, useState } from "preact/hooks";
import { recall, remember } from "./storage.ts";

export type Scale = "sm" | "md" | "lg";
/** What opens a block's editor: a single click, or a double click so a click can only select. */
export type EditOn = "click" | "dblclick";

/** Per-viewer display choices; they never reach the store or the agent. */
export interface ViewPrefs {
    /** Text size of the reading column. */
    density: Scale;
    /** Space around the reading column; large is the classic layout, small fills the window. */
    margins: Scale;
    editOn: EditOn;
    showMargin: boolean;
    showOutline: boolean;
    showResolved: boolean;
}

const storageKey = "margin:view";
export const defaultPrefs: ViewPrefs = {
    density: "md",
    margins: "lg",
    editOn: "dblclick",
    showMargin: true,
    showOutline: true,
    showResolved: false,
};

function scale(value: unknown, fallback: Scale): Scale {
    return value === "sm" || value === "md" || value === "lg" ? value : fallback;
}

function editOn(value: unknown, fallback: EditOn): EditOn {
    return value === "click" || value === "dblclick" ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

/** Stored prefs with every field checked; anything missing or off keeps its default. */
export function parsePrefs(stored: unknown): ViewPrefs {
    if (typeof stored !== "object" || stored === null) {
        return defaultPrefs;
    }
    const record = stored as Partial<Record<keyof ViewPrefs, unknown>>;
    return {
        density: scale(record.density, defaultPrefs.density),
        margins: scale(record.margins, defaultPrefs.margins),
        editOn: editOn(record.editOn, defaultPrefs.editOn),
        showMargin: flag(record.showMargin, defaultPrefs.showMargin),
        showOutline: flag(record.showOutline, defaultPrefs.showOutline),
        showResolved: flag(record.showResolved, defaultPrefs.showResolved),
    };
}

export function loadPrefs(): ViewPrefs {
    try {
        return parsePrefs(JSON.parse(recall(storageKey) ?? "{}"));
    } catch {
        return defaultPrefs;
    }
}

/** The attributes the stylesheet lays the page out by; main.tsx sets them before the first paint. */
export function applyViewPrefs(prefs: ViewPrefs): void {
    document.documentElement.dataset.density = prefs.density;
    document.documentElement.dataset.margins = prefs.margins;
}

export function useViewPrefs(): [ViewPrefs, (change: Partial<ViewPrefs>) => void] {
    const [prefs, setPrefs] = useState(loadPrefs);
    useEffect(() => {
        applyViewPrefs(prefs);
        remember(storageKey, JSON.stringify(prefs));
    }, [prefs]);
    return [prefs, (change) => setPrefs((current) => ({ ...current, ...change }))];
}
