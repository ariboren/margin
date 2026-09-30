import { useCallback, useEffect, useState } from "preact/hooks";
import { useMedia } from "./use-media.ts";

type ThemeChoice = "system" | "light" | "dark";

const storageKey = "margin:theme";

function readChoice(): ThemeChoice {
    const preset = document.documentElement.dataset.theme;
    if (preset === "light" || preset === "dark") {
        return preset;
    }
    try {
        const stored = localStorage.getItem(storageKey);
        return stored === "light" || stored === "dark" ? stored : "system";
    } catch {
        return "system";
    }
}

export function useTheme(): { dark: boolean; toggle: () => void } {
    const [choice, setChoice] = useState<ThemeChoice>(readChoice);
    const systemDark = useMedia("(prefers-color-scheme: dark)");

    useEffect(() => {
        const root = document.documentElement;
        if (choice === "system") {
            delete root.dataset.theme;
        } else {
            root.dataset.theme = choice;
        }
        try {
            localStorage.setItem(storageKey, choice);
        } catch {
            // Storage can be blocked (private windows, file:// in some browsers); the choice still applies.
        }
    }, [choice]);

    const dark = choice === "dark" || (choice === "system" && systemDark);
    const toggle = useCallback(() => setChoice(dark ? "light" : "dark"), [dark]);
    return { dark, toggle };
}
