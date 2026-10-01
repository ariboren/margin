import { useEffect, useState } from "preact/hooks";
import type { Notice, UndoStack } from "./undo.ts";
import { typing } from "./use-keys.ts";

/**
 * ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y elsewhere) on the page. Inside a text field the
 * browser's own text undo applies, so those are left alone. The current notice re-renders here,
 * and so does any change to the stacks, so what reads `stack.top` and `stack.next` stays current.
 */
export function useUndo(stack: UndoStack | null): Notice {
    const [notice, setNotice] = useState<Notice>(stack?.current ?? null);
    const [, setChanges] = useState(0);
    useEffect(() => {
        if (!stack) {
            return;
        }
        setNotice(stack.current);
        const unsubscribe = stack.subscribe(setNotice);
        const unwatch = stack.onChange(() => setChanges((count) => count + 1));
        const onKey = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey) || event.altKey || typing(event.target)) {
                return;
            }
            const key = event.key.toLowerCase();
            if (key === "z") {
                event.preventDefault();
                void (event.shiftKey ? stack.redo() : stack.undo());
            } else if (key === "y" && event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                void stack.redo();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => {
            unsubscribe();
            unwatch();
            window.removeEventListener("keydown", onKey);
        };
    }, [stack]);
    return notice;
}
