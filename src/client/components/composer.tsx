import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Anchor, DocStore, EditEvent, ThreadId } from "../../core/model.ts";
import { relativeTime } from "../time.ts";
import { submitKeys } from "../use-keys.ts";

export interface ComposerTarget {
    mode: "comment" | "suggest";
    anchor: Anchor;
}

interface ComposerProps {
    store: DocStore;
    target: ComposerTarget;
    hold: boolean;
    onDone: (id: ThreadId | null) => void;
}

export function Composer({ store, target, hold, onDone }: ComposerProps): JSX.Element {
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
        const id = suggesting
            ? await store.suggest({ anchor: target.anchor, replace, text: note })
            : await store.comment({ anchor: target.anchor, text: text.trim() });
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

/** A user edit rides along to the agent silently; this asks the agent to act on it now. */
export function EditCard({ store, edit, now }: EditCardProps): JSX.Element {
    const [asking, setAsking] = useState(false);
    const [text, setText] = useState("Carry this change through the rest of the doc.");
    const send = () => {
        if (text.trim()) {
            void store.followThrough(edit.seq, text.trim());
        }
    };
    return (
        <article class="card card-edit" data-card={`edit-${edit.seq}`}>
            <header class="card-head">
                <span class="pill pill-edit">You edited this</span>
                <span class="card-meta">{relativeTime(edit.at, now)}</span>
            </header>
            <p class="card-note">The agent sees this edit next time it checks in.</p>
            {asking ? (
                <div class="card-reply">
                    <textarea
                        class="reply-input"
                        rows={2}
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
                            <button type="button" class="button" onClick={send}>
                                Ask agent
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
                        Ask agent to follow through
                    </button>
                </div>
            )}
        </article>
    );
}
