import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { DocSnapshot, DocStore, ThreadId } from "../../core/model.ts";
import type { EditOn, Scale, ViewPrefs } from "../preferences.ts";
import { describeEntry, type UndoStack } from "../undo.ts";
import { useMedia } from "../use-media.ts";
import { isDetached } from "../view-model.ts";
import { AgentChip, type AgentChipModel } from "./agent-chip.tsx";
import { DetachedAction } from "./detached-action.tsx";
import { DocName, type DocLocation } from "./doc-name.tsx";
import { RequestToast } from "./request-toast.tsx";
import { ReviewMenu } from "./review-menu.tsx";
import { Tooltip } from "./tooltip.tsx";

interface TopBarProps {
    store: DocStore;
    snapshot: DocSnapshot;
    location: DocLocation;
    now: number;
    /** The agent chip as the page computed it, the same model the tab icon reads. */
    chip: AgentChipModel;
    /** A request the daemon refused, until the store clears it. */
    problem: string | undefined;
    dark: boolean;
    /** The page's undo stack; without one (the mockup) there are no undo buttons. */
    undo: UndoStack | null;
    onToggleTheme: () => void;
    prefs: ViewPrefs;
    setPrefs: (change: Partial<ViewPrefs>) => void;
    /** Below the three-column width the outline lives in a drawer; else the button folds it away. */
    outlineInDrawer: boolean;
    /** Below the two-column width the threads live in a drawer instead of the margin. */
    threadsButton: boolean;
    onOpenOutline: () => void;
    onOpenThreads: () => void;
    openThreads: number;
    /** Resolved threads and the user's own edit cards, which the show-resolved setting governs. */
    settled: number;
    /** Selects and scrolls to a thread; the stalled chip and the review menu use it. */
    onSelectThread: (id: ThreadId) => void;
    /** Where the review menu's "step through them" starts. */
    firstUnresolved: ThreadId | undefined;
}

export function TopBar(props: TopBarProps): JSX.Element {
    const { store, snapshot, prefs } = props;
    const drafts = snapshot.threads.filter((thread) => thread.state === "draft").length;
    const wide = { detached: snapshot.threads.some(isDetached), drafts: drafts > 0 };
    const short = useMedia(shortLabelsBelow(wide));
    const sendLabel = `Send all (${drafts})`;
    const sendButton = (
        <button
            type="button"
            class="button"
            aria-label={sendLabel}
            onClick={() => void store.sendAll()}
        >
            {short ? `Send (${drafts})` : sendLabel}
        </button>
    );
    const liveTip = snapshot.settings.hold
        ? "Turn on so your agent receives your comments as you send them"
        : "Turn off to queue comments and send them as a batch when you're ready";
    return (
        <>
            <header class={barClass(wide)}>
                <div class="topbar-start">
                    <OutlineButton
                        inDrawer={props.outlineInDrawer}
                        shown={prefs.showOutline}
                        onOpen={props.onOpenOutline}
                        onToggle={() => props.setPrefs({ showOutline: !prefs.showOutline })}
                    />
                    <DocName location={props.location} />
                    <AgentChip
                        model={props.chip}
                        location={props.location}
                        onSelectThread={props.onSelectThread}
                    />
                </div>
                <div class="topbar-end">
                    <DetachedAction
                        store={store}
                        snapshot={snapshot}
                        undo={props.undo}
                        short={short}
                    />
                    {props.undo ? <UndoButtons stack={props.undo} /> : null}
                    <span class="hold">
                        <Tooltip text={liveTip}>
                            {(tip) => (
                                <label class="switch">
                                    <input
                                        type="checkbox"
                                        aria-describedby={tip}
                                        checked={!snapshot.settings.hold}
                                        onChange={(event) =>
                                            void store.setHold(!event.currentTarget.checked)
                                        }
                                    />
                                    <span>Live</span>
                                </label>
                            )}
                        </Tooltip>
                        {drafts === 0 ? null : short ? (
                            <Tooltip text={sendLabel}>{() => sendButton}</Tooltip>
                        ) : (
                            sendButton
                        )}
                    </span>
                    <ReviewMenu
                        store={store}
                        snapshot={snapshot}
                        now={props.now}
                        first={props.firstUnresolved}
                        agentAway={props.chip.kind === "none" || props.chip.kind === "disconnected"}
                        onSelectThread={props.onSelectThread}
                    />
                    <span class="topbar-divider" role="separator" aria-orientation="vertical" />
                    <span class="topbar-view">
                        <Settings
                            store={store}
                            snapshot={snapshot}
                            prefs={prefs}
                            setPrefs={props.setPrefs}
                            settled={props.settled}
                        />
                        <span class="theme-toggle">
                            <IconButton
                                label={
                                    props.dark ? "Switch to light theme" : "Switch to dark theme"
                                }
                                align="end"
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
                            </IconButton>
                        </span>
                        {props.threadsButton ? (
                            <button
                                type="button"
                                class="button button-quiet threads-button"
                                onClick={props.onOpenThreads}
                            >
                                <svg class="threads-mark" viewBox="0 0 16 16" aria-hidden="true">
                                    <path d="M2.5 3.5h11v7.5h-6l-3 2.5v-2.5h-2z" />
                                </svg>
                                <span class="threads-words">Threads ({props.openThreads})</span>
                                <span class="threads-count" aria-hidden="true">
                                    {props.openThreads}
                                </span>
                            </button>
                        ) : (
                            <IconButton
                                label={prefs.showMargin ? "Hide comments" : "Show comments"}
                                align="end"
                                pressed={prefs.showMargin}
                                onClick={() => props.setPrefs({ showMargin: !prefs.showMargin })}
                            >
                                <svg viewBox="0 0 16 16" aria-hidden="true">
                                    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                                    <path d="M10 2.5v11M11.8 5.5h1M11.8 7.5h1" />
                                </svg>
                            </IconButton>
                        )}
                    </span>
                </div>
            </header>
            <RequestToast problem={props.problem} />
        </>
    );
}

