import type { JSX } from "preact";
import type { Notice, UndoStack } from "../undo.ts";

/** "Thread deleted · Undo" (the same undo as ⌘Z), or why the last undo or redo changed nothing. */
export function UndoNotice({
    notice,
    stack,
}: {
    notice: Notice;
    stack: UndoStack;
}): JSX.Element | null {
    if (!notice) {
        return null;
    }
    if (notice.kind === "refused") {
        return (
            <div class="toast" role="status">
                <span>{notice.text}</span>
            </div>
        );
    }
    return (
        <div class="toast" role="status">
            <span>Thread deleted</span>
            <button type="button" class="button button-quiet" onClick={() => void stack.undo()}>
                Undo
            </button>
        </div>
    );
}
