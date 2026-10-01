import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { hashText } from "../../core/blocks.ts";
import type { DocSnapshot, DocStore, ThreadId, VerdictState } from "../../core/model.ts";
import { relativeTime } from "../time.ts";
import {
    reviewModel,
    unresolvedKinds,
    type ReviewModel,
    type UnresolvedKind,
} from "../view-model.ts";

export type ReviewTone = "open" | "approved" | "declined" | "finishing" | "ready";

/**
 * The control's label in two parts: a tight bar shows only `lead`, with `badge` standing in for
 * `rest` (a count, or a dot for "changed since"), and the narrowest only the mark and the badge.
 */
export interface ReviewLabel {
    tone: ReviewTone;
    lead: string;
    rest: string;
    badge?: string;
}

export function reviewLabel(model: ReviewModel): ReviewLabel {
    if (model.state === "approved") {
        return model.changed
            ? { tone: "approved", lead: "Approved", rest: ", changed since", badge: "" }
            : { tone: "approved", lead: "Approved", rest: "" };
    }
    if (model.state === "declined") {
        return { tone: "declined", lead: "Declined", rest: "" };
    }
    // Only threads the agent still has: one it answered without resolving waits on the user.
    const waiting = model.finish?.waiting ?? 0;
    if (waiting > 0) {
        return {
            tone: "finishing",
            lead: "Resolving",
            rest: `, ${waiting} left`,
            badge: String(waiting),
        };
    }
    if (model.finish && model.unresolved.length === 0) {
        return { tone: "ready", lead: "Ready", rest: " to approve" };
    }
    return { tone: "open", lead: "Review", rest: "" };
}

export function labelText(label: ReviewLabel): string {
    return label.lead + label.rest;
}

