import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { clientName } from "../../core/agent.ts";
import type { AgentIdentity, ThreadId } from "../../core/model.ts";
import { copyText } from "../clipboard.ts";
import { reducedMotion } from "../motion.ts";
import { AgentMark } from "./agent-marks.tsx";
import type { DocLocation } from "./doc-name.tsx";
import { inGrace, shownAgents, type PresenceState } from "./presence.ts";
import { Tooltip } from "./tooltip.tsx";

/** How long the copied confirmation shows. */
const COPIED_MS = 1_800;
/** A clipboard call that never settles (a host with no permission prompt) counts as refused. */
const COPY_WAIT_MS = 1_000;
/** The flash when the chip changes state. */
const PULSE_MS = 600;

export type AgentChipKind =
    /** At least one agent is here (or left within the grace period). */
    | "connected"
    /** Here, but a working thread has gone quiet. */
    | "stalled"
    /** Every agent that was here has been gone past the grace period. */
    | "disconnected"
    /** No agent has been here since the page loaded. */
    | "none"
    /** The daemon link is down; the last known state, frozen. */
    | "offline";

export interface AgentChipModel {
    kind: AgentChipKind;
    /** The agents the chip stands for, first one named. */
    agents: AgentIdentity[];
    label: string;
    /** How many agents beyond the first. */
    extra: number;
    stalled: ThreadId[];
}

export function agentChipFor(
    state: PresenceState,
    stalled: ThreadId[],
    now: number,
): AgentChipModel {
    const agents = shownAgents(state);
    const label = agents[0]?.name ?? "No agent";
    const extra = Math.max(0, agents.length - 1);
    const base = { agents, label, extra, stalled };
    if (state.connection !== "live") {
        return { ...base, kind: "offline" };
    }
    if (state.present.length > 0 || inGrace(state, now)) {
        return { ...base, kind: stalled.length > 0 ? "stalled" : "connected" };
    }
    return { ...base, kind: state.everWatching ? "disconnected" : "none" };
}

/** What the disconnected chip copies: a line the user pastes to their agent. */
export function agentMessage(location: DocLocation): string {
    const name = location.relativePath || location.path.split("/").pop() || location.path;
    return `Please watch my margin review of ${name}: run \`margin watch ${location.path}\` under Monitor (see \`margin agent-help\`) and answer my comments in the doc.`;
}

/** One agent's tooltip line: its name, then its client unless the name already says it. */
export function agentTipLine(agent: AgentIdentity): string {
    const client = clientName(agent.client);
    return agent.name.toLowerCase() === client.toLowerCase()
        ? agent.name
        : `${agent.name} · ${client}`;
}

/** The tooltip's lines: every agent with its client, then what the state means. */
export function chipTipLines(model: AgentChipModel): string[] {
    const lines = model.agents.map(agentTipLine);
    switch (model.kind) {
        case "stalled":
            lines.push(`Stalled on ${model.stalled.join(", ")}`);
            break;
        case "disconnected":
            lines.push("Agent disconnected. Click to copy a message for your agent.");
            break;
        case "none":
            lines.push("No agent connected. Click to copy a message for your agent.");
            break;
        case "offline":
            lines.push("Disconnected from margin · reconnecting");
            lines.push("If this persists, run margin on the file again or reload the page");
            break;
        default:
            break;
    }
    return lines;
}

interface AgentChipProps {
    model: AgentChipModel;
    location: DocLocation;
    /** Selects and scrolls to a thread; the stalled chip uses it. */
    onSelectThread: (id: ThreadId) => void;
}

/** A change of state after the first one the page showed. */
export function shouldPulse(previous: AgentChipKind | null, next: AgentChipKind): boolean {
    return previous !== null && previous !== next;
}

/** One sentence a screen reader hears when the chip changes state: the state and who it is about. */
export function chipStatusLine(model: AgentChipModel): string {
    const who = model.extra > 0 ? `${model.label} and ${model.extra} more` : model.label;
    switch (model.kind) {
        case "connected":
            return `${who} connected`;
        case "stalled":
            return `${who} stalled on ${model.stalled.join(", ")}`;
        case "disconnected":
            return `${who} disconnected`;
        case "none":
            return "No agent connected";
        case "offline":
            return "Disconnected from margin, reconnecting";
    }
}

/**
 * The page's only connection indicator: the agent's mark and name beside the filename, "+N" for
 * more, tinted by state. Amber when nobody is here (a click copies the message for your agent)
 * or when a reply has stalled (the tooltip lists the threads); red when the daemon link is down.
 * Each change of state flashes a ring in the new colour.
 */
