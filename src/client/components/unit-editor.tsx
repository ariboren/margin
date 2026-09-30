import type { JSX } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DocSnapshot, DocStore, SaveResult, Unit } from "../../core/model.ts";
import { copyText } from "../clipboard.ts";
import {
    beginSession,
    follow,
    nextNudge,
    nudgeFor,
    putBack,
    reinsertEdit,
    restoreStranded,
    strandedKey,
    strandedRecord,
    type EditorSession,
    type Nudge,
} from "../editor-session.ts";
import { newReplacement, type Replacement } from "../replacements.ts";
import { recall, remember } from "../storage.ts";
import { submitKeys } from "../use-keys.ts";

interface UnitEditing {
    editing: Unit | null;
    begin: (unit: Unit) => void;
    editorFor: (unit: Unit) => JSX.Element | null;
    /** The draft of a unit deleted under its editor, shown apart from the doc; else null. */
    stranded: JSX.Element | null;
}

type Update = (patch: Partial<EditorSession>) => void;

const monoKinds = new Set<Unit["kind"]>([
    "code",
    "table",
    "list",
    "html",
    "yaml",
    "toml",
    "definition",
]);

function draftKey(path: string, unit: Unit): string {
    return `margin:draft:${path}:${unit.kind}:${unit.hash}`;
}

let sessions = 0;

/**
 * Click a unit to edit its raw markdown; blur saves through `saveUnit` (compare-and-swap on the text
 * the editor opened with). If the unit changes underneath, the editor keeps the draft and asks; if
 * it is deleted, the draft moves out of the doc and waits for the user to put it back or copy it.
 */
export function useUnitEditing(
    store: DocStore,
    snapshot: DocSnapshot,
    onReplaced: (replacement: Replacement) => void,
): UnitEditing {
    const stranded = strandedKey(snapshot.path);
    // A removed unit's draft left from before a reload comes back first.
    const [stored, setSession] = useState<EditorSession | null>(() =>
        restoreStranded(recall(stranded), snapshot.doc, snapshot.version, ++sessions),
    );
    // Refused tries to open another unit, for the removed session they belong to only.
    const [nudge, setNudge] = useState<Nudge | null>(null);
    const { source, units } = snapshot.doc;
    // Followed during render, not after paint, so nothing (a blur, a save) ever acts on a unit
    // from an older snapshot than the one on screen.
    const session = useMemo(
        () => (stored ? follow(stored, snapshot.doc, snapshot.version) : null),
        [stored, snapshot.doc, snapshot.version],
    );
    useEffect(() => {
        if (session === stored) {
            return;
        }
        let next = session;
        if (next?.gone && next.draftKey !== stranded) {
            // Its draft key names a hash no unit has any more: move the draft where the panel,
            // and a reload, will find it.
            remember(stranded, strandedRecord(next));
            remember(next.draftKey, null);
            next = { ...next, draftKey: stranded };
        }
        // Only over the state this render followed: a close or patch since then wins.
        setSession((current) => (current === stored ? next : current));
    }, [session, stored, stranded]);

    const update = useCallback<Update>(
        (patch) => setSession((current) => (current ? { ...current, ...patch } : current)),
        [],
    );

    const begin = useCallback(
        (unit: Unit) => {
            if (session?.gone) {
                const { id } = session;
                setNudge((current) => nextNudge(current, id));
                return;
            }
            const before = source.slice(unit.start, unit.end);
            const key = draftKey(snapshot.path, unit);
            const fresh: EditorSession = {
                id: ++sessions,
                unit,
                roots: units,
                version: snapshot.version,
                before,
                draft: recall(key) ?? before,
                theirs: null,
                keptMine: false,
                gone: null,
                draftKey: key,
            };
            setSession((current) => beginSession(current, fresh));
        },
        [session, source, units, snapshot.path, snapshot.version],
    );

    const close = useCallback(() => {
        setSession(null);
        setNudge(null);
    }, []);

    const editorFor = (unit: Unit): JSX.Element | null => {
        if (!session || session.gone || session.unit !== unit) {
            return null;
        }
        return (
            <UnitEditor
                key={session.id}
                store={store}
                snapshot={snapshot}
                session={session}
                update={update}
                close={close}
                onReplaced={onReplaced}
            />
        );
    };

    return {
        editing: session && !session.gone ? session.unit : null,
        begin,
        editorFor,
        stranded: session?.gone ? (
            <StrandedEditor
                store={store}
                snapshot={snapshot}
                session={session}
                update={update}
                close={close}
                record={stranded}
                key={session.id}
                nudge={nudgeFor(nudge, session.id)}
            />
        ) : null,
    };
}

