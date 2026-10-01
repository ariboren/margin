import type { JSX } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import { createAnchor, resolveAnchor } from "../core/anchor.ts";
import {
    isDocNote,
    type DocSnapshot,
    type DocStore,
    type Offset,
    type Range,
    type Thread,
    type ThreadId,
    type Unit,
} from "../core/model.ts";
import { Composer, EditCard, type ComposerTarget } from "./components/composer.tsx";
import { agentChipFor } from "./components/agent-chip.tsx";
import { DocNotes } from "./components/doc-notes.tsx";
import { ReplacedCard } from "./components/replaced-card.tsx";
import { UndoNotice } from "./components/undo-notice.tsx";
import type { DocLocation } from "./components/doc-name.tsx";
import { MarginRail, type RailItem } from "./components/margin-rail.tsx";
import { Outline } from "./components/outline.tsx";
import { ThreadCard } from "./components/thread-card.tsx";
import { TopBar } from "./components/top-bar.tsx";
import { useUnitEditing } from "./components/unit-editor.tsx";
import { Blocks } from "./render/blocks.tsx";
import { useViewPrefs, type EditOn } from "./preferences.ts";
import { Render, type RenderContext } from "./render/context.ts";
import { useTheme } from "./theme.ts";
import { useNow } from "./time.ts";
import type { UndoStack } from "./undo.ts";
import { scrollBehavior } from "./motion.ts";
import { useKeys } from "./use-keys.ts";
import { useUndo } from "./use-undo.ts";
import { useMedia } from "./use-media.ts";
import { useSourceSelection, type SourceSelection } from "./use-selection.ts";
import { usePresence } from "./use-presence.ts";
import { useTabStatus } from "./use-tab-status.ts";
import { useSnapshot } from "./use-snapshot.ts";
import {
    anchoredThreads,
    buildView,
    editRange,
    firstUnresolved,
    stalledThreads,
    threadPosition,
    unitFor,
    unitKey,
    type Decoration,
    type DocView,
} from "./view-model.ts";
import { linkKind } from "./links.ts";
import { useApply, type ApplyControls } from "./use-apply.ts";
import { useReplacements, type Replacements } from "./use-replacements.ts";
import { useUnitKeys } from "./use-unit-keys.ts";

type Panel = "outline" | "threads" | null;

/** While the composer's request is out, `known` lists the threads the rail may show. */
type ComposerState = ComposerTarget & { known?: ReadonlySet<ThreadId> };

/**
 * Threads with a card: resolved ones only on request, or while active (so an agent's resolve does
 * not pull the card away); a thread born during a send waits so it can take the composer's place
 * in the render that closes it, never beside it.
 */
export function visibleThreads(
    threads: Thread[],
    showResolved: boolean,
    activeId: ThreadId | null,
    known?: ReadonlySet<ThreadId>,
): Thread[] {
    return threads.filter(
        (thread) =>
            (thread.state !== "resolved" || showResolved || thread.id === activeId) &&
            (known === undefined || known.has(thread.id)),
    );
}

/**
 * The thread a click on overlapping highlights picks: the smallest range first, then each
 * further click moves on to the next larger one and round again, so every thread under the
 * pointer can be reached.
 */
export function nextInOverlap(
    ids: ThreadId[],
    ranges: ReadonlyMap<ThreadId, Range>,
    activeId: ThreadId | null,
): ThreadId | undefined {
    const size = (id: ThreadId) => {
        const range = ranges.get(id);
        return range ? range.end - range.start : Number.POSITIVE_INFINITY;
    };
    const ordered = [...new Set(ids)].sort((a, b) => size(a) - size(b));
    const current = activeId === null ? -1 : ordered.indexOf(activeId);
    return ordered[current < 0 ? 0 : (current + 1) % ordered.length];
}

/** Kinds edited through their items or cells; the whole thing opens only via "Edit as source". */
const containerKinds = new Set<Unit["kind"]>(["list", "table", "blockquote"]);

/**
 * What a click on doc text may do under "Edit blocks with": pick a highlight's thread, open the
 * block's editor, or both (the editor when no thread was picked). With double click, the click
 * that completes a double click does nothing of its own, or it would cycle off the thread its
 * first click picked; `detail` is 0 for a click made without a pointer.
 */
export function docClickRoute(
    editOn: EditOn,
    type: "click" | "dblclick",
    detail: number,
): { select: boolean; edit: boolean } {
    if (editOn === "click") {
        return { select: type === "click", edit: type === "click" };
    }
    return type === "dblclick"
        ? { select: false, edit: true }
        : { select: detail <= 1, edit: false };
}