/**
 * What a narrow bar gives up depends on how many of its two wide buttons are showing: the
 * stylesheet reads `topbar-crowded` for either and `topbar-packed` for both.
 */
export function barClass(showing: { detached: boolean; drafts: boolean }): string {
    if (showing.detached && showing.drafts) {
        return "topbar topbar-crowded topbar-packed";
    }
    return showing.detached || showing.drafts ? "topbar topbar-crowded" : "topbar";
}

/**
 * The media query under which the bar's two wide buttons take their short labels ("N detached",
 * "Send (N)"). Each width is the narrowest bar that still holds the full labels beside the review
 * control without shortening the doc name, as measured in the mockup: the detached action alone,
 * "Send all" alone, and both together.
 */
export function shortLabelsBelow(showing: { detached: boolean; drafts: boolean }): string {
    const width = showing.detached ? (showing.drafts ? 960 : 860) : 620;
    return `(max-width: ${width}px)`;
}

interface IconButtonProps {
    label: string;
    align?: "start" | "center" | "end";
    /** A toggle's state; it also tints the icon while on. */
    pressed?: boolean;
    /** A menu button's state; its tip stays hidden while the menu is open. */
    expanded?: boolean;
    disabled?: boolean;
    onMouseDown?: (event: MouseEvent) => void;
    onClick: () => void;
    children: ComponentChildren;
}

/**
 * An icon-only bar button: its label is both the accessible name and the tooltip, so the tip is
 * not also its description, or a screen reader would read it twice.
 */
function IconButton(props: IconButtonProps): JSX.Element {
    return (
        <Tooltip text={props.label} align={props.align}>
            {() => (
                <button
                    type="button"
                    class={props.pressed ? "icon-button icon-button-on" : "icon-button"}
                    aria-label={props.label}
                    aria-pressed={props.pressed}
                    aria-expanded={props.expanded}
                    disabled={props.disabled}
                    onMouseDown={props.onMouseDown}
                    onClick={props.onClick}
                >
                    {props.children}
                </button>
            )}
        </Tooltip>
    );
}