interface UnitEditorProps {
    store: DocStore;
    snapshot: DocSnapshot;
    session: EditorSession;
    update: Update;
    close: () => void;
}

function UnitEditor({
    store,
    snapshot,
    session,
    update,
    close,
    onReplaced,
}: UnitEditorProps & { onReplaced: (replacement: Replacement) => void }): JSX.Element {
    const textarea = useRef<HTMLTextAreaElement>(null);
    const done = useRef(false);
    const { unit } = session;
    const cell = unit.kind === "tableCell";
    const key = session.draftKey;

    useLayoutEffect(() => {
        const element = textarea.current;
        if (element) {
            element.style.height = "auto";
            element.style.height = `${element.scrollHeight}px`;
        }
    }, [session.draft]);

    useEffect(() => {
        const element = textarea.current;
        element?.focus({ preventScroll: true });
        element?.setSelectionRange(element.value.length, element.value.length);
        // A blur fired while the editor is being removed (its unit deleted) must not save.
        return () => {
            done.current = true;
        };
    }, []);

    const save = async () => {
        if (done.current || session.theirs !== null) {
            return;
        }
        if (session.draft === session.before) {
            remember(key, null);
            close();
            return;
        }
        // Not a literal: `version` rides along past `DocStore`'s type to the server store.
        const edit = {
            start: unit.start,
            before: session.before,
            after: session.draft,
            version: session.version,
        };
        let result: SaveResult;
        try {
            result = await store.saveUnit(edit);
        } catch {
            // The store reports it; the editor stays open with the draft.
            return;
        }
        if (result.ok) {
            done.current = true;
            remember(key, null);
            if (session.keptMine) {
                // The agent's text this save overwrote stays recoverable, with Restore.
                const landed = "at" in result && typeof result.at === "number" ? result.at : null;
                const version =
                    "version" in result && typeof result.version === "number"
                        ? result.version
                        : null;
                const record = newReplacement({
                    id: `${Date.now()}-${session.id}`,
                    kind: unit.kind,
                    snapshot: store.snapshot(),
                    at: landed ?? unit.start,
                    version,
                    mine: session.draft,
                    replaced: session.before,
                });
                if (record) {
                    onReplaced(record);
                }
            }
            close();
        } else if (result.reason === "conflict") {
            update({ theirs: result.current });
        }
    };

    const cancel = () => {
        done.current = true;
        remember(key, null);
        close();
    };

    const changedBy = changedByWhom(snapshot);

    return (
        <div
            class={cell ? "unit-editor unit-editor-cell" : "unit-editor"}
            data-editing=""
            data-unit={unit.start}
            data-kind={unit.kind}
        >
            {session.theirs !== null ? (
                <div class="conflict-bar" role="alert">
                    <span>Changed {changedBy} while you were editing.</span>
                    <span class="conflict-actions">
                        <button
                            type="button"
                            class="button button-quiet"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() =>
                                update({
                                    before: session.theirs ?? "",
                                    theirs: null,
                                    keptMine: true,
                                })
                            }
                        >
                            Keep mine
                        </button>
                        <button
                            type="button"
                            class="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                                const theirs = session.theirs ?? "";
                                remember(key, null);
                                update({
                                    before: theirs,
                                    draft: theirs,
                                    theirs: null,
                                    keptMine: false,
                                });
                            }}
                        >
                            Take theirs
                        </button>
                    </span>
                </div>
            ) : null}
            <textarea
                ref={textarea}
                class={monoKinds.has(unit.kind) ? "unit-textarea mono" : "unit-textarea"}
                value={session.draft}
                spellcheck
                aria-label="Edit markdown"
                onInput={(event) => {
                    const draft = event.currentTarget.value;
                    remember(key, draft);
                    update({ draft });
                }}
                onBlur={() => void save()}
                onKeyDown={submitKeys(() => textarea.current?.blur(), cancel)}
            />
            {cell ? null : (
                <p class="unit-editor-hint">Markdown · click away or ⌘↵ to save · Esc to cancel</p>
            )}
        </div>
    );
}

