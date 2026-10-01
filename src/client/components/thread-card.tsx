import type { JSX } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import type { DocStore, Message, Suggestion, Thread, ThreadId } from "../../core/model.ts";
import { recall, remember } from "../storage.ts";
import { relativeTime } from "../time.ts";
import type { ApplyControls } from "../use-apply.ts";
import { submitKeys } from "../use-keys.ts";
import { MessageBody } from "../render/message.tsx";
import { needsDeleteConfirm, threadStatus, type ThreadStatus } from "../view-model.ts";
import { agentTipLine } from "./agent-chip.tsx";
import { AgentMark } from "./agent-marks.tsx";
import { CardHead } from "./card-head.tsx";
import { authorLabel, suggestionLabel, summarize } from "./thread-summary.ts";
import { Tooltip } from "./tooltip.tsx";

interface ThreadCardProps {
    store: DocStore;
    thread: Thread;
    active: boolean;
    now: number;
    hold: boolean;
    onActivate: () => void;
    /** Collapses the card again from its header; without it the header only expands. */
    onDeactivate?: () => void;
    /** Off, the card is always expanded (the doc notes panel); on, it collapses while inactive. */
    collapsible?: boolean;
    apply: ApplyControls;
    /** The doc view's link handler, so message links behave like links in the doc. */
    followLink: (event: MouseEvent, url: string) => void;
}

export function ThreadCard({
    store,
    thread,
    active,
    now,
    hold,
    onActivate,
    onDeactivate,
    collapsible = true,
    apply,
    followLink,
}: ThreadCardProps): JSX.Element {
    const notice = apply.notice(thread);
    const status = threadStatus(thread, now);
    const stalled = status === "stalled";
    const pending = thread.suggestion?.status === "pending" ? thread.suggestion : undefined;
    const expanded = active || !collapsible;
    const classes = [
        "card",
        active ? "card-active" : expanded ? "" : "card-collapsed",
        thread.state === "resolved" ? "card-resolved" : "",
    ]
        .filter(Boolean)
        .join(" ");
    // A collapsed card's click bubbles to the card's own activation; the expanded header
    // collapses it again.
    return (
        <article class={classes} data-card={thread.id} onClick={active ? undefined : onActivate}>
            <CardHead
                expanded={expanded}
                interactive={collapsible}
                onToggle={active ? onDeactivate : undefined}
                pill={<span class={`pill pill-${status}`}>{statusLabels[status]}</span>}
                meta={`${thread.id} · ${relativeTime(thread.lastActivity, now)}`}
                summary={collapsible ? <Summary thread={thread} stalled={stalled} /> : undefined}
            />
            {expanded ? (
                <Body
                    thread={thread}
                    pending={pending}
                    stalled={stalled}
                    apply={apply}
                    followLink={followLink}
                    store={store}
                />
            ) : null}
            {notice ? (
                <p class="card-notice" role="alert">
                    {notice}
                </p>
            ) : null}
            {expanded ? (
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

function Summary({ thread, stalled }: { thread: Thread; stalled: boolean }): JSX.Element {
    // Keyed on what the summary reads: every snapshot brings new thread objects, and the preview
    // parses the last message's markdown.
    const last = thread.messages[thread.messages.length - 1];
    const summary = useMemo(
        () => summarize(thread),
        [last?.text, last?.by, thread.suggestion?.by, thread.anchor?.exact],
    );
    return (
        <>
            {summary.speaker ? <span class="card-speaker">{summary.speaker}</span> : null}
            <span class="card-preview">
                {summary.preview}
                {thread.state === "working" && !stalled ? (
                    <>
                        {" "}
                        <Dots />
                    </>
                ) : null}
            </span>
        </>
    );
}

/**
 * "Agent" or "You". An agent message that recorded who wrote it shows the name and client on
 * hover or focus, so the chip in the bar and the replies read as one speaker.
 */
function AuthorLabel({ message }: { message: Message }): JSX.Element {
    const label = authorLabel(message.by);
    const { agent } = message;
    if (!agent) {
        return <span class="message-author">{label}</span>;
    }
    return (
        <Tooltip
            align="start"
            text={
                <span class="tip-agent">
                    <AgentMark client={agent.client} />
                    {agentTipLine(agent)}
                </span>
            }
        >
            {(tip) => (
                <span class="message-author" tabIndex={0} aria-describedby={tip}>
                    {label}
                </span>
            )}
        </Tooltip>
    );
}

interface BodyProps {
    store: DocStore;
    thread: Thread;
    pending: Suggestion | undefined;
    stalled: boolean;
    apply: ApplyControls;
    followLink: (event: MouseEvent, url: string) => void;
}

/** Everything between the header and the reply box: the quote, the messages, the suggestion. */
function Body({ store, thread, pending, stalled, apply, followLink }: BodyProps): JSX.Element {
    const { messages } = thread;
    return (
        <>
            {thread.detached ? (
                <p class="card-detached">
                    <span>The quoted text is no longer in the doc.</span>
                    <s>{thread.anchor?.exact}</s>
                </p>
            ) : null}
            {thread.followsEdit !== undefined ? (
                <p class="card-note">Follow-through on your edit</p>
            ) : null}
            <ol class="messages">
                {messages.map((message) => (
                    <li
                        key={message.seq}
                        class={message.by === "agent" ? "message message-agent" : "message"}
                    >
                        <AuthorLabel message={message} />
                        <MessageBody text={message.text} followLink={followLink} />
                    </li>
                ))}
            </ol>
            {thread.state === "working" ? <Working stalled={stalled} /> : null}
            {pending ? (
                <div class="suggestion-box">
                    <span class="suggestion-label">{suggestionLabel(pending.by)}</span>
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
        </>
    );
}

const statusLabels: Record<ThreadStatus, string> = {
    draft: "Draft",
    open: "Open",
    notified: "Agent notified",
    working: "Agent responding",
    replied: "Replied",
    resolved: "Resolved",
    detached: "Detached",
    stalled: "Stalled",
};

function Working({ stalled }: { stalled: boolean }): JSX.Element {
    return stalled ? (
        <p class="working working-stalled">No reply from the agent for over 10 minutes.</p>
    ) : (
        <p class="working">
            <Dots />
            Agent is responding
        </p>
    );
}

function Dots(): JSX.Element {
    return (
        <span class="dots" aria-hidden="true">
            <span />
            <span />
            <span />
        </span>
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
    const [confirming, setConfirming] = useState(false);
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
    const remove = () => void store.deleteThread(thread.id);
    const requestDelete = () => (needsDeleteConfirm(thread) ? setConfirming(true) : remove());
    const deleteButton = (
        <button
            type="button"
            class="button button-quiet"
            onMouseDown={keepFocus}
            onClick={requestDelete}
        >
            Delete
        </button>
    );
    if (confirming) {
        return (
            <div class="card-confirm" role="group" aria-label="Confirm delete">
                <span>Delete this thread?</span>
                <span class="card-actions-end">
                    <button
                        type="button"
                        class="button button-quiet"
                        onClick={() => setConfirming(false)}
                    >
                        Cancel
                    </button>
                    <button type="button" class="button button-danger" onClick={remove}>
                        Delete
                    </button>
                </span>
            </div>
        );
    }
    if (thread.state === "resolved") {
        return (
            <div class="card-actions">
                {deleteButton}
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
                <span class="card-actions-end">
                    {deleteButton}
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
