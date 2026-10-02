import type { JSX } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DocSnapshot, DocStore, SaveResult, Unit } from "../../core/model.ts";
import { copyText } from "../clipboard.ts";
import { reducedMotion } from "../motion.ts";
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
    /**
     * What the editor shows apart from the doc, mounted once at page level: the keys hint while an
     * editor is open, the conflict dock in its place, and the draft of a unit deleted under its
     * editor.
     */
    overlay: JSX.Element;
}

type Update = (patch: Partial<EditorSession>) => void;

/** The rendered block's footprint, which its editor keeps so nothing below it moves. */
interface UnitBox {
    height: number;
    marginTop: number;
    marginBottom: number;
    /** The block's padding and border, as a CSS padding value: the text starts inside them. */
    padding: string;
}

const sides = ["top", "right", "bottom", "left"] as const;

function measureUnit(unit: Unit): UnitBox | null {
    if (unit.kind === "tableCell") {
        return null;
    }
    const element = document.querySelector(
        `.doc [data-unit="${unit.start}"][data-kind="${unit.kind}"]:not([data-editing])`,
    );
    if (!element) {
        return null;
    }
    // The editor takes the place of the whole block, which for a list or table is its hatch.
    const swapped = element.parentElement?.classList.contains("source-hatch")
        ? element.parentElement
        : element;
    const style = getComputedStyle(swapped);
    const edge = (side: (typeof sides)[number]) =>
        Number.parseFloat(style.getPropertyValue(`padding-${side}`)) +
        Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
    return {
        height: swapped.getBoundingClientRect().height,
        marginTop: Number.parseFloat(style.marginTop),
        marginBottom: Number.parseFloat(style.marginBottom),
        padding: sides.map((side) => `${edge(side)}px`).join(" "),
    };
}

/** Source that is markup or layout edits in mono; prose, down to one list item or cell, in the serif. */
const monoKinds = new Set<Unit["kind"]>([
    "code",
    "table",
    "list",
    "html",
    "yaml",
    "toml",
    "definition",
]);

export function textareaClass(kind: Unit["kind"]): string {
    return monoKinds.has(kind) ? "unit-textarea mono" : "unit-textarea";
}

function draftKey(path: string, unit: Unit): string {
    return `margin:draft:${path}:${unit.kind}:${unit.hash}`;
}

let sessions = 0;

const hintId = "unit-editor-hint";

/** `submitKeys` takes ⌘↵ or Ctrl+Enter; the hint names the one this keyboard has. */
export function submitKeyLabel(platform: string): string {
    return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘↵" : "Ctrl+↵";
}

function platformName(): string {
    try {
        const hints = (navigator as Navigator & { userAgentData?: { platform?: string } })
            .userAgentData;
        return hints?.platform || navigator.platform || "";
    } catch {
        return "";
    }
}

const submitLabel = submitKeyLabel(platformName());

/**
 * One chip for every editor, so moving from block to block doesn't replay its entrance. It stays
 * mounted and only toggles, which lets it fade out after the editor is gone.
 */