function OutlineButton({
    inDrawer,
    shown,
    onOpen,
    onToggle,
}: {
    inDrawer: boolean;
    shown: boolean;
    onOpen: () => void;
    onToggle: () => void;
}): JSX.Element {
    return (
        <IconButton
            label={inDrawer ? "Outline" : shown ? "Hide outline" : "Show outline"}
            align="start"
            pressed={inDrawer ? undefined : shown}
            onClick={inDrawer ? onOpen : onToggle}
        >
            <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 4h12M2 8h9M2 12h11" />
            </svg>
        </IconButton>
    );
}

/**
 * The same stack as ⌘Z / ⇧⌘Z, so the same entries and the same refusal notices. Pressing a
 * button does not take focus, so an open editor is not blurred into a save that would race the
 * undo.
 */
function UndoButtons({ stack }: { stack: UndoStack }): JSX.Element {
    const undoLabel = stack.top ? `Undo ${describeEntry(stack.top)}` : "Undo";
    const redoLabel = stack.next ? `Redo ${describeEntry(stack.next)}` : "Redo";
    const keepFocus = (event: MouseEvent) => event.preventDefault();
    return (
        <span class="undo-buttons">
            <IconButton
                label={undoLabel}
                disabled={!stack.canUndo}
                onMouseDown={keepFocus}
                onClick={() => void stack.undo()}
            >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M5.5 3.5 2.5 6.5l3 3M2.5 6.5h7a4 4 0 0 1 0 8H7" />
                </svg>
            </IconButton>
            <IconButton
                label={redoLabel}
                disabled={!stack.canRedo}
                onMouseDown={keepFocus}
                onClick={() => void stack.redo()}
            >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M10.5 3.5l3 3-3 3M13.5 6.5h-7a4 4 0 0 0 0 8H9" />
                </svg>
            </IconButton>
        </span>
    );
}

interface SegmentOption<T extends string> {
    value: T;
    /** The option's accessible name; on an icon option, also its tooltip. */
    label: string;
    /** Without one the label shows as the option's text. */
    icon?: JSX.Element;
}

type ScaleOption = SegmentOption<Scale>;

/** One letter A at three heights on a shared baseline. */
const textSizes: ScaleOption[] = [
    {
        value: "sm",
        label: "Small text",
        icon: <path d="M5.5 13.5 8 7.5l2.5 6M6.33 11.5h3.34" />,
    },
    {
        value: "md",
        label: "Medium text",
        icon: <path d="M4.25 13.5 8 4.5l3.75 9M5.5 10.5h5" />,
    },
    {
        value: "lg",
        label: "Large text",
        icon: <path d="M3 13.5 8 1.5l5 12M4.67 9.5h6.66" />,
    },
];

/** A page whose block of text lines narrows as the margins widen. */
function pageIcon(inset: number): JSX.Element {
    const lines = [5, 8, 11].map((y) => `M${5 + inset} ${y}h${6 - 2 * inset}`).join("");
    return (
        <>
            <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
            <path d={lines} />
        </>
    );
}

const pageMargins: ScaleOption[] = [
    { value: "sm", label: "Narrow margins", icon: pageIcon(0) },
    { value: "md", label: "Medium margins", icon: pageIcon(1) },
    { value: "lg", label: "Wide margins", icon: pageIcon(2) },
];

const editOnOptions: SegmentOption<EditOn>[] = [
    { value: "dblclick", label: "Double click" },
    { value: "click", label: "Single click" },
];

/**
 * The option an arrow, Home or End key moves a radio group of `count` to from `index`: Right and
 * Down step on, Left and Up step back, both wrapping. Undefined for any other key.
 */
export function radioStep(key: string, index: number, count: number): number | undefined {
    const steps: Record<string, number> = {
        ArrowRight: index + 1,
        ArrowDown: index + 1,
        ArrowLeft: index - 1,
        ArrowUp: index - 1,
        Home: 0,
        End: count - 1,
    };
    const step = steps[key];
    return step === undefined ? undefined : (step + count) % count;
}

/**
 * Radios as one segmented control. An icon option is like the bar's icon buttons: its label is
 * both the accessible name and the tooltip, so the tip is not also its description.
 */