const ownClicks = "a, button, input, textarea, .unit-editor";

/** `undo` is the stack `store` records onto (see `recording`); without one there is no ⌘Z. */
export function App({
    store,
    location,
    undo = null,
}: {
    store: DocStore;
    location: DocLocation;
    undo?: UndoStack | null;
}): JSX.Element {
    const snapshot = useSnapshot(store);
    const [prefs, setPrefs] = useViewPrefs();
    const { showResolved } = prefs;
    const view = useMemo(() => buildView(snapshot, showResolved), [snapshot, showResolved]);
    const now = useNow();
    const presence = usePresence(store, snapshot);
    const stalled = useMemo(() => stalledThreads(snapshot.threads, now), [snapshot.threads, now]);
    const chip = agentChipFor(presence.state, stalled, presence.clock);
    useTabStatus(snapshot, chip.kind);
    const theme = useTheme();
    const wide = useMedia("(min-width: 1280px)");
    const narrow = useMedia("(max-width: 1023px)");
    const [activeId, setActiveId] = useState<ThreadId | null>(null);
    const [composer, setComposer] = useState<ComposerState | null>(null);
    const [panel, setPanel] = useState<Panel>(null);
    /** The doc notes panel while open, with the note it opened on (from the stalled chip). */
    const [notes, setNotes] = useState<{ focus: ThreadId | null } | null>(null);
    const article = useRef<HTMLElement>(null);
    const replacements = useReplacements(store, snapshot);
    const editing = useUnitEditing(store, snapshot, replacements.add);
    const notice = useUndo(undo);
    const apply = useApply(store);
    const blockKeys = useUnitKeys(snapshot.doc.units);
    const selection = useSourceSelection(article, snapshot.doc);
    const { source } = snapshot.doc;

    const composerRange = composer ? resolveAnchor(source, composer.anchor) : null;
    const decorations = useMemo<Decoration[]>(
        () =>
            composerRange
                ? [...view.decorations, { id: "new", kind: "pending", ...composerRange }]
                : view.decorations,
        [view.decorations, composerRange?.start, composerRange?.end],
    );
    const unitsByKey = useMemo(
        () => new Map(view.units.map((unit) => [unitKey(unit), unit])),
        [view.units],
    );

    const unitElement = (offset: Offset): Element | null => {
        const unit = unitFor(snapshot, offset);
        return unit
            ? (article.current?.querySelector(
                  `[data-unit="${unit.start}"][data-kind="${unit.kind}"]`,
              ) ?? null)
            : null;
    };
    // A thread whose highlight is gone because its block is being edited keeps the place it had
    // (a null anchor holds the card) rather than jumping to the editor's top edge.
    const threadElement = (id: string, fallback: Offset): Element | null => {
        const mark = article.current?.querySelector(`[data-threads~="${id}"]`);
        if (mark) {
            return mark;
        }
        const unit = unitFor(snapshot, fallback);
        const edited = editing.editing;
        return unit && edited && unit.kind === edited.kind && unit.start === edited.start
            ? null
            : unitElement(fallback);
    };

    const marginShown = !narrow && prefs.showMargin;
    const outlineShown = wide && prefs.showOutline;
    const pageClass = [
        "page",
        marginShown || narrow ? "" : "page-no-margin",
        wide && !prefs.showOutline ? "page-no-outline" : "",
    ]
        .filter(Boolean)
        .join(" ");
    const showThreads = () => {
        if (narrow) {
            setPanel("threads");
        } else if (!prefs.showMargin) {
            setPrefs({ showMargin: true });
        }
    };
    const activate = (id: ThreadId, scroll = false) => {
        setActiveId(id);
        showThreads();
        if (scroll) {
            const thread = snapshot.threads.find((candidate) => candidate.id === id);
            requestAnimationFrame(() =>
                (thread ? threadElement(id, threadPosition(view, thread)) : null)?.scrollIntoView({
                    block: "center",
                    behavior: scrollBehavior(),
                }),
            );
        }
    };

    const startComposer = (mode: ComposerTarget["mode"]) => {
        if (!selection) {
            return;
        }
        setComposer({ mode, anchor: createAnchor(source, selection.range) });
        setActiveId(null);
        window.getSelection()?.removeAllRanges();
        showThreads();
    };

    const activeThread = snapshot.threads.find((thread) => thread.id === activeId);
    // From the bar: a doc note has no card in the rail, so it opens in its panel instead.
    const selectThread = (id: ThreadId) => {
        const thread = snapshot.threads.find((candidate) => candidate.id === id);
        if (thread && isDocNote(thread)) {
            setNotes({ focus: id });
        } else {
            activate(id, true);
        }
    };
    const step = (by: number) => {
        const { order } = view;
        if (order.length === 0) {
            return;
        }
        const index = activeId ? order.indexOf(activeId) : -1;
        const next =
            index < 0
                ? by > 0
                    ? 0
                    : order.length - 1
                : (index + by + order.length) % order.length;
        activate(order[next]!, true);
    };
    useKeys({
        c: () => startComposer("comment"),
        s: () => startComposer("suggest"),
        j: () => step(1),
        k: () => step(-1),
        a: () => {
            if (activeThread?.suggestion?.status === "pending") {
                apply.accept(activeThread);
            }
        },
        r: () => {
            if (activeThread?.suggestion?.status === "pending") {
                void store.reject(activeThread.id);
            }
        },
        n: () => setNotes((current) => (current ? null : { focus: null })),
        Escape: () => {
            if (composer) {
                setComposer(null);
            } else if (notes) {
                setNotes(null);
            } else if (panel) {
                setPanel(null);
            } else {
                setActiveId(null);
            }
        },
    });

    const highlightedId = composer ? "new" : activeId;
    const render: RenderContext = {
        source,
        shift: view.shift,
        decorations,
        activeId: highlightedId,
        units: view.units,
        unitsByKey,
        blockKeys,
        editorFor: editing.editorFor,
        onEditAsSource: editing.begin,
        followLink: (event, url) => followLink(event, url, view, location),
    };

    const onDocClick = (event: MouseEvent) => {
        const target = event.target as Element;
        const dblclick = event.type === "dblclick";
        const route = docClickRoute(prefs.editOn, dblclick ? "dblclick" : "click", event.detail);
        if ((!route.select && !route.edit) || target.closest(ownClicks)) {
            return;
        }
        if (dblclick) {
            window.getSelection()?.removeAllRanges();
        } else if (!window.getSelection()?.isCollapsed) {
            return;
        }
        // A suggestion's diff nests inside the marks over it, so every decorated ancestor counts.
        const decorated: ThreadId[] = [];
        for (
            let mark = route.select ? target.closest("[data-threads]") : null;
            mark;
            mark = mark.parentElement?.closest("[data-threads]") ?? null
        ) {
            for (const candidate of mark.getAttribute("data-threads")?.split(" ") ?? []) {
                if (candidate !== "new") {
                    decorated.push(candidate as ThreadId);
                }
            }
        }
        const id = nextInOverlap(decorated, view.ranges, activeId);
        if (id) {
            activate(id);
            return;
        }
        if (!route.edit) {
            return;
        }
        const element = target.closest("[data-unit]");
        const unit = element
            ? view.units.find(
                  (candidate) =>
                      candidate.start === Number(element.getAttribute("data-unit")) &&
                      candidate.kind === element.getAttribute("data-kind"),
              )
            : undefined;
        if (unit && !containerKinds.has(unit.kind)) {
            editing.begin(unit);
        }
    };

    // The second press of a double click that opens the editor must not select a word first: the
    // selection toolbar would flash before the editor takes the block's place.
    const onDocMouseDown = (event: MouseEvent) => {
        const target = event.target as Element;
        if (
            prefs.editOn === "dblclick" &&
            event.detail > 1 &&
            target.closest("[data-unit]") &&
            !target.closest(ownClicks)
        ) {
            event.preventDefault();
        }
    };

    // Outside a thread: a click on the page that is not on doc text (a unit, or the editor in its
    // place, which keep their own behaviour), a rail card or a control. The end of a drag-select
    // is not a click outside. The top bar, drawers and toasts sit outside the page.
    // The path is read at dispatch time: a click on a collapsed card's summary activates the card
    // and Preact unmounts the summary before this listener runs, so `closest` on the detached
    // target would find nothing and deselect in the same click.
    const onPageClick = (event: MouseEvent) => {
        if (
            activeId === null ||
            !window.getSelection()?.isCollapsed ||
            event
                .composedPath()
                .some(
                    (node) =>
                        node instanceof Element &&
                        node.matches(
                            "[data-unit], [data-rail-key], a, button, input, textarea, label",
                        ),
                )
        ) {
            return;
        }
        setActiveId(null);
    };

    const items = railItems({
        store,
        snapshot,
        view,
        now,
        activeId,
        composer,
        composerRange,
        showResolved,
        threadElement,
        unitElement,
        activate,
        deactivate: () => setActiveId(null),
        apply,
        replacements,
        followLink: render.followLink,
        setSending: (sending) => {
            const known = sending ? new Set(snapshot.threads.map((thread) => thread.id)) : null;
            setComposer((current) =>
                current
                    ? known
                        ? { ...current, known }
                        : { mode: current.mode, anchor: current.anchor }
                    : current,
            );
        },
        closeComposer: (id) => {
            setComposer(null);
            if (id) {
                setActiveId(id);
            }
        },
    });
    return (
        <div class="app">
            <TopBar
                store={store}
                snapshot={snapshot}
                location={location}
                now={now}
                chip={chip}
                problem={presence.status.problem}
                dark={theme.dark}
                undo={undo}
                prefs={prefs}
                setPrefs={setPrefs}
                onToggleTheme={theme.toggle}
                outlineInDrawer={!wide}
                threadsButton={narrow}
                onOpenOutline={() => setPanel("outline")}
                onOpenThreads={() => setPanel("threads")}
                openThreads={view.order.length}
                settled={view.settled + replacements.placed.length}
                onSelectThread={selectThread}
                firstUnresolved={firstUnresolved(view, snapshot.threads)}
            />
            <Banners store={store} snapshot={snapshot} />
            {editing.overlay}
            {undo ? <UndoNotice notice={notice} stack={undo} /> : null}
            <div class={pageClass} onClick={onPageClick}>
                {outlineShown ? (
                    <aside class="sidebar">
                        <Outline
                            entries={view.outline}
                            onCollapse={() => setPrefs({ showOutline: false })}
                        />
                    </aside>
                ) : null}
                <main class="reading">
                    <article
                        class="doc"
                        ref={article}
                        onClick={onDocClick}
                        onDblClick={onDocClick}
                        onMouseDown={onDocMouseDown}
                    >
                        <Render.Provider value={render}>
                            <Blocks nodes={view.tree.children} />
                        </Render.Provider>
                    </article>
                </main>
                {marginShown ? (
                    <aside class="margin" aria-label="Threads">
                        <MarginRail items={items} activeKey={highlightedId} floating />
                    </aside>
                ) : null}
            </div>
            {panel ? (
                <div class="scrim" onClick={() => setPanel(null)}>
                    <div
                        class={panel === "outline" ? "drawer drawer-start" : "drawer drawer-end"}
                        onClick={(event) => event.stopPropagation()}
                    >
                        {panel === "outline" ? (
                            <Outline entries={view.outline} onNavigate={() => setPanel(null)} />
                        ) : (
                            <>
                                <div class="drawer-head">Threads</div>
                                <MarginRail items={items} activeKey={activeId} floating={false} />
                            </>
                        )}
                    </div>
                </div>
            ) : null}
            {selection && !composer && !editing.editing ? (
                <SelectionToolbar selection={selection} onPick={startComposer} />
            ) : null}
            <DocNotes
                store={store}
                snapshot={snapshot}
                now={now}
                open={notes !== null}
                focus={notes?.focus ?? null}
                onOpen={() => setNotes({ focus: null })}
                onClose={() => setNotes(null)}
                showResolved={showResolved}
                apply={apply}
                followLink={render.followLink}
            />
        </div>
    );
}

