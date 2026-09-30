import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import type { DocStore, Thread, ThreadId } from "../../core/model.ts";
import { recall, remember } from "../storage.ts";
import { relativeTime } from "../time.ts";
import type { ApplyControls } from "../use-apply.ts";
import { submitKeys } from "../use-keys.ts";
import { isStalled } from "../view-model.ts";

interface ThreadCardProps {
    store: DocStore;
    thread: Thread;
    active: boolean;
    now: number;
    hold: boolean;
    onActivate: () => void;
    apply: ApplyControls;
}

export function ThreadCard({
    store,
    thread,
    active,
    now,
    hold,
    onActivate,
    apply,
}: ThreadCardProps): JSX.Element {
    const notice = apply.notice(thread);
    const stalled = isStalled(thread, now);
    const messages = active ? thread.messages : collapse(thread.messages);
    const pending = thread.suggestion?.status === "pending" ? thread.suggestion : undefined;

    return (
        <article
            class={`card${active ? " card-active" : ""}${thread.state === "resolved" ? " card-resolved" : ""}`}
            data-card={thread.id}
            onClick={active ? undefined : onActivate}
        >
            <header class="card-head">
                <StatePill thread={thread} stalled={stalled} />
                <span class="card-meta">
                    {thread.id} · {relativeTime(thread.lastActivity, now)}
                </span>
            </header>
            {thread.detached ? (
                <p class="card-detached">
                    <span>The quoted text is no longer in the doc.</span>
                    <s>{thread.anchor.exact}</s>
                </p>
            ) : null}
            {thread.followsEdit !== undefined ? (
                <p class="card-note">Follow-through on your edit</p>
            ) : null}
            <ol class="messages">
                {messages.map((message) =>
                    message === "more" ? (
                        <li key="more" class="messages-more">
                            {thread.messages.length - 2} more
                        </li>
                    ) : (
                        <li
                            key={message.seq}
                            class={message.by === "agent" ? "message message-agent" : "message"}
                        >
                            <span class="message-author">
                                {message.by === "agent" ? "Agent" : "You"}
                            </span>
                            <p>{message.text}</p>
                        </li>
                    ),
                )}
            </ol>
            {thread.state === "working" ? <Working stalled={stalled} /> : null}
            {pending ? (
                <div class="suggestion-box">
                    <span class="suggestion-label">
                        {pending.by === "agent" ? "Agent suggests an edit" : "Your suggested edit"}
                    </span>
                    <span class="suggestion-actions">
                        <button
                            type="button"
                            class="button button-accept"
                            onClick={() => apply.accept(thread)}
                        >
                            Accept <kbd>a</kbd>
                        </button>
                        <button
                            type="button"
                            class="button button-quiet"
                            onClick={() => void store.reject(thread.id)}
                        >
                            Reject <kbd>r</kbd>
                        </button>
                    </span>
                </div>
            ) : null}
            {thread.suggestion && !pending ? (
                <p class="card-note">Suggestion {thread.suggestion.status}</p>
            ) : null}
            {thread.applied ? (
                <div
                    class={thread.applied.reverted ? "applied-bar applied-reverted" : "applied-bar"}
                >
                    <span>
                        {thread.applied.reverted ? "Agent edit reverted" : "Changed by agent"}
                    </span>
                    {thread.applied.reverted ? null : (
                        <button
                            type="button"
                            class="button button-quiet"
                            onClick={() => apply.revert(thread)}
                        >
                            Revert
                        </button>
                    )}
                </div>
            ) : null}
            {notice ? (
                <p class="card-notice" role="alert">
                    {notice}
                </p>
            ) : null}
            {active ? (
                <CardActions
                    store={store}
                    thread={thread}
                    hold={hold}
                    pending={pending !== undefined}
                />
            ) : null}
        </article>
    );
}

function collapse<T>(messages: T[]): (T | "more")[] {
    if (messages.length <= 2) {
        return messages;
    }
    return [messages[0]!, "more", messages[messages.length - 1]!];
}

const stateLabels: Record<Thread["state"], string> = {
    draft: "Draft",
    open: "Open",
    working: "Agent working",
    replied: "Replied",
    resolved: "Resolved",
};

