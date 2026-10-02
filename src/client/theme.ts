import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { DEVICE_KEYS } from "../server/protocol.ts";
import { recall, remember } from "./storage.ts";
import { useMedia } from "./use-media.ts";

export type ThemeChoice = "system" | "light" | "dark";

const storageKey = DEVICE_KEYS.theme;

export function readChoice(): ThemeChoice {
    const preset = document.documentElement.dataset.theme;
    if (preset === "light" || preset === "dark") {
        return preset;
    }
    const stored = recall(storageKey);
    return stored === "light" || stored === "dark" ? stored : "system";
}

/** Sets the theme attribute the stylesheet reads; main.tsx applies the stored choice before the first paint. */
export function applyTheme(choice: ThemeChoice): void {
    const root = document.documentElement;
    if (choice === "system") {
        delete root.dataset.theme;
    } else {
        root.dataset.theme = choice;
    }
}

export function useTheme(): { dark: boolean; toggle: () => void } {
    const [choice, setChoice] = useState<ThemeChoice>(readChoice);
    const stored = useRef(choice);
    const systemDark = useMedia("(prefers-color-scheme: dark)");

    useEffect(() => {
        applyTheme(choice);
        // Only a change is stored: the mockup's preset theme is not the viewer's choice.
        if (choice !== stored.current) {
            remember(storageKey, choice);
            stored.current = choice;
        }
    }, [choice]);

    const dark = choice === "dark" || (choice === "system" && systemDark);
    const toggle = useCallback(() => setChoice(dark ? "light" : "dark"), [dark]);
    return { dark, toggle };
}