/**
 * `#slug` scrolls to the heading with that GitHub anchor, with no navigation. A relative link
 * asks the host to open that file. An http(s) link opens in a new tab, through the host where a
 * plain link cannot. Anything else (mailto:) keeps its default.
 */
function followLink(event: MouseEvent, url: string, view: DocView, location: DocLocation): void {
    const kind = linkKind(url);
    if (kind === "inert") {
        event.preventDefault();
        return;
    }
    if (kind === "fragment") {
        event.preventDefault();
        let slug = url.slice(1);
        try {
            slug = decodeURIComponent(slug);
        } catch {
            // Keep the raw fragment.
        }
        const entry = view.outline.find((candidate) => candidate.slug === slug.toLowerCase());
        if (entry) {
            document
                .getElementById(`h-${entry.start}`)
                ?.scrollIntoView({ block: "start", behavior: scrollBehavior() });
        }
        return;
    }
    if (kind === "web") {
        if (location.openUrl) {
            event.preventDefault();
            location.openUrl(url);
        }
        return;
    }
    if (kind === "mail") {
        return;
    }
    if (location.openFile) {
        event.preventDefault();
        location.openFile(url);
    }
}

interface RailInput {
    store: DocStore;
    snapshot: DocSnapshot;
    view: DocView;
    now: number;
    activeId: ThreadId | null;
    composer: ComposerState | null;
    composerRange: Range | null;
    showResolved: boolean;
    threadElement: (id: string, fallback: Offset) => Element | null;
    unitElement: (offset: Offset) => Element | null;
    activate: (id: ThreadId) => void;
    deactivate: () => void;
    apply: ApplyControls;
    replacements: Replacements;
    setSending: (sending: boolean) => void;
    closeComposer: (id: ThreadId | null) => void;
    followLink: RenderContext["followLink"];
}