function SegmentedControl<T extends string>({
    label,
    options,
    value,
    onChange,
}: {
    label: string;
    options: SegmentOption<T>[];
    value: T;
    onChange: (value: T) => void;
}): JSX.Element {
    const group = useRef<HTMLSpanElement>(null);
    // The radio pattern: the checked option is the one tab stop, arrows move and check.
    const onKeyDown = (event: KeyboardEvent) => {
        const index = options.findIndex((option) => option.value === value);
        const next = radioStep(event.key, index, options.length);
        if (next === undefined) {
            return;
        }
        event.preventDefault();
        onChange(options[next]!.value);
        group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
    };
    return (
        <div class="setting-row">
            <span>{label}</span>
            <span
                class="segmented"
                role="radiogroup"
                aria-label={label}
                ref={group}
                onKeyDown={onKeyDown}
            >
                {options.map((option, index) => {
                    const on = value === option.value;
                    const radio = {
                        type: "button",
                        role: "radio",
                        "aria-checked": on,
                        tabIndex: on ? 0 : -1,
                        class: on ? "segment segment-on" : "segment",
                        onClick: () => onChange(option.value),
                    } as const;
                    return option.icon ? (
                        <Tooltip
                            key={option.value}
                            text={option.label}
                            align={index === options.length - 1 ? "end" : "center"}
                        >
                            {() => (
                                <button {...radio} aria-label={option.label}>
                                    <svg viewBox="0 0 16 16" aria-hidden="true">
                                        {option.icon}
                                    </svg>
                                </button>
                            )}
                        </Tooltip>
                    ) : (
                        <button key={option.value} {...radio}>
                            {option.label}
                        </button>
                    );
                })}
            </span>
        </div>
    );
}

interface SettingsProps {
    store: DocStore;
    snapshot: DocSnapshot;
    prefs: ViewPrefs;
    setPrefs: (change: Partial<ViewPrefs>) => void;
    settled: number;
}

function Settings({ store, snapshot, prefs, setPrefs, settled }: SettingsProps): JSX.Element {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLSpanElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const { autoApply } = snapshot.settings;
    useEffect(() => {
        if (!open) {
            return;
        }
        // Focus moves to the dialog itself: Escape then reaches it from wherever a click inside
        // left focus, and no control's tooltip opens on the way in.
        dialog.current?.focus();
        const close = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", close);
        return () => document.removeEventListener("pointerdown", close);
    }, [open]);
    const onKeyDown = (event: KeyboardEvent) => {
        if (open && event.key === "Escape") {
            // The page's own Escape (deselect) must not also fire.
            event.stopPropagation();
            setOpen(false);
            // The toggle, the first button under the root.
            root.current?.querySelector("button")?.focus();
        }
    };
    return (
        <span class="settings" ref={root} onKeyDown={onKeyDown}>
            <IconButton label="Settings" align="end" expanded={open} onClick={() => setOpen(!open)}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" />
                    <circle cx="10.5" cy="4.5" r="1.5" />
                    <circle cx="5.5" cy="11.5" r="1.5" />
                </svg>
            </IconButton>
            {open ? (
                <div class="popover" role="dialog" aria-label="Settings" tabIndex={-1} ref={dialog}>
                    <p class="popover-title">View</p>
                    <SegmentedControl
                        label="Text size"
                        options={textSizes}
                        value={prefs.density}
                        onChange={(density) => setPrefs({ density })}
                    />
                    <SegmentedControl
                        label="Page margins"
                        options={pageMargins}
                        value={prefs.margins}
                        onChange={(margins) => setPrefs({ margins })}
                    />
                    <SegmentedControl
                        label="Edit blocks with"
                        options={editOnOptions}
                        value={prefs.editOn}
                        onChange={(editOn) => setPrefs({ editOn })}
                    />
                    <label class="setting">
                        <input
                            type="checkbox"
                            checked={prefs.showResolved}
                            onChange={(event) =>
                                setPrefs({ showResolved: event.currentTarget.checked })
                            }
                        />
                        <span>
                            <strong>Show resolved threads and edits ({settled})</strong>
                            <small>Resolved threads and your edits stay in the margin.</small>
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
                            <strong>Auto-apply edits</strong>
                            <small>
                                Agent edits apply to the file right away, without waiting for you to
                                accept them.
                            </small>
                        </span>
                    </label>
                </div>
            ) : null}
        </span>
    );
}
