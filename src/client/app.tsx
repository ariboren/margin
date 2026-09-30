import type { JSX } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import { createAnchor, resolveAnchor } from "../core/anchor.ts";
import type { DocSnapshot, DocStore, Offset, Range, ThreadId, Unit } from "../core/model.ts";
import { Composer, EditCard, type ComposerTarget } from "./components/composer.tsx";
import { ReplacedCard } from "./components/replaced-card.tsx";
import type { DocLocation } from "./components/doc-name.tsx";
import { MarginRail, type RailItem } from "./components/margin-rail.tsx";
import { Outline } from "./components/outline.tsx";
import { ThreadCard } from "./components/thread-card.tsx";
import { TopBar } from "./components/top-bar.tsx";
import { useUnitEditing } from "./components/unit-editor.tsx";
import { Blocks } from "./render/blocks.tsx";
import { useViewPrefs } from "./preferences.ts";
import { Render, type RenderContext } from "./render/context.ts";
import { useTheme } from "./theme.ts";
import { useNow } from "./time.ts";
import { useKeys } from "./use-keys.ts";
import { useMedia } from "./use-media.ts";
import { useSourceSelection, type SourceSelection } from "./use-selection.ts";
import { useSnapshot } from "./use-snapshot.ts";
import {
    buildView,
    editRange,
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

/** Kinds edited through their items or cells; the whole thing opens only via "Edit as source". */
const containerKinds = new Set<Unit["kind"]>(["list", "table", "blockquote"]);

export function App({ store, location }: { store: DocStore; location: DocLocation }): JSX.Element {
    const snapshot = useSnapshot(store);
    const [prefs, setPrefs] = useViewPrefs();
    const { showResolved } = prefs;
    const view = useMemo(() => buildView(snapshot, showResolved), [snapshot, showResolved]);
    const now = useNow();
    const theme = useTheme();
    const wide = useMedia("(min-width: 1280px)");
    const narrow = useMedia("(max-width: 1023px)");
    const [activeId, setActiveId] = useState<ThreadId | null>(null);
    const [composer, setComposer] = useState<ComposerTarget | null>(null);
    const [panel, setPanel] = useState<Panel>(null);
    const article = useRef<HTMLElement>(null);
    const replacements = useReplacements(store, snapshot);
    const editing = useUnitEditing(store, snapshot, replacements.add);
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
    const threadElement = (id: string, fallback: Offset): Element | null =>
        article.current?.querySelector(`[data-threads~="${id}"]`) ?? unitElement(fallback);

    const marginShown = !narrow && prefs.showMargin;
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
                    behavior: "smooth",
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
        Escape: () => {
            if (composer) {
                setComposer(null);
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
        if (
            !window.getSelection()?.isCollapsed ||
            target.closest("a, button, input, textarea, .unit-editor")
        ) {
            return;
        }
        const decorated = target
            .closest("[data-threads]")
            ?.getAttribute("data-threads")
            ?.split(" ");
        const id = decorated?.find((candidate): candidate is ThreadId => candidate !== "new");
        if (id) {
            activate(id);
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
        apply,
        replacements,
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
                dark={theme.dark}
                prefs={prefs}
                setPrefs={setPrefs}
                onToggleTheme={theme.toggle}
                outlineButton={!wide}
                threadsButton={narrow}
                onOpenOutline={() => setPanel("outline")}
                onOpenThreads={() => setPanel("threads")}
                openThreads={view.order.length}
            />
            <Banners store={store} snapshot={snapshot} />
            {editing.stranded}
            <div class={marginShown || narrow ? "page" : "page page-no-margin"}>
                {wide ? (
                    <aside class="sidebar">
                        <Outline entries={view.outline} />
                    </aside>
                ) : null}
                <main class="reading">
                    <article class="doc" ref={article} onClick={onDocClick}>
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
                ?.scrollIntoView({ block: "start", behavior: "smooth" });
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
    composer: ComposerTarget | null;
    composerRange: Range | null;
    showResolved: boolean;
    threadElement: (id: string, fallback: Offset) => Element | null;
    unitElement: (offset: Offset) => Element | null;
    activate: (id: ThreadId) => void;
    apply: ApplyControls;
    replacements: Replacements;
    closeComposer: (id: ThreadId | null) => void;
}

function railItems(input: RailInput): RailItem[] {
    const { store, snapshot, view, now } = input;
    const placed: (RailItem & { at: Offset })[] = [];
    for (const thread of snapshot.threads) {
        if (thread.state === "resolved" && !input.showResolved && thread.id !== input.activeId) {
            continue;
        }
        const at = threadPosition(view, thread);
        placed.push({
            key: thread.id,
            at,
            anchor: () => input.threadElement(thread.id, at),
            node: (
                <ThreadCard
                    store={store}
                    thread={thread}
                    active={thread.id === input.activeId}
                    now={now}
                    hold={snapshot.settings.hold}
                    onActivate={() => input.activate(thread.id)}
                    apply={input.apply}
                />
            ),
        });
    }
    for (const replacement of input.replacements.placed) {
        const { start } = replacement;
        placed.push({
            key: `replaced-${replacement.id}`,
            at: start,
            anchor: () => input.unitElement(start),
            node: <ReplacedCard replacement={replacement} replacements={input.replacements} />,
        });
    }
    for (const edit of view.userEdits) {
        const at = editRange(snapshot.doc.source, edit)?.start ?? edit.start;
        placed.push({
            key: `edit-${edit.seq}`,
            at,
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
