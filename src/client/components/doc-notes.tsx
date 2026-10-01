import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DocSnapshot, DocStore, ThreadId } from "../../core/model.ts";
import { recall, remember } from "../storage.ts";
import type { ApplyControls } from "../use-apply.ts";
import { submitKeys } from "../use-keys.ts";
import { docNotes, docNotesBusy, latestAgentSeq } from "../view-model.ts";
import { ThreadCard } from "./thread-card.tsx";
import { Tooltip } from "./tooltip.tsx";

interface DocNotesProps {
    store: DocStore;
    snapshot: DocSnapshot;
    now: number;
    /** Threads just handed to a watching agent, which read as being answered. */
    eager: ReadonlySet<ThreadId>;
    open: boolean;
    /** The note the panel opens on, selected and scrolled to. */
    focus: ThreadId | null;
    onOpen: () => void;
    onClose: () => void;
    showResolved: boolean;
    apply: ApplyControls;
    followLink: (event: MouseEvent, url: string) => void;
}

/**
 * The agent message seq the panel last showed. With nothing stored (a fresh browser, or storage
 * blocked) everything already there counts as seen, so the dot only ever means news.
 */
export function initialSeen(stored: string | null, latest: number): number {
    if (stored === null) {
        return latest;
    }
    const seen = Number(stored);
    return Number.isFinite(seen) ? seen : latest;
}

function seenKey(path: string): string {
    return `margin:doc-notes-seen:${path}`;
}

/**
 * Notes on the doc as a whole: a floating button with a count, and a panel that lists them like
 * a chat with a composer at the bottom. They never enter the margin rail.
 */
export function DocNotes(props: DocNotesProps): JSX.Element {
    const { snapshot, open, onClose } = props;
    const notes = useMemo(
        () => docNotes(snapshot.threads, props.showResolved),
        [snapshot.threads, props.showResolved],
    );
    const live = notes.filter((note) => note.state !== "resolved").length;
    const latest = latestAgentSeq(docNotes(snapshot.threads, true));
    const [seen, setSeen] = useState(() => initialSeen(recall(seenKey(snapshot.path)), latest));
    useEffect(() => {
        if (open && latest > seen) {
            setSeen(latest);
            remember(seenKey(snapshot.path), String(latest));
        }
    }, [open, latest, seen, snapshot.path]);
    const unseen = !open && latest > seen;
    const busy = docNotesBusy(notes, props.now, props.eager);

    const root = useRef<HTMLDivElement>(null);
    const close = useRef(onClose);
    useEffect(() => {
        close.current = onClose;
    });
    // A press outside only closes the panel: the click it turns into is swallowed before the page
    // can open an editor or pick a thread with it. The swallow is dropped right after the press
    // ends, so a press that never becomes a click (a drag) leaves the next click alone.
    useEffect(() => {
        if (!open) {
            return;
        }
        const swallow = (event: MouseEvent) => {
            event.stopPropagation();
            event.preventDefault();
        };
        const onPointerDown = (event: PointerEvent) => {
            if (root.current?.contains(event.target as Node)) {
                return;
            }
            close.current();
            document.addEventListener("click", swallow, { capture: true, once: true });
            document.addEventListener(
                "pointerup",
                () => setTimeout(() => document.removeEventListener("click", swallow, true), 0),
                { once: true },
            );
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("click", swallow, true);
        };
    }, [open]);

    const label = live === 0 ? "Doc notes" : `Doc notes, ${live} open`;
    return (
        <div class="doc-notes" ref={root}>
            {open ? <Panel {...props} notes={notes} /> : null}
            <Tooltip text={`${label} (n)`} align="end" side="above">
                {() => (
                    <button
                        type="button"
                        class={`doc-notes-button${busy ? " doc-notes-busy" : ""}`}
                        aria-label={label}
                        aria-expanded={open}
                        onClick={open ? onClose : props.onOpen}
                    >
                        {busy || unseen ? <span class="doc-notes-dot" /> : null}
                        <span>Doc notes</span>
                        {live > 0 ? <span class="doc-notes-count">{live}</span> : null}
                    </button>
                )}
            </Tooltip>
        </div>
    );
}

function Panel(props: DocNotesProps & { notes: ReturnType<typeof docNotes> }): JSX.Element {
    const { store, snapshot, notes, focus } = props;
    const [activeId, setActiveId] = useState<ThreadId | null>(focus);
    const list = useRef<HTMLDivElement>(null);
    useEffect(() => {
        list.current?.scrollTo({ top: list.current.scrollHeight });
    }, [notes.length]);
    useEffect(() => {
        if (focus === null) {
            return;
        }
        setActiveId(focus);
        list.current
            ?.querySelector(`[data-card="${CSS.escape(focus)}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [focus]);
    return (
        <section class="doc-notes-panel" role="dialog" aria-label="Doc notes">
            <header class="doc-notes-head">
                <span>Doc notes</span>
                <button
                    type="button"
                    class="icon-button"
                    aria-label="Close doc notes"
                    onClick={props.onClose}
                >
                    <CloseIcon />
                </button>
            </header>
            <div class="doc-notes-list" ref={list}>
                {notes.length === 0 ? (
                    <p class="doc-notes-empty">
                        Notes on the doc as a whole, not tied to any text. The agent reads them like
                        comments.
                    </p>
                ) : (
                    notes.map((note) => (
                        <ThreadCard
                            key={note.id}
                            store={store}
                            thread={note}
                            active={note.id === activeId}
                            collapsible={false}
                            now={props.now}
                            hold={snapshot.settings.hold}
                            eager={props.eager.has(note.id)}
                            onActivate={() => setActiveId(note.id)}
                            apply={props.apply}
                            followLink={props.followLink}
                        />
                    ))
                )}
            </div>
            <NoteComposer store={store} hold={snapshot.settings.hold} onCancel={props.onClose} />
        </section>
    );
}

function NoteComposer({
    store,
    hold,
    onCancel,
}: {
    store: DocStore;
    hold: boolean;
    onCancel: () => void;
}): JSX.Element {
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const field = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        field.current?.focus({ preventScroll: true });
    }, []);
    const ready = text.trim().length > 0 && !sending;
    const submit = async () => {
        if (!ready) {
            return;
        }
        setSending(true);
        try {
            await store.comment({ text: text.trim() });
            setText("");
        } catch {
            // The store reports the failure; the text stays for another try.
        } finally {
            setSending(false);
            field.current?.focus({ preventScroll: true });
        }
    };
    return (
        <div class="doc-notes-composer">
            <textarea
                ref={field}
                class="reply-input"
                rows={2}
                placeholder="Note for the agent about the whole doc…"
                value={text}
                onInput={(event) => setText(event.currentTarget.value)}
                onKeyDown={submitKeys(() => void submit(), onCancel)}
            />
            <div class="card-actions">
                <span class="hint">{hold ? "Held until you send all" : "⌘↵ to send"}</span>
                <span class="card-actions-end">
                    <button
                        type="button"
                        class="button"
                        disabled={!ready}
                        onClick={() => void submit()}
                    >
                        {hold ? "Save draft" : "Add note"}
                    </button>
                </span>
            </div>
        </div>
    );
}

function CloseIcon(): JSX.Element {
    return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
    );
}
