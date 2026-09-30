import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { DocSnapshot, DocStore } from "../../core/model.ts";
import type { Density, ViewPrefs } from "../preferences.ts";
import type { ClientSnapshot } from "../server-store.ts";
import { isStalled } from "../view-model.ts";
import { DocName, type DocLocation } from "./doc-name.tsx";

interface TopBarProps {
    store: DocStore;
    snapshot: DocSnapshot;
    location: DocLocation;
    now: number;
    dark: boolean;
    onToggleTheme: () => void;
    prefs: ViewPrefs;
    setPrefs: (change: Partial<ViewPrefs>) => void;
    /** Below the three-column width the outline lives in a drawer. */
    outlineButton: boolean;
    /** Below the two-column width the threads live in a drawer instead of the margin. */
    threadsButton: boolean;
    onOpenOutline: () => void;
    onOpenThreads: () => void;
    openThreads: number;
}

export function TopBar(props: TopBarProps): JSX.Element {
    const { store, snapshot, prefs } = props;
    const drafts = snapshot.threads.filter((thread) => thread.state === "draft").length;
    return (
        <header class="topbar">
            <div class="topbar-start">
                {props.outlineButton ? (
                    <button
                        type="button"
                        class="icon-button"
                        aria-label="Outline"
                        onClick={props.onOpenOutline}
                    >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M2 4h12M2 8h9M2 12h11" />
                        </svg>
                    </button>
                ) : null}
                <DocName location={props.location} />
            </div>
            <div class="topbar-end">
                <AgentChip snapshot={snapshot} now={props.now} />
                <span class="hold">
                    <label
                        class="switch"
                        title="Keep new comments as drafts until you send them together"
                    >
                        <input
                            type="checkbox"
                            checked={snapshot.settings.hold}
                            onChange={(event) => void store.setHold(event.currentTarget.checked)}
                        />
                        <span>Hold</span>
                    </label>
                    {drafts > 0 ? (
                        <button type="button" class="button" onClick={() => void store.sendAll()}>
                            Send all ({drafts})
                        </button>
                    ) : null}
                </span>
                {props.threadsButton ? null : (
                    <button
                        type="button"
                        class={prefs.showMargin ? "icon-button icon-button-on" : "icon-button"}
                        aria-label={prefs.showMargin ? "Hide comments" : "Show comments"}
                        aria-pressed={prefs.showMargin}
                        title={prefs.showMargin ? "Hide comments" : "Show comments"}
                        onClick={() => props.setPrefs({ showMargin: !prefs.showMargin })}
                    >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                            <path d="M10 2.5v11M11.8 5.5h1M11.8 7.5h1" />
                        </svg>
                    </button>
                )}
                <Settings
                    store={store}
                    snapshot={snapshot}
                    prefs={prefs}
                    setPrefs={props.setPrefs}
                />
                <button
                    type="button"
                    class="icon-button"
                    aria-label={props.dark ? "Switch to light theme" : "Switch to dark theme"}
                    onClick={props.onToggleTheme}
                >
                    {props.dark ? (
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                            <circle cx="8" cy="8" r="3" />
                            <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
                        </svg>
                    ) : (
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" />
                        </svg>
                    )}
                </button>
                {props.threadsButton ? (
                    <button type="button" class="button button-quiet" onClick={props.onOpenThreads}>
                        Threads ({props.openThreads})
                    </button>
                ) : null}
            </div>
        </header>
    );
}

/**
 * "Working on" comes from the fold (claimed, unanswered threads). "Watching" comes from the
 * daemon's presence check when the store has one; the mockup falls back to recent agent activity.
 */
function AgentChip({ snapshot, now }: { snapshot: ClientSnapshot; now: number }): JSX.Element {
    const working = snapshot.threads.filter(
        (thread) => thread.state === "working" && !isStalled(thread, now),
    );
    const seen =
        snapshot.agentWatching ??
        (snapshot.agentSeenAt ? now - Date.parse(snapshot.agentSeenAt) < 15 * 60_000 : false);
    if (working.length > 0) {
        return (
            <span class="agent-chip agent-working" role="status">
                <span class="agent-dot" />
                <span class="agent-label">
                    Agent working on {working.map((thread) => thread.id).join(", ")}
                </span>
            </span>
        );
    }
    return (
        <span class={seen ? "agent-chip agent-watching" : "agent-chip"} role="status">
            <span class="agent-dot" />
            <span class="agent-label">{seen ? "Agent watching" : "Agent not connected"}</span>
        </span>
    );
}

const densities: { value: Density; label: string }[] = [
    { value: "sm", label: "Small" },
    { value: "md", label: "Medium" },
    { value: "lg", label: "Large" },
];

interface SettingsProps {
    store: DocStore;
    snapshot: DocSnapshot;
    prefs: ViewPrefs;
    setPrefs: (change: Partial<ViewPrefs>) => void;
}

function Settings({ store, snapshot, prefs, setPrefs }: SettingsProps): JSX.Element {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLSpanElement>(null);
    const { autoApply, suggestionsOnly } = snapshot.settings;
    useEffect(() => {
        if (!open) {
            return;
        }
        const close = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", close);
        return () => document.removeEventListener("pointerdown", close);
    }, [open]);
    const resolved = snapshot.threads.filter((thread) => thread.state === "resolved").length;
    return (
        <span class="settings" ref={root}>
            <button
                type="button"
                class="icon-button"
                aria-label="Settings"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" />
                    <circle cx="10.5" cy="4.5" r="1.5" />
                    <circle cx="5.5" cy="11.5" r="1.5" />
                </svg>
            </button>
            {open ? (
                <div class="popover" role="dialog" aria-label="Settings">
                    <p class="popover-title">View</p>
                    <div class="setting-row">
                        <span>Text size</span>
                        <span class="segmented" role="radiogroup" aria-label="Text size">
                            {densities.map((density) => (
                                <button
                                    key={density.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={prefs.density === density.value}
                                    class={
                                        prefs.density === density.value
                                            ? "segment segment-on"
                                            : "segment"
                                    }
                                    onClick={() => setPrefs({ density: density.value })}
                                >
                                    {density.label}
                                </button>
                            ))}
                        </span>
                    </div>
                    <label class="setting">
                        <input
                            type="checkbox"
                            checked={prefs.showResolved}
                            onChange={(event) =>
                                setPrefs({ showResolved: event.currentTarget.checked })
                            }
                        />
                        <span>
                            <strong>Show resolved threads ({resolved})</strong>
                            <small>
                                Resolved threads stay in the margin with a faint highlight.
                            </small>
                        </span>
                    </label>
                    <p class="popover-title">Agent</p>
                    <label class="setting">
                        <input
                            type="checkbox"
                            checked={autoApply}
                            onChange={(event) =>
                                void store.setSetting("autoApply", event.currentTarget.checked)
                            }
                        />
                        <span>
                            <strong>Auto-apply agent edits</strong>
                            <small>
                                Every thread, this session. Applied edits can be reverted.
                            </small>
                        </span>
                    </label>
                    <label class="setting">
                        <input
                            type="checkbox"
                            checked={suggestionsOnly}
                            onChange={(event) =>
                                void store.setSetting(
                                    "suggestionsOnly",
                                    event.currentTarget.checked,
                                )
                            }
                        />
                        <span>
                            <strong>Suggestions only</strong>
                            <small>
                                The agent can't apply edits directly; they arrive as suggestions.
                            </small>
                        </span>
                    </label>
                </div>
            ) : null}
        </span>
    );
}
