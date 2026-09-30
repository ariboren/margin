import { useState } from "preact/hooks";
import type { DocStore, SaveResult, Thread, ThreadId } from "../core/model.ts";

export type ApplyAction = "accept" | "revert";

/** Why an accept or revert changed nothing, in words; null when it went through. */
export function refusalText(action: ApplyAction, result: SaveResult): string | null {
    if (result.ok) {
        return null;
    }
    if (result.reason === "missing") {
        return "The file is missing on disk, so nothing changed.";
    }
    return action === "accept"
        ? "The quoted text changed since this was suggested, so it was not applied."
        : "The text changed after the agent's edit, so it was not reverted.";
}

/** The suggestion or applied edit a refusal belongs to; a newer one clears it. */
function subject(thread: Thread, action: ApplyAction): number | undefined {
    return action === "accept" ? thread.suggestion?.seq : thread.applied?.seq;
}

export interface ApplyControls {
    accept: (thread: Thread) => void;
    revert: (thread: Thread) => void;
    /** Why the last accept or revert on this thread did nothing, while it still applies. */
    notice: (thread: Thread) => string | undefined;
}

/**
 * Accept and revert can be refused (the quote moved on, the file vanished); the refusal shows on
 * the card instead of the click silently doing nothing. Failed requests are the store's to report.
 */
export function useApply(store: DocStore): ApplyControls {
    const [notices, setNotices] = useState<
        ReadonlyMap<ThreadId, { action: ApplyAction; seq?: number; text: string }>
    >(new Map());
    const run = async (thread: Thread, action: ApplyAction) => {
        let result: SaveResult;
        try {
            result = await (action === "accept"
                ? store.accept(thread.id)
                : store.revert(thread.id));
        } catch {
            return;
        }
        const text = refusalText(action, result);
        setNotices((current) => {
            const next = new Map(current);
            if (text) {
                next.set(thread.id, { action, seq: subject(thread, action), text });
            } else {
                next.delete(thread.id);
            }
            return next;
        });
    };
    return {
        accept: (thread) => void run(thread, "accept"),
        revert: (thread) => void run(thread, "revert"),
        notice: (thread) => {
            const entry = notices.get(thread.id);
            return entry && entry.seq === subject(thread, entry.action) ? entry.text : undefined;
        },
    };
}
