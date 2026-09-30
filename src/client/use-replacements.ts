import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { hashText } from "../core/blocks.ts";
import type { DocSnapshot, DocStore, SaveResult } from "../core/model.ts";
import {
    parseReplacements,
    rebase,
    replacementsKey,
    restoreEdit,
    type Replacement,
} from "./replacements.ts";
import { recall, remember } from "./storage.ts";

export interface Replacements {
    /** Records that point into the source on screen now. */
    placed: Replacement[];
    add: (replacement: Replacement) => void;
    /** Puts the agent's text back; resolves to why it could not, or null. */
    restore: (replacement: Replacement) => Promise<string | null>;
    dismiss: (replacement: Replacement) => void;
}

/**
 * The "replaced the agent's version" records of this doc, kept per viewer across reloads. Each is
 * followed from snapshot to snapshot and drops out once anything touches its range. After a
 * reload only a record made against the very same source comes back: nothing is rebased blind.
 */
export function useReplacements(store: DocStore, snapshot: DocSnapshot): Replacements {
    const key = replacementsKey(snapshot.path);
    const { doc } = snapshot;
    const hash = useMemo(() => hashText(doc.source), [doc.source]);
    const [list, setList] = useState<Replacement[]>(() =>
        parseReplacements(recall(key)).filter((entry) => entry.hash === hash),
    );

    const change = useCallback(
        (edit: (current: Replacement[]) => Replacement[]) =>
            setList((current) => {
                const next = edit(current);
                remember(key, next.length > 0 ? JSON.stringify(next) : null);
                return next;
            }),
        [key],
    );

    // Follow every record from the last source seen to this one. A record made against the new
    // source already (added after its save landed) stays as it is; one against anything else
    // than the previous source cannot be followed and goes.
    const seen = useRef({ source: doc.source, hash });
    useEffect(() => {
        const previous = seen.current;
        if (previous.hash === hash) {
            return;
        }
        seen.current = { source: doc.source, hash };
        change((current) =>
            current.flatMap((entry) => {
                if (entry.hash === hash) {
                    return [entry];
                }
                const next =
                    entry.hash === previous.hash
                        ? rebase(entry, previous.source, doc.source, doc)
                        : null;
                return next ? [next] : [];
            }),
        );
    }, [doc, hash, change]);

    const drop = (replacement: Replacement) =>
        change((current) => current.filter((entry) => entry.id !== replacement.id));

    return {
        placed: list.filter((entry) => entry.hash === hash),
        add: (replacement) => change((current) => [...current, replacement]),
        dismiss: drop,
        restore: async (replacement) => {
            // Not a literal: `version` and `strict` ride along past `DocStore`'s type.
            const request = restoreEdit(replacement);
            let result: SaveResult;
            try {
                result = await store.saveUnit(request);
            } catch {
                return null;
            }
            if (result.ok) {
                drop(replacement);
                return null;
            }
            change((current) =>
                current.map((entry) =>
                    entry.id === replacement.id ? { ...entry, refused: true } : entry,
                ),
            );
            return result.reason === "missing"
                ? "The file is missing on disk, so the agent's version was not put back."
                : "The text there changed since, so the agent's version was not put back. Copy it to restore it by hand.";
        },
    };
}