function changedByWhom(snapshot: DocSnapshot): string {
    const lastEdit = snapshot.edits[snapshot.edits.length - 1];
    return snapshot.changedOnDisk ? "on disk" : lastEdit?.by === "agent" ? "by agent" : "elsewhere";
}

/**
 * The editor of a unit deleted underneath it. Nothing saves on its own: the offset it had now
 * belongs to other text, so the draft goes back only as a new block at its old place, on request.
 * Until then no other unit opens (`nudge` counts the refused tries), so the draft stays in sight.
 */
function StrandedEditor({
    store,
    snapshot,
    session,
    update,
    close,
    record,
    nudge,
}: UnitEditorProps & { record: string; nudge: number }): JSX.Element {
    const [status, setStatus] = useState<"idle" | "copied" | "failed" | "busy">("idle");
    const [putting, setPutting] = useState(false);
    const panel = useRef<HTMLDivElement>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const edit = reinsertEdit(session, snapshot.doc);

    // Only a refused try made while this panel is up shakes it, never its first render.
    const shaken = useRef(nudge);
    useEffect(() => {
        if (nudge <= shaken.current) {
            return;
        }
        shaken.current = nudge;
        setStatus("busy");
        textarea.current?.focus({ preventScroll: true });
        panel.current?.animate(
            [
                { transform: "translateX(-50%)" },
                { transform: "translateX(calc(-50% - 6px))" },
                { transform: "translateX(calc(-50% + 6px))" },
                { transform: "translateX(-50%)" },
            ],
            { duration: 240 },
        );
    }, [nudge]);

    const forget = () => {
        remember(record, null);
        if (session.draftKey !== record) {
            remember(session.draftKey, null);
        }
        close();
    };

    const reinsert = async () => {
        setPutting(true);
        let result: SaveResult | null;
        try {
            // `DocStore.saveUnit` has no version field; the server store reads it from the edit.
            result = await putBack(
                session,
                snapshot.doc,
                async (edit) => await store.saveUnit(edit),
            );
        } catch {
            setPutting(false);
            return;
        }
        if (result === null) {
            return;
        }
        if (result.ok) {
            forget();
        } else {
            setPutting(false);
            setStatus("failed");
        }
    };

    const message =
        status === "failed"
            ? "Could not put it back; copy it instead."
            : status === "busy"
              ? "Put this text back, copy it or discard it before editing something else."
              : `The text you were editing was removed ${changedByWhom(snapshot)}. Your draft is kept here.`;

    return (
        <div
            ref={panel}
            class="unit-editor unit-editor-stranded"
            role="dialog"
            aria-label="Removed text"
        >
            <div class="conflict-bar" role="alert">
                <span>{message}</span>
                <span class="conflict-actions">
                    {edit ? (
                        <button
                            type="button"
                            class="button"
                            disabled={putting}
                            onClick={() => void reinsert()}
                        >
                            Put it back
                        </button>
                    ) : null}
                    <button
                        type="button"
                        class="button button-quiet"
                        onClick={async () =>
                            setStatus((await copyText(session.draft)) ? "copied" : "idle")
                        }
                    >
                        {status === "copied" ? "Copied" : "Copy"}
                    </button>
                    <button
                        type="button"
                        class="button button-quiet"
                        disabled={putting}
                        onClick={forget}
                    >
                        Discard
                    </button>
                </span>
            </div>
            <textarea
                ref={textarea}
                class={monoKinds.has(session.unit.kind) ? "unit-textarea mono" : "unit-textarea"}
                value={session.draft}
                rows={6}
                spellcheck
                aria-label="Your draft"
                onInput={(event) => {
                    const draft = event.currentTarget.value;
                    remember(record, strandedRecord({ unit: session.unit, draft }));
                    update({ draft });
                }}
            />
        </div>
    );
}
