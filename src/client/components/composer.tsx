import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { hunkPieces, type HunkPieces } from "../../core/diff.ts";
import type { Anchor, DocStore, EditEvent, ThreadId } from "../../core/model.ts";
import { clipDiff, visibleText } from "../edit-diff.ts";
import { relativeTime } from "../time.ts";
import { submitKeys } from "../use-keys.ts";
import { CardHead } from "./card-head.tsx";

export interface ComposerTarget {
    mode: "comment" | "suggest";
    anchor: Anchor;
}

interface ComposerProps {
    store: DocStore;
    target: ComposerTarget;
    hold: boolean;
    /** Brackets the request; the page holds new cards back while it is on. */
    onSending: (sending: boolean) => void;
    onDone: (id: ThreadId | null) => void;
}

export function Composer({ store, target, hold, onSending, onDone }: ComposerProps): JSX.Element {
    const suggesting = target.mode === "suggest";
    const [replace, setReplace] = useState(target.anchor.exact);
    const [text, setText] = useState("");
    const first = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        first.current?.focus({ preventScroll: true });
        if (suggesting) {
            first.current?.select();
        }
    }, [suggesting]);

    const ready = suggesting ? replace !== target.anchor.exact : text.trim().length > 0;
    const submit = async () => {
        if (!ready) {
            return;
        }
        const note = text.trim() || undefined;
        onSending(true);
        let id: ThreadId;
        try {
            id = suggesting
                ? await store.suggest({ anchor: target.anchor, replace, text: note })
                : await store.comment({ anchor: target.anchor, text: text.trim() });
        } catch {
            // The store reports the failure; the text stays for another try.
            onSending(false);
            return;
        }
        // Closing the composer drops the hold with it, in the same render the new card mounts.
        onDone(id);
    };
    const keys = submitKeys(
        () => void submit(),
        () => onDone(null),
    );

    return (
        <article class="card card-active card-composer" data-card="new">
            <header class="card-head">
                <span class="pill pill-new">{suggesting ? "Suggest an edit" : "New comment"}</span>
                {hold ? <span class="card-meta">Held until you send all</span> : null}
            </header>
            {suggesting ? (
                <label class="field">
                    <span>Replace with</span>
                    <textarea
                        ref={first}
                        class="reply-input mono"
                        rows={3}
                        value={replace}
                        onInput={(event) => setReplace(event.currentTarget.value)}
                        onKeyDown={keys}
                    />
                </label>
            ) : null}
            <textarea
                ref={suggesting ? undefined : first}
                class="reply-input"
                rows={suggesting ? 1 : 3}
                placeholder={suggesting ? "Note (optional)" : "Comment for the agent…"}
                value={text}
                onInput={(event) => setText(event.currentTarget.value)}
                onKeyDown={keys}
            />
            <div class="card-actions">
                <span class="hint">⌘↵ to send</span>
                <span class="card-actions-end">
                    <button type="button" class="button button-quiet" onClick={() => onDone(null)}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        class="button"
                        disabled={!ready}
                        onClick={() => void submit()}
                    >
                        {hold ? "Save draft" : suggesting ? "Suggest" : "Comment"}
                    </button>
                </span>
            </div>
        </article>
    );
}

interface EditCardProps {
    store: DocStore;
    edit: EditEvent;
    now: number;
}

/**
 * A user edit does not wake the agent; it rides along in the agent's next `margin pending`,
 * which a comment or reply triggers. This card shows the edit, collapsed to its count until
 * opened, and lets the user add a note the agent gets now.
 */
export function EditCard({ store, edit, now }: EditCardProps): JSX.Element {
    const [open, setOpen] = useState(false);
    const [asking, setAsking] = useState(false);
    const [text, setText] = useState("");
    const diff = useMemo(() => hunkPieces(edit.before, edit.after), [edit.before, edit.after]);
    const send = () => {
        if (text.trim()) {
            void store.followThrough(edit.seq, text.trim());
        }
    };
    // Collapsed, a click anywhere on the card opens it; open, only the header closes it.
    return (
        <article
            class={open ? "card card-edit" : "card card-edit card-collapsed"}
            data-card={`edit-${edit.seq}`}
            onClick={open ? undefined : () => setOpen(true)}
        >
            <CardHead
                expanded={open}
                onToggle={open ? () => setOpen(false) : undefined}
                pill={<span class="pill pill-edit">Edited by you</span>}
                meta={relativeTime(edit.at, now)}
            />
            <EditDiff diff={diff} open={open} />
            {open ? (
                <>
                    <p class="card-note">The agent gets this with your next comment or reply.</p>
                    {asking ? (
                        <div class="card-reply">
                            <textarea
                                class="reply-input"
                                rows={2}
                                placeholder="Note for the agent…"
                                value={text}
                                onInput={(event) => setText(event.currentTarget.value)}
                                onKeyDown={submitKeys(send, () => setAsking(false))}
                            />
                            <div class="card-actions">
                                <span class="hint">⌘↵ to send</span>
                                <span class="card-actions-end">
                                    <button
                                        type="button"
                                        class="button button-quiet"
                                        onClick={() => setAsking(false)}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        class="button"
                                        disabled={!text.trim()}
                                        onClick={send}
                                    >
                                        Add note
                                    </button>
                                </span>
                            </div>
                        </div>
                    ) : (
                        <div class="card-actions">
                            <button
                                type="button"
                                class="button button-quiet"
                                onClick={() => setAsking(true)}
                            >
                                Add a note
                            </button>
                        </div>
                    )}
                </>
            ) : null}
        </article>
    );
}

function changesLabel(count: number): string {
    return `${count} ${count === 1 ? "change" : "changes"}`;
}

/**
 * The edit as the agent will read it: word hunks with a few words of context, clipped. The first
 * hunk is the same element open or not: closed, the CSS clamps it to one line and a "+N" counts
 * the rest, so opening only reveals what follows and the first line stays where it was.
 */
function EditDiff({ diff, open }: { diff: HunkPieces[]; open: boolean }): JSX.Element | null {
    const [all, setAll] = useState(false);
    const [first, ...rest] = diff;
    if (!first) {
        return null;
    }
    const { shown, clipped } = clipDiff(diff, all);
    return (
        <div class="edit-diff">
            <div class="edit-row">
                <Hunk hunk={first} />
                {open || rest.length === 0 ? null : (
                    <span class="card-summary-end">+{rest.length}</span>
                )}
            </div>
            {open
                ? shown.slice(1).map((hunk, index) => <Hunk key={index + 1} hunk={hunk} />)
                : null}
            {open && (clipped || all) ? (
                <button type="button" class="link-button" onClick={() => setAll(!all)}>
                    {all ? "Show less" : `Show all (${changesLabel(diff.length)})`}
                </button>
            ) : null}
        </div>
    );
}

/** One hunk as the agent reads it: deleted words struck, inserted words marked, context plain. */
function Hunk({ hunk }: { hunk: HunkPieces }): JSX.Element {
    return (
        <span class="edit-hunk">
            {hunk.cutBefore ? "…" : null}
            {hunk.pieces.map((piece, at) =>
                piece.kind === "del" ? (
                    <del key={at} class="sg-del">
                        {visibleText(piece.text)}
                    </del>
                ) : piece.kind === "ins" ? (
                    <ins key={at} class="sg-ins">
                        {visibleText(piece.text)}
                    </ins>
                ) : (
                    <span key={at}>{visibleText(piece.text)}</span>
                ),
            )}
            {hunk.cutAfter ? "…" : null}
        </span>
    );
}
