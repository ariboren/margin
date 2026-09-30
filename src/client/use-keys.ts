import { useEffect, useRef } from "preact/hooks";

type KeyMap = Partial<Record<string, () => void>>;

function typing(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    );
}

/** Single-key shortcuts, ignored while typing (except Escape) or with a modifier held. */
export function useKeys(keys: KeyMap): void {
    const keysRef = useRef(keys);
    useEffect(() => {
        keysRef.current = keys;
    });
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }
            if (typing(event.target) && event.key !== "Escape") {
                return;
            }
            const run = keysRef.current[event.key];
            if (run) {
                event.preventDefault();
                run();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
}

/** ⌘↵ (Ctrl+Enter elsewhere) submits; Escape cancels. For textareas. */
export function submitKeys(submit: () => void, cancel: () => void) {
    return (event: KeyboardEvent) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
        }
    };
}