function StatePill({ thread, stalled }: { thread: Thread; stalled: boolean }): JSX.Element {
    if (thread.detached && thread.state !== "resolved") {
        return <span class="pill pill-detached">Detached</span>;
    }
    if (stalled) {
        return <span class="pill pill-stalled">Stalled</span>;
    }
    return <span class={`pill pill-${thread.state}`}>{stateLabels[thread.state]}</span>;
}

function Working({ stalled }: { stalled: boolean }): JSX.Element {
    return stalled ? (
        <p class="working working-stalled">No reply from the agent for over 10 minutes.</p>
    ) : (
        <p class="working">
            <span class="dots" aria-hidden="true">
                <span />
                <span />
                <span />
            </span>
            Agent is working on this
        </p>
    );
}

interface CardActionsProps {
    store: DocStore;
    thread: Thread;
    hold: boolean;
    pending: boolean;
}

function replyKey(id: ThreadId): string {
    return `margin:reply:${window.location.pathname}:${id}`;
}

/** Unsent reply text outlives the card collapsing (the thread losing focus) and a reload. */
function useReplyDraft(id: ThreadId): [string, (text: string) => void] {
    const [text, setText] = useState(() => recall(replyKey(id)) ?? "");
    const update = (next: string) => {
        setText(next);
        remember(replyKey(id), next || null);
    };
    return [text, update];
}

function CardActions({ store, thread, hold, pending }: CardActionsProps): JSX.Element {
    const [text, setText] = useReplyDraft(thread.id);
    const [focused, setFocused] = useState(false);
    const input = useRef<HTMLTextAreaElement>(null);
    const [sending, setSending] = useState(false);
    // The text and its stored draft go only once the request succeeds: a failure (daemon gone,
    // locked) leaves them for another try. The field is read-only meanwhile, so nothing typed
    // during the request is lost with it.
    const submit = async (post: (text: string) => Promise<void>) => {
        const trimmed = text.trim();
        if (!trimmed || sending) {
            return;
        }
        setSending(true);
        try {
            await post(trimmed);
            setText("");
        } catch {
            // The store reports the failure.
        } finally {
            setSending(false);
        }
    };
    const send = () => void submit(async (reply) => await store.reply(thread.id, reply));
    // Buttons act without first blurring the field, so the row does not jump under the pointer.
    const keepFocus = (event: MouseEvent) => event.preventDefault();
    if (thread.state === "resolved") {
        return (
            <div class="card-actions">
                <button
                    type="button"
                    class="button button-quiet"
                    onClick={() => void store.reopen(thread.id)}
                >
                    Reopen
                </button>
            </div>
        );
    }
    return (
        <div class="card-reply">
            <textarea
                ref={input}
                class={focused ? "reply-input" : "reply-input reply-input-collapsed"}
                rows={focused ? 3 : 1}
                placeholder={thread.state === "draft" ? "Add to your draft…" : "Reply…"}
                value={text}
                readOnly={sending}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onInput={(event) => setText(event.currentTarget.value)}
                onKeyDown={submitKeys(send, () => input.current?.blur())}
            />
            <div class="card-actions">
                <label
                    class="switch"
                    title="Let the agent apply its edits to this thread without review"
                >
                    <input
                        type="checkbox"
                        checked={thread.autoApply}
                        onChange={(event) =>
                            void store.setSetting(
                                "autoApply",
                                event.currentTarget.checked,
                                thread.id,
                            )
                        }
                    />
                    <span>Auto-apply</span>
                </label>
                <span class="card-actions-end">
                    {pending && text.trim() ? (
                        <button
                            type="button"
                            class="button button-quiet"
                            disabled={sending}
                            onMouseDown={keepFocus}
                            onClick={() =>
                                void submit(async (note) => await store.reject(thread.id, note))
                            }
                        >
                            Reject with note
                        </button>
                    ) : (
                        <button
                            type="button"
                            class="button button-quiet"
                            onClick={() => void store.resolve(thread.id)}
                        >
                            Resolve
                        </button>
                    )}
                    <button
                        type="button"
                        class="button"
                        disabled={!text.trim() || sending}
                        onMouseDown={keepFocus}
                        onClick={send}
                    >
                        {hold && thread.state === "draft" ? "Add" : "Reply"}
                    </button>
                </span>
            </div>
        </div>
    );
}