function EditHint({ open }: { open: boolean }): JSX.Element {
    return (
        <p id={hintId} class="unit-editor-hint" data-open={open ? "" : undefined}>
            <span class="unit-editor-hint-long">
                <span class="pill pill-editing">Editing</span> · click away or{" "}
                <kbd>{submitLabel}</kbd> to save · <kbd>Esc</kbd> to cancel
            </span>
            <span class="unit-editor-hint-short">
                <kbd>{submitLabel}</kbd> save · <kbd>Esc</kbd> cancel
            </span>
        </p>
    );
}

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
    // Measured as the session opens, while the rendered block is still there to measure.
    const boxes = useRef(new Map<number, UnitBox>());

    const begin = useCallback(
        (unit: Unit) => {
            if (session?.gone) {
                const { id } = session;
                setNudge((current) => nextNudge(current, id));
                return;
            }
            const before = source.slice(unit.start, unit.end);
            const key = draftKey(snapshot.path, unit);
            const id = ++sessions;
            const box = measureUnit(unit);
            if (box) {
                boxes.current.set(id, box);
            }
            const fresh: EditorSession = {
                id,
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
        boxes.current.clear();
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
                box={boxes.current.get(session.id) ?? null}
                update={update}
                close={close}
                onReplaced={onReplaced}
            />
        );
    };

    const live = session && !session.gone ? session : null;
    return {
        editing: live?.unit ?? null,
        begin,
        editorFor,
        overlay: (
            <>
                <EditHint open={live !== null && live.theirs === null} />
                {live && live.theirs !== null ? (
                    <ConflictDock
                        key={live.id}
                        snapshot={snapshot}
                        session={live}
                        update={update}
                    />
                ) : null}
                {session?.gone ? (
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
                ) : null}
            </>
        ),
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
    box,
    update,
    close,
    onReplaced,
}: UnitEditorProps & {
    box: UnitBox | null;
    onReplaced: (replacement: Replacement) => void;
}): JSX.Element {
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

    // Keep mine or Take theirs unmounts the dock under the keyboard; typing resumes in the editor.
    const conflicted = useRef(false);
    useEffect(() => {
        if (conflicted.current && session.theirs === null) {
            textarea.current?.focus({ preventScroll: true });
        }
        conflicted.current = session.theirs !== null;
    }, [session.theirs]);

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
    const keys = submitKeys(() => textarea.current?.blur(), cancel);

    return (
        <div
            class={cell ? "unit-editor unit-editor-cell" : "unit-editor"}
            style={
                box
                    ? { marginTop: `${box.marginTop}px`, marginBottom: `${box.marginBottom}px` }
                    : {}
            }
            data-editing=""
            data-unit={unit.start}
            data-kind={unit.kind}
        >
            <textarea
                ref={textarea}
                class={textareaClass(unit.kind)}
                style={box ? { minHeight: `${box.height}px`, padding: box.padding } : {}}
                rows={1}
                value={session.draft}
                spellcheck
                aria-label="Edit markdown"
                aria-describedby={hintId}
                onInput={(event) => {
                    const draft = event.currentTarget.value;
                    remember(key, draft);
                    update({ draft });
                }}
                onBlur={() => void save()}
                onKeyDown={(event) => {
                    if (session.theirs !== null && tabWithinConflict(event)) {
                        return;
                    }
                    keys(event);
                }}
            />
        </div>
    );
}

/**
 * The unit changed under an open editor: docked at the bottom in the hint's place, so the block
 * keeps its height. The buttons keep the editor focused; its blur does not save while a conflict
 * stands.
 */
function ConflictDock({
    snapshot,
    session,
    update,
}: {
    snapshot: DocSnapshot;
    session: EditorSession;
    update: Update;
}): JSX.Element {
    const theirs = session.theirs ?? "";
    return (
        <div
            class="conflict-bar conflict-dock"
            role="alert"
            onKeyDown={(event) => void tabWithinConflict(event)}
        >
            <span>Changed {changedByWhom(snapshot)} while you were editing.</span>
            <span class="conflict-actions">
                <button
                    type="button"
                    class="button button-quiet"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => update({ before: theirs, theirs: null, keptMine: true })}
                >
                    Keep mine
                </button>
                <button
                    type="button"
                    class="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                        remember(session.draftKey, null);
                        update({ before: theirs, draft: theirs, theirs: null, keptMine: false });
                    }}
                >
                    Take theirs
                </button>
            </span>
        </div>
    );
}

/** The next stop in a ring of `count` focus stops, wrapping both ways. */
export function ringStep(index: number, count: number, back: boolean): number {
    return (index + (back ? count - 1 : 1)) % count;
}

/**
 * While a conflict stands, Tab and Shift+Tab cycle the editor and the dock's buttons. The dock
 * sits outside the editor in the tree, so the browser's order would pass it by one way and leave
 * it for the top of the page the other. True when the key moved focus.
 */
function tabWithinConflict(event: KeyboardEvent): boolean {
    if (event.key !== "Tab") {
        return false;
    }
    const area = document.querySelector<HTMLElement>("[data-editing] textarea");
    const buttons = document.querySelectorAll<HTMLElement>(".conflict-dock button");
    const ring = area ? [area, ...buttons] : [...buttons];
    const index = ring.indexOf(event.target as HTMLElement);
    if (index < 0 || ring.length < 2) {
        return false;
    }
    event.preventDefault();
    ring[ringStep(index, ring.length, event.shiftKey)]!.focus();
    return true;
}

function changedByWhom(snapshot: DocSnapshot): string {
    const lastEdit = snapshot.edits[snapshot.edits.length - 1];
    return snapshot.changedOnDisk
        ? "on disk"
        : lastEdit?.by === "agent"
          ? "by the agent"
          : "elsewhere";
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
        if (reducedMotion()) {
            return;
        }
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
                class={textareaClass(session.unit.kind)}
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