function railItems(input: RailInput): RailItem[] {
    const { store, snapshot, view, now } = input;
    const placed: (RailItem & { at: Offset })[] = [];
    const threads = visibleThreads(
        anchoredThreads(snapshot.threads),
        input.showResolved,
        input.activeId,
        input.composer?.known,
    );
    for (const thread of threads) {
        const at = threadPosition(view, thread);
        placed.push({
            key: thread.id,
            at,
            fade: true,
            anchor: () => input.threadElement(thread.id, at),
            node: (
                <ThreadCard
                    store={store}
                    thread={thread}
                    active={thread.id === input.activeId}
                    now={now}
                    hold={snapshot.settings.hold}
                    onActivate={() => input.activate(thread.id)}
                    onDeactivate={input.deactivate}
                    apply={input.apply}
                    followLink={input.followLink}
                />
            ),
        });
    }
    // A kept text is done like an edit, so it shows with resolved threads.
    for (const replacement of input.showResolved ? input.replacements.placed : []) {
        const { start } = replacement;
        placed.push({
            key: `replaced-${replacement.id}`,
            at: start,
            givesWay: true,
            anchor: () => input.unitElement(start),
            node: <ReplacedCard replacement={replacement} replacements={input.replacements} />,
        });
    }
    for (const edit of view.userEdits) {
        const at = editRange(snapshot.doc.source, edit)?.start ?? edit.start;
        placed.push({
            key: `edit-${edit.seq}`,
            at,
            givesWay: true,
            anchor: () => input.unitElement(at),
            node: <EditCard store={store} edit={edit} now={now} />,
        });
    }
    if (input.composer && input.composerRange) {
        placed.push({
            key: "new",
            at: input.composerRange.start,
            anchor: () => input.threadElement("new", input.composerRange!.start),
            node: (
                <Composer
                    store={store}
                    target={input.composer}
                    hold={snapshot.settings.hold}
                    onSending={input.setSending}
                    onDone={input.closeComposer}
                />
            ),
        });
    }
    return placed.sort((a, b) => a.at - b.at);
}