export function AgentChip(props: AgentChipProps): JSX.Element {
    const { model } = props;
    const root = useStatePulse(model.kind);
    const status = useStatusLine(model);
    const tip = (
        <span class="tip-lines">
            {chipTipLines(model).map((line, i) => (
                <span key={i}>
                    {i < model.agents.length ? (
                        <AgentMark client={model.agents[i]!.client} />
                    ) : null}
                    {line}
                </span>
            ))}
        </span>
    );
    const content = (
        <>
            <AgentMark client={model.agents[0]?.client ?? "unknown"} size={14} />
            <span class="agent-chip-name">{model.label}</span>
            {model.extra > 0 ? <span class="agent-chip-extra">+{model.extra}</span> : null}
        </>
    );
    const [first] = model.stalled;
    return (
        <span class={`agent-chip agent-chip-${model.kind}`} ref={root}>
            <Tooltip align="start" text={tip}>
                {(tipId) => {
                    switch (model.kind) {
                        case "disconnected":
                        case "none":
                            // The label already names who left and what a click does, so the
                            // tip, which says the same, is not also its description.
                            return (
                                <CopyMessage
                                    location={props.location}
                                    label={`${chipStatusLine(model)}. Click to copy a message for your agent`}
                                >
                                    {content}
                                </CopyMessage>
                            );
                        case "stalled":
                            return (
                                <button
                                    type="button"
                                    class="agent-chip-button"
                                    aria-label={`Agent stalled on ${model.stalled.join(", ")}. Click to show the thread`}
                                    aria-describedby={tipId}
                                    onClick={() => first && props.onSelectThread(first)}
                                >
                                    {content}
                                </button>
                            );
                        default:
                            return (
                                <span class="agent-chip-text" tabIndex={0} aria-describedby={tipId}>
                                    {content}
                                </span>
                            );
                    }
                }}
            </Tooltip>
            <span class="visually-hidden" role="status" aria-live="polite">
                {status}
            </span>
        </span>
    );
}

/**
 * The live region's text: empty until the state changes, then the line for the new state. The
 * region is always in the tree, since one mounted with its text is often not announced. The
 * first state is what the page loaded with and needs no announcement; the grace period before
 * `disconnected` is already in the model, so a Monitor re-arm gap stays silent.
 */
function useStatusLine(model: AgentChipModel): string {
    const [status, setStatus] = useState("");
    const previous = useRef<AgentChipKind | null>(null);
    useEffect(() => {
        if (shouldPulse(previous.current, model.kind)) {
            setStatus(chipStatusLine(model));
        }
        previous.current = model.kind;
    }, [model.kind]);
    return status;
}

/**
 * Rings the pill once in its new state's colour. An animation rather than a class, so a second
 * change mid-flash restarts it; reduced motion keeps only the colour change.
 */
function useStatePulse(kind: AgentChipKind): { current: HTMLSpanElement | null } {
    const root = useRef<HTMLSpanElement>(null);
    const previous = useRef<AgentChipKind | null>(null);
    useLayoutEffect(() => {
        const from = previous.current;
        previous.current = kind;
        const pill = root.current?.querySelector<HTMLElement>(
            ".agent-chip-text, .agent-chip-button",
        );
        if (!shouldPulse(from, kind) || !pill || reducedMotion()) {
            return;
        }
        const colour = getComputedStyle(pill).color;
        const animation = pill.animate(
            [
                { boxShadow: `0 0 0 0 color-mix(in srgb, ${colour} 55%, transparent)` },
                { boxShadow: `0 0 0 6px color-mix(in srgb, ${colour} 0%, transparent)` },
            ],
            { duration: PULSE_MS, easing: "ease-out" },
        );
        return () => animation.cancel();
    }, [kind]);
    return root;
}

/**
 * The absent agent's remedy: a click copies a message for the user's agent and the chip confirms
 * with a drawn check. Where the clipboard is refused, the message opens selected below.
 */
function CopyMessage({
    location,
    label,
    children,
}: {
    location: DocLocation;
    label: string;
    children: ComponentChildren;
}): JSX.Element {
    const [copied, setCopied] = useState(false);
    const [fallback, setFallback] = useState(false);
    const message = agentMessage(location);
    useEffect(() => {
        if (!copied) {
            return;
        }
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);
    // The wait timer lives past the race it loses, so it is cleared then and on unmount.
    const waiting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(waiting.current), []);
    const copy = async () => {
        const copied = await Promise.race([
            copyText(message),
            new Promise<boolean>((done) => {
                waiting.current = setTimeout(() => done(false), COPY_WAIT_MS);
            }),
        ]);
        clearTimeout(waiting.current);
        if (copied) {
            setFallback(false);
            setCopied(true);
        } else {
            setFallback(true);
        }
    };
    const close = useCallback(() => setFallback(false), []);
    return (
        <>
            <button
                type="button"
                class={copied ? "agent-chip-button chip-copied" : "agent-chip-button"}
                aria-label={copied ? "Copied. Paste it to your agent" : label}
                aria-expanded={fallback ? true : undefined}
                onClick={() => void copy()}
            >
                {copied ? (
                    <>
                        <svg class="chip-check" viewBox="0 0 12 12" aria-hidden="true">
                            <path d="M2 6.5 4.8 9.2 10 3.5" pathLength={1} />
                        </svg>
                        <span class="agent-chip-name">Copied</span>
                    </>
                ) : (
                    children
                )}
            </button>
            {fallback ? <MessagePopover message={message} onClose={close} /> : null}
        </>
    );
}

function MessagePopover({
    message,
    onClose,
}: {
    message: string;
    onClose: () => void;
}): JSX.Element {
    const root = useRef<HTMLDivElement>(null);
    const area = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        area.current?.focus();
        area.current?.select();
        const outside = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) {
                onClose();
            }
        };
        document.addEventListener("pointerdown", outside);
        return () => document.removeEventListener("pointerdown", outside);
    }, [onClose]);
    return (
        <div
            class="popover chip-popover"
            role="dialog"
            aria-label="Message for your agent"
            ref={root}
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    // The page's own Escape (deselect) must not also fire.
                    event.stopPropagation();
                    onClose();
                }
            }}
        >
            <p class="chip-popover-text">
                Copying failed. Select this message and copy it for your agent:
            </p>
            <textarea
                class="chip-popover-area"
                readOnly
                rows={4}
                value={message}
                ref={area}
                onFocus={(event) => event.currentTarget.select()}
            />
        </div>
    );
}
