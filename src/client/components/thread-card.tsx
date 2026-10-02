import type { JSX } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import type {
    DocStore,
    Message,
    Suggestion,
    Thread,
    ThreadId,
    ThreadState,
} from "../../core/model.ts";
import { recall, remember } from "../storage.ts";
import { relativeTime } from "../time.ts";
import type { ApplyControls } from "../use-apply.ts";
import { submitKeys } from "../use-keys.ts";
import { MessageBody } from "../render/message.tsx";
import { needsDeleteConfirm, threadStatus, type ThreadStatus } from "../view-model.ts";
import { agentTipLine } from "./agent-chip.tsx";
import { AgentMark } from "./agent-marks.tsx";
import { CardHead } from "./card-head.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { authorLabel, suggestionLabel, summarize } from "./thread-summary.ts";
import { Tooltip } from "./tooltip.tsx";

interface ThreadCardProps {
    store: DocStore;
    thread: Thread;
    active: boolean;
    now: number;
    hold: boolean;
    /** Just handed to a watching agent: reads as being answered ahead of the agent's claim. */
    eager?: boolean;
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
    eager = false,
    onActivate,
    onDeactivate,
    collapsible = true,
    apply,
    followLink,
}: ThreadCardProps): JSX.Element {
    const notice = apply.notice(thread);
    const status = threadStatus(thread, now, eager);
    const stalled = status === "stalled";
    // The pill and the dots always agree: both follow the status, not the thread's own state.
    const responding = status === "working" || stalled;
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
                summary={
                    collapsible ? (
                        <Summary thread={thread} responding={responding && !stalled} />
                    ) : undefined
                }
            />
            {expanded ? (
                <Body
                    thread={thread}
                    pending={pending}
                    responding={responding}
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

function Summary({ thread, responding }: { thread: Thread; responding: boolean }): JSX.Element {
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
                {responding ? (
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
    responding: boolean;
    stalled: boolean;
    apply: ApplyControls;
    followLink: (event: MouseEvent, url: string) => void;
}

/** Everything between the header and the reply box: the quote, the messages, the suggestion. */
function Body({
    store,
    thread,
    pending,
    responding,
    stalled,
    apply,
    followLink,
}: BodyProps): JSX.Element {
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
            {responding ? <Working stalled={stalled} /> : null}
            {pending ? (
                <div class="suggestion-box">
                    <span class="suggestion-label">{suggestionLabel(pending.by)}</span>
                    <span class="suggestion-actions">
                        <ActionButton
                            action={suggestionActions.accept}
                            onClick={() => apply.accept(thread)}
                        />
                        <ActionButton
                            action={suggestionActions.reject}
                            onClick={() => void store.reject(thread.id)}
                        />
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
                        <ActionButton action={revertAction} onClick={() => apply.revert(thread)} />
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
        <p class="working working-stalled">Agent has not replied for over 10 minutes.</p>
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
    const row = cardRow({
        state: thread.state,
        hold,
        pending,
        hasText: text.trim() !== "",
        confirming,
    });
    const controls: Record<RowActionId, ButtonControls> = {
        delete: { onClick: requestDelete, onMouseDown: keepFocus },
        cancel: { onClick: () => setConfirming(false) },
        confirmDelete: { onClick: remove },
        reopen: { onClick: () => void store.reopen(thread.id) },
        resolve: { onClick: () => void store.resolve(thread.id) },
        rejectWithNote: {
            onClick: () => void submit(async (note) => await store.reject(thread.id, note)),
            onMouseDown: keepFocus,
            disabled: sending,
        },
        send: { onClick: send, onMouseDown: keepFocus, disabled: !text.trim() || sending },
    };
    const buttons = row.map((action) => (
        <ActionButton key={action.id} action={action} {...controls[action.id]} />
    ));
    if (confirming) {
        return (
            <div class="card-confirm" role="group" aria-label="Confirm delete">
                <span>Delete this thread?</span>
                <span class="card-actions-end">{buttons}</span>
            </div>
        );
    }
    if (thread.state === "resolved") {
        return <div class="card-actions">{buttons}</div>;
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
                <span class="card-actions-end">{buttons}</span>
            </div>
        </div>
    );
}

/**
 * How a button reads at a glance. Three looks fill the button (primary, accept, danger) and a row
 * holds one of those at most; the rest are outlines.
 */
export type ActionLook =
    "primary" | "accept" | "accept-quiet" | "danger" | "danger-quiet" | "danger-soft" | "neutral";

const lookClass: Record<ActionLook, string> = {
    primary: "button",
    accept: "button button-accept",
    "accept-quiet": "button button-accept-quiet",
    danger: "button button-danger",
    "danger-quiet": "button button-danger-quiet",
    "danger-soft": "button button-quiet button-danger-soft",
    neutral: "button button-quiet",
};

export function isFilled(look: ActionLook): boolean {
    return look === "primary" || look === "accept" || look === "danger";
}

export interface CardAction<Id extends string = string> {
    id: Id;
    label: string;
    icon?: IconName;
    look: ActionLook;
    /** The shortcut shown in the button. */
    key?: string;
}

/** Accept leads, as Approve does in the review control, and Reject is its Decline. */
export const suggestionActions = {
    accept: { id: "accept", label: "Accept", icon: "check", look: "accept", key: "a" },
    reject: { id: "reject", label: "Reject", icon: "slash", look: "danger-quiet", key: "r" },
} satisfies Record<string, CardAction>;

export const revertAction: CardAction = {
    id: "revert",
    label: "Revert",
    icon: "undo",
    look: "neutral",
};

export type RowActionId =
    "delete" | "cancel" | "confirmDelete" | "reopen" | "resolve" | "rejectWithNote" | "send";

export interface CardRowState {
    state: ThreadState;
    /** Comments are held, so a draft's button adds to it instead of sending. */
    hold: boolean;
    /** The thread has a pending suggestion. */
    pending: boolean;
    hasText: boolean;
    confirming: boolean;
}

/** The buttons under a card, in the order they show. */
export function cardRow(row: CardRowState): CardAction<RowActionId>[] {
    if (row.confirming) {
        return [
            { id: "cancel", label: "Cancel", look: "neutral" },
            { id: "confirmDelete", label: "Delete", icon: "trash", look: "danger" },
        ];
    }
    // Soft, not outlined in red: every open card shows it, and a confirm or an undo follows.
    const remove: CardAction<RowActionId> = {
        id: "delete",
        label: "Delete",
        icon: "trash",
        look: "danger-soft",
    };
    if (row.state === "resolved") {
        return [remove, { id: "reopen", label: "Reopen", icon: "reopen", look: "neutral" }];
    }
    // "Reject with note" goes without an icon: with one, the row is wider than the narrowest card.
    return [
        remove,
        row.pending && row.hasText
            ? { id: "rejectWithNote", label: "Reject with note", look: "danger-quiet" }
            : { id: "resolve", label: "Resolve", icon: "check", look: "accept-quiet" },
        row.hold && row.state === "draft"
            ? { id: "send", label: "Add", icon: "plus", look: "primary" }
            : { id: "send", label: "Reply", icon: "send", look: "primary" },
    ];
}

interface ButtonControls {
    onClick: () => void;
    onMouseDown?: (event: MouseEvent) => void;
    disabled?: boolean;
}

function ActionButton({
    action,
    ...controls
}: { action: CardAction } & ButtonControls): JSX.Element {
    return (
        <button type="button" class={lookClass[action.look]} {...controls}>
            {action.icon ? <Icon name={action.icon} /> : null}
            {action.label}
            {action.key ? <kbd>{action.key}</kbd> : null}
        </button>
    );
}