function count(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

const kindLine: Record<UnresolvedKind, (n: number) => string> = {
    agent: (n) => `${count(n, "comment")} waiting on agent`,
    user: (n) => `${count(n, "agent reply", "agent replies")} waiting on you`,
    suggestion: (n) => count(n, "pending suggestion"),
    draft: (n) => count(n, "held draft"),
};

/** The unresolved count in plain words, one line per kind present. */
export function kindLines(counts: Record<UnresolvedKind, number>): string[] {
    return unresolvedKinds
        .filter((kind) => counts[kind] > 0)
        .map((kind) => kindLine[kind](counts[kind]));
}

export function unresolvedHead(total: number): string {
    return `You have ${count(total, "unresolved thread")}`;
}

export function unresolvedSubhead(total: number): string {
    return `Decide how to handle ${total === 1 ? "it" : "them"} before approving`;
}

export function finishOutcome(accepted: number, handed: number): string {
    const parts = [
        ...(accepted > 0 ? [`Accepted ${count(accepted, "suggestion")}.`] : []),
        ...(handed > 0 ? [`Sent ${count(handed, "thread")} to agent.`] : []),
    ];
    return parts.length > 0 ? parts.join(" ") : "Nothing was left to send.";
}

export function unappliedLine(n: number): string {
    return `${count(n, "suggestion")} could not be applied and went to agent`;
}

export function asIsWarning(total: number): string {
    return `Closes ${total === 1 ? "the thread" : `the ${total} threads`} without action. Pending suggestions are not applied.`;
}

/**
 * Whether "Let agent resolve" is offered. Asking again does nothing while every unresolved
 * thread is already the agent's to finish; the path comes back once one is waiting on the user,
 * held, or new.
 */
export function canAskToFinish(model: ReviewModel): boolean {
    const total = model.unresolved.length;
    const handedOver = model.finish?.remaining === total && model.counts.agent === total;
    return total > 0 && !handedOver;
}

export interface VerdictAction {
    label: string;
    /** The status the button sets. */
    state: VerdictState;
    icon: "check" | "slash" | "reopen";
    look: "accept" | "danger" | "primary";
    /** Shown in its place but not available: Approve while threads are unresolved. */
    disabled?: true;
}

/**
 * The verdict buttons in the order they show and take focus: the positive or primary one first,
 * as a thread card puts Accept before Reject. A doc with a verdict only reopens; approving and
 * declining are done from the open state, where Approve keeps its place but is disabled while
 * threads are unresolved.
 */
export function verdictActions(model: ReviewModel): VerdictAction[] {
    if (model.state !== "open") {
        return [{ label: "Reopen", state: "open", icon: "reopen", look: "primary" }];
    }
    return [
        {
            label: "Approve",
            state: "approved",
            icon: "check",
            look: "accept",
            ...(model.unresolved.length > 0 ? { disabled: true as const } : {}),
        },
        { label: "Decline", state: "declined", icon: "slash", look: "danger" },
    ];
}

/** The line that says why Approve is disabled; the button points at it. */
const WHY_NOT_ID = "review-why-not";

/** The server refuses a longer note. */
const NOTE_MAX = 200;

type Panel =
    | { kind: "closed" }
    | { kind: "main" }
    /** "Approve as-is" was clicked; the next click closes the threads. */
    | { kind: "confirm" }
    /** An approval the store refused: a thread arrived between the render and the click. */
    | { kind: "refused"; count: number }
    /** What a finish request did; `unapplied` only comes back in its result. */
    | { kind: "result"; accepted: number; handed: number; unapplied: ThreadId[] };

interface ReviewMenuProps {
    store: DocStore;
    snapshot: DocSnapshot;
    now: number;
    /** Where "Review one by one" starts. */
    first: ThreadId | undefined;
    /** No agent is watching the doc, so a finish request would wait for one. */
    agentAway: boolean;
    onSelectThread: (id: ThreadId) => void;
}

export function ReviewMenu(props: ReviewMenuProps): JSX.Element {
    const { store, snapshot } = props;
    const [panel, setPanel] = useState<Panel>({ kind: "closed" });
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const root = useRef<HTMLSpanElement>(null);
    const toggle = useRef<HTMLButtonElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const confirm = useRef<HTMLButtonElement>(null);
    const { source } = snapshot.doc;
    const hash = useMemo(() => hashText(source), [source]);
    const model = reviewModel(snapshot, hash);
    const label = reviewLabel(model);
    const open = panel.kind !== "closed";

    useEffect(() => {
        if (!open) {
            return;
        }
        const close = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) {
                setPanel({ kind: "closed" });
            }
        };
        document.addEventListener("pointerdown", close);
        return () => document.removeEventListener("pointerdown", close);
    }, [open]);

    // Each view replaces the controls of the one before, so focus moves with it: to the confirming
    // button, else to the dialog itself, where Escape still reaches it.
    useEffect(() => {
        if (panel.kind === "confirm") {
            confirm.current?.focus();
        } else if (panel.kind !== "closed") {
            dialog.current?.focus();
        }
    }, [panel.kind]);

    const close = () => {
        setPanel({ kind: "closed" });
        toggle.current?.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if (open && event.key === "Escape") {
            // The page's own Escape (deselect) must not also fire.
            event.stopPropagation();
            close();
        }
    };

    const run = async (action: () => Promise<Panel>) => {
        setBusy(true);
        try {
            const next = await action();
            setPanel(next);
            if (next.kind === "closed") {
                toggle.current?.focus();
            }
        } catch {
            // The store reports the failure in the bar's toast; the popover stays as it was.
        } finally {
            setBusy(false);
        }
    };
    const setVerdict = (state: VerdictState, asIs = false) =>
        void run(async () => {
            const text = note.trim();
            const result = await store.setVerdict({
                state,
                ...(text && state !== "open" ? { note: text } : {}),
                ...(asIs ? { asIs: true } : {}),
            });
            if (!result.ok) {
                return { kind: "refused", count: result.ids.length };
            }
            setNote("");
            return { kind: "closed" };
        });
    const askToFinish = () =>
        void run(async () => {
            const { accepts } = model;
            const result = await store.requestFinish();
            return {
                kind: "result",
                accepted: Math.max(0, accepts - result.unapplied.length),
                handed: result.ids.length,
                unapplied: result.unapplied,
            };
        });
    const show = (id: ThreadId) => {
        setPanel({ kind: "closed" });
        props.onSelectThread(id);
    };

    const noteField = (
        <textarea
            class="review-note"
            rows={2}
            aria-label="Note for agent (optional)"
            placeholder="Note for agent (optional)"
            maxLength={NOTE_MAX}
            value={note}
            onInput={(event) => setNote(event.currentTarget.value)}
        />
    );
    const total = model.unresolved.length;

    const body = (): JSX.Element | null => {
        switch (panel.kind) {
            case "closed":
                return null;
            case "result":
                return (
                    <>
                        <p class="review-head">{finishOutcome(panel.accepted, panel.handed)}</p>
                        {panel.unapplied.length > 0 ? (
                            <div class="review-unapplied">
                                <p class="review-line">{unappliedLine(panel.unapplied.length)}</p>
                                {panel.unapplied.map((id) => (
                                    <button
                                        key={id}
                                        type="button"
                                        class="link-button"
                                        onClick={() => show(id)}
                                    >
                                        {panel.unapplied.length === 1 ? "Show it" : `Show ${id}`}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                        {props.agentAway && panel.handed > 0 ? (
                            <p class="review-quiet">No agent is watching this doc right now.</p>
                        ) : null}
                    </>
                );
            case "confirm":
                return (
                    <>
                        <p class="review-head">Approve as-is?</p>
                        <p class="review-line">{asIsWarning(total)}</p>
                        {noteField}
                        <div class="review-actions">
                            <button
                                type="button"
                                class="button button-accept"
                                ref={confirm}
                                disabled={busy || total === 0}
                                onClick={() => setVerdict("approved", true)}
                            >
                                <Mark kind="check" />
                                Close {count(total, "thread")} and approve
                            </button>
                            <button
                                type="button"
                                class="button button-quiet"
                                onClick={() => setPanel({ kind: "main" })}
                            >
                                Cancel
                            </button>
                        </div>
                    </>
                );
            case "refused":
            case "main":
                break;
        }
        if (model.verdict) {
            return <Standing model={model} now={props.now} busy={busy} setVerdict={setVerdict} />;
        }
        const refused =
            panel.kind === "refused" ? (
                <p class="review-notice">
                    A thread came in. {count(panel.count, "thread")}{" "}
                    {panel.count === 1 ? "is" : "are"} unresolved.
                </p>
            ) : null;
        if (total === 0) {
            return (
                <>
                    {refused}
                    <div class="review-intro">
                        <p class="review-head">Add your review decision</p>
                        <p class="review-line">All threads are resolved or closed</p>
                    </div>
                    {noteField}
                    <VerdictButtons
                        actions={verdictActions(model)}
                        busy={busy}
                        onPick={setVerdict}
                    />
                </>
            );
        }
        const { first } = props;
        return (
            <>
                {refused}
                <div class="review-intro">
                    <p class="review-head">{unresolvedHead(total)}</p>
                    <p class="review-line" id={WHY_NOT_ID}>
                        {unresolvedSubhead(total)}
                    </p>
                </div>
                <ul class="review-kinds">
                    {kindLines(model.counts).map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
                <div class="review-paths">
                    <Path
                        title="Approve as-is"
                        detail="Open threads are closed without action"
                        onClick={() => setPanel({ kind: "confirm" })}
                    />
                    {first ? (
                        <Path
                            title="Review one by one"
                            detail={
                                <>
                                    Use <kbd>j</kbd> and <kbd>k</kbd> to step through
                                </>
                            }
                            onClick={() => show(first)}
                        />
                    ) : null}
                    {canAskToFinish(model) ? (
                        <Path
                            title="Let agent resolve"
                            detail="They'll apply your feedback before you approve"
                            quiet={
                                props.agentAway
                                    ? "No agent is watching this doc right now."
                                    : undefined
                            }
                            disabled={busy}
                            onClick={askToFinish}
                        />
                    ) : null}
                </div>
                {noteField}
                <VerdictButtons actions={verdictActions(model)} busy={busy} onPick={setVerdict} />
            </>
        );
    };

    return (
        <span class="review" ref={root} onKeyDown={onKeyDown}>
            <button
                type="button"
                class={`review-toggle review-${label.tone}`}
                aria-expanded={open}
                aria-haspopup="dialog"
                ref={toggle}
                onClick={() => setPanel(open ? { kind: "closed" } : { kind: "main" })}
            >
                <ToneMark tone={label.tone} />
                <span>
                    <span class="review-lead">{label.lead}</span>
                    {label.rest ? <span class="review-rest">{label.rest}</span> : null}
                </span>
                {label.badge !== undefined ? (
                    <span class="review-badge" aria-hidden="true">
                        {label.badge}
                    </span>
                ) : null}
            </button>
            <span class="visually-hidden" role="status" aria-live="polite">
                {labelText(label)}
            </span>
            {open ? (
                <div
                    class="popover review-popover"
                    role="dialog"
                    aria-label="Review"
                    tabIndex={-1}
                    ref={dialog}
                >
                    {body()}
                </div>
            ) : null}
        </span>
    );
}

/** The popover once a verdict stands: what was decided, and the ways out of it. */
function Standing({
    model,
    now,
    busy,
    setVerdict,
}: {
    model: ReviewModel;
    now: number;
    busy: boolean;
    setVerdict: (state: VerdictState) => void;
}): JSX.Element | null {
    const { verdict } = model;
    if (!verdict) {
        return null;
    }
    const approved = verdict.state === "approved";
    const closed = verdict.closed?.length ?? 0;

    return (
        <>
            <p class="review-head">
                {approved ? "Approved" : "Declined"} {relativeTime(verdict.at, now)}
            </p>
            {verdict.note ? <p class="review-quote">{verdict.note}</p> : null}
            {approved ? (
                <p class="review-line">
                    {model.changed
                        ? "The doc has changed since."
                        : "The doc has not changed since."}
                </p>
            ) : null}
            {closed > 0 ? (
                <p class="review-line">
                    {count(closed, "thread")} {closed === 1 ? "was" : "were"} closed without action.
                </p>
            ) : null}
            <VerdictButtons actions={verdictActions(model)} busy={busy} onPick={setVerdict} />
        </>
    );
}

function Path(props: {
    title: string;
    detail: ComponentChildren;
    quiet?: string;
    disabled?: boolean;
    onClick: () => void;
}): JSX.Element {
    return (
        <button type="button" class="review-path" disabled={props.disabled} onClick={props.onClick}>
            <strong>{props.title}</strong>
            <small>{props.detail}</small>
            {props.quiet ? <small class="review-path-quiet">{props.quiet}</small> : null}
        </button>
    );
}

type MarkKind = VerdictAction["icon"];

const markPaths: Record<MarkKind, string> = {
    check: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5zM5.25 8.25l2 2 3.5-4",
    slash: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5zM3.6 3.6l8.8 8.8",
    reopen: "M2.75 8a5.25 5.25 0 1 0 1.7-3.85M2.5 2v3h3",
};

function Mark({ kind }: { kind: MarkKind }): JSX.Element {
    return (
        <svg class="review-mark" viewBox="0 0 16 16" aria-hidden="true">
            <path d={markPaths[kind]} />
        </svg>
    );
}

function ToneMark({ tone }: { tone: ReviewTone }): JSX.Element {
    return tone === "finishing" ? (
        <span class="review-dot" aria-hidden="true" />
    ) : (
        <Mark kind={tone === "declined" ? "slash" : "check"} />
    );
}

const lookClass: Record<VerdictAction["look"], string> = {
    accept: "button button-accept",
    danger: "button button-danger-quiet",
    primary: "button",
};

function VerdictButtons({
    actions,
    busy,
    onPick,
}: {
    actions: VerdictAction[];
    busy: boolean;
    onPick: (state: VerdictState) => void;
}): JSX.Element {
    return (
        <div class="review-actions">
            {actions.map((action) => (
                <button
                    key={action.label}
                    type="button"
                    class={lookClass[action.look]}
                    disabled={busy}
                    // Not `disabled`: the button stays in the tab order, so a screen reader reaches
                    // it and reads the line that says why.
                    aria-disabled={action.disabled}
                    aria-describedby={action.disabled ? WHY_NOT_ID : undefined}
                    onClick={action.disabled ? undefined : () => onPick(action.state)}
                >
                    <Mark kind={action.icon} />
                    {action.label}
                </button>
            ))}
        </div>
    );
}