function SelectionToolbar({
    selection,
    onPick,
}: {
    selection: SourceSelection;
    onPick: (mode: ComposerTarget["mode"]) => void;
}): JSX.Element {
    const { rect } = selection;
    const center = Math.min(Math.max(rect.left + rect.width / 2, 110), window.innerWidth - 110);
    const top = rect.top > 64 ? rect.top - 46 : rect.bottom + 8;
    return (
        <div
            class="selection-toolbar"
            style={{ top: `${top}px`, left: `${center}px` }}
            role="toolbar"
        >
            <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick("comment")}
            >
                Comment <kbd>c</kbd>
            </button>
            <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick("suggest")}
            >
                Suggest <kbd>s</kbd>
            </button>
        </div>
    );
}

function Banners({
    store,
    snapshot,
}: {
    store: DocStore;
    snapshot: DocSnapshot;
}): JSX.Element | null {
    if (snapshot.missing) {
        return (
            <div class="banner banner-warn" role="alert">
                The file is missing on disk. Comments and drafts are kept until it comes back.
            </div>
        );
    }
    if (snapshot.changedOnDisk) {
        return (
            <div class="banner" role="status">
                <span>
                    Changed on disk. The page shows the new text and comments were re-anchored.
                </span>
                <button
                    type="button"
                    class="link-button"
                    onClick={() => store.dismissChangedOnDisk()}
                >
                    Dismiss
                </button>
            </div>
        );
    }
    return null;
}
