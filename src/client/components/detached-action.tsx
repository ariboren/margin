import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { DocSnapshot, DocStore } from "../../core/model.ts";
import type { UndoStack } from "../undo.ts";
import { isDetached } from "../view-model.ts";
import { Tooltip } from "./tooltip.tsx";

interface DetachedActionProps {
    store: DocStore;
    snapshot: DocSnapshot;
    /** One undo takes the whole batch back; without a stack the resolves are not recorded. */
    undo: UndoStack | null;
    /** A tight bar shows "N detached"; the full label stays the name and the tooltip. */
    short: boolean;
}

export function detachedLabel(count: number): string {
    return `Resolve ${count} detached ${count === 1 ? "thread" : "threads"}`;
}

/**
 * "Resolve N detached threads", shown while any exist: after a rewrite leaves threads with no
 * text to point at, they go in one click and come back with one undo.
 */
export function DetachedAction({
    store,
    snapshot,
    undo,
    short,
}: DetachedActionProps): JSX.Element | null {
    const [busy, setBusy] = useState(false);
    const detached = snapshot.threads.filter(isDetached);
    if (detached.length === 0) {
        return null;
    }
    const count = detached.length;
    const noun = count === 1 ? "thread" : "threads";
    const label = detachedLabel(count);
    const resolveAll = async () => {
        setBusy(true);
        const run = async () => {
            for (const thread of detached) {
                await store.resolve(thread.id);
            }
        };
        try {
            await (undo ? undo.group(`resolve of ${count} detached ${noun}`, run) : run());
        } catch {
            // The store reports the failure; what landed before it stays resolved.
        } finally {
            setBusy(false);
        }
    };
    const button = (
        <button
            type="button"
            class="button button-quiet"
            aria-label={label}
            disabled={busy}
            onClick={() => void resolveAll()}
        >
            {short ? `${count} detached` : label}
        </button>
    );
    // The tip carries the words the short label drops; the full label needs none.
    return short ? <Tooltip text={label}>{() => button}</Tooltip> : button;
}
