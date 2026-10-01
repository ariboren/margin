import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export interface RailItem {
    key: string;
    /** Finds the element this card sits beside (a highlight, or the unit for a detached quote). */
    anchor: () => Element | null;
    node: ComponentChildren;
    /** Fades out on leaving the rail instead of vanishing at once. */
    fade?: boolean;
    /** Yields its spot to thread cards; see `stackCards`. */
    givesWay?: boolean;
}

interface MarginRailProps {
    items: RailItem[];
    activeKey: string | null;
    /** Cards float beside their anchors; otherwise they stack in a scrolling drawer. */
    floating: boolean;
}

/** How long a leaving card stays, fading; matches the `rail-slot-leaving` animation. */
const fadeMs = 200;

/**
 * Cards that left `items` and still fade: those of the last render that asked to, plus the ones
 * still fading from before, minus any that came back.
 */
export function updateLeaving(
    previous: RailItem[],
    current: RailItem[],
    leaving: Map<string, RailItem>,
): Map<string, RailItem> {
    const shown = new Set(current.map((item) => item.key));
    const next = new Map<string, RailItem>();
    for (const [key, item] of leaving) {
        if (!shown.has(key)) {
            next.set(key, item);
        }
    }
    for (const item of previous) {
        if (item.fade && !shown.has(item.key) && !next.has(item.key)) {
            next.set(item.key, item);
        }
    }
    return next;
}

export function MarginRail({ items, activeKey, floating }: MarginRailProps): JSX.Element {
    const rail = useRef<HTMLDivElement>(null);
    /** Where each card was placed last; a leaving card keeps it. */
    const tops = useRef<Map<string, number>>(new Map());
    /** Where each card's anchor last was; a card whose anchor is gone holds it. */
    const wants = useRef<Map<string, number>>(new Map());
    const previous = useRef<RailItem[]>([]);
    const leaving = useRef<Map<string, RailItem>>(new Map());
    const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const lastKeys = useRef<string | null>(null);
    const [, setTick] = useState(0);
    const keys = items.map((item) => item.key).join(" ");

    // Decided during render so a leaving slot keeps its DOM node and only changes class; an effect
    // would let it unmount first and come back hidden, waiting to be placed.
    leaving.current = floating
        ? updateLeaving(previous.current, items, leaving.current)
        : new Map();
    previous.current = items;
    const leavingKeys = [...leaving.current.keys()].join(" ");

    useEffect(() => {
        for (const key of leaving.current.keys()) {
            if (timers.current.has(key)) {
                continue;
            }
            timers.current.set(
                key,
                setTimeout(() => {
                    timers.current.delete(key);
                    leaving.current.delete(key);
                    setTick((tick) => tick + 1);
                }, fadeMs),
            );
        }
    }, [leavingKeys]);
    useEffect(
        () => () => {
            for (const timer of timers.current.values()) {
                clearTimeout(timer);
            }
        },
        [],
    );

    // Any card growing (a reply box opening, text wrapping) or the doc reflowing re-runs the layout.
    useEffect(() => {
        const bump = () => setTick((tick) => tick + 1);
        const observer = new ResizeObserver(bump);
        observer.observe(document.body);
        for (const slot of rail.current?.querySelectorAll("[data-rail-key]") ?? []) {
            observer.observe(slot);
        }
        void (async () => {
            await document.fonts.ready;
            bump();
        })();
        return () => observer.disconnect();
    }, [keys, floating]);

    // Positions are written straight to the slots before the browser paints. Cards glide only
    // while the set of cards is unchanged (a card activating or growing, the doc reflowing); a
    // card arriving or leaving places everything at once, so nothing slides into a slot that was
    // already its own. A leaving card keeps the top it had. A card whose anchor is gone (its
    // block under an editor) holds the place its anchor had, not the place it was stacked to,
    // so the next pass cannot push it further from its mark.
    useLayoutEffect(() => {
        const element = rail.current;
        if (!floating || !element) {
            lastKeys.current = null;
            return;
        }
        const still = lastKeys.current !== keys;
        lastKeys.current = keys;
        const base = element.getBoundingClientRect().top;
        const slots = new Map<string, HTMLElement>();
        for (const slot of element.querySelectorAll<HTMLElement>(
            "[data-rail-key]:not([data-rail-leaving])",
        )) {
            slots.set(slot.dataset.railKey!, slot);
        }
        const nextWants = new Map<string, number>();
        const measured = items.map((item) => {
            const anchor = item.anchor();
            const want = anchor
                ? anchor.getBoundingClientRect().top - base
                : (wants.current.get(item.key) ?? tops.current.get(item.key) ?? 0);
            nextWants.set(item.key, want);
            return {
                key: item.key,
                want,
                height: slots.get(item.key)?.offsetHeight ?? 0,
                givesWay: item.givesWay ?? false,
                block: anchor?.closest("[data-unit]") ?? undefined,
            };
        });
        wants.current = nextWants;
        const next = stackCards(measured, activeKey, 12);
        if (still) {
            element.classList.add("rail-still");
        }
        for (const [key, top] of next) {
            const slot = slots.get(key);
            if (!slot) {
                continue;
            }
            slot.style.top = `${top}px`;
            if (!("placed" in slot.dataset)) {
                slot.dataset.placed = "";
                slot.style.visibility = "visible";
            }
        }
        if (still) {
            // Commit the positions before the slide comes back on.
            void element.offsetHeight;
            element.classList.remove("rail-still");
        }
        for (const key of leaving.current.keys()) {
            const top = tops.current.get(key);
            if (top !== undefined) {
                next.set(key, top);
            }
        }
        tops.current = next;
    });

    if (!floating) {
        return (
            <div class="rail rail-drawer" ref={rail}>
                {items.map((item) => (
                    <div key={item.key} data-rail-key={item.key}>
                        {item.node}
                    </div>
                ))}
            </div>
        );
    }
    // One keyed list, so a card that starts leaving keeps its element and only changes class.
    const slots = [
        ...items.map((item) => (
            <div
                key={item.key}
                data-rail-key={item.key}
                class={item.key === activeKey ? "rail-slot rail-slot-active" : "rail-slot"}
            >
                {item.node}
            </div>
        )),
        ...[...leaving.current.values()].map((item) => (
            <div
                key={item.key}
                data-rail-key={item.key}
                data-rail-leaving=""
                class="rail-slot rail-slot-leaving"
            >
                {item.node}
            </div>
        )),
    ];
    return (
        <div class="rail rail-floating" ref={rail}>
            {slots}
        </div>
    );
}

interface Measured {
    key: string;
    want: number;
    height: number;
    /** Moves up to fit above the next firm card rather than pushing it off its anchor. */
    givesWay?: boolean;
    /**
     * The block the anchor sits in. A block's edge and a mark inside it have no document order
     * between them, so within one block the thread cards come first and the giving-way cards
     * after, whatever their pixel offsets.
     */
    block?: unknown;
}

/**
 * Places cards as close to their anchors as possible without overlap, always in anchor order:
 * blocks top to bottom, thread cards before giving-way cards within a block, then cards wanting
 * the same spot in their given order. No card ever passes another whatever their heights. The
 * active card sits exactly at its anchor; cards above it move up and cards below move down to
 * make room. A card that gives way (a user edit, a kept text) first moves up as far as it must
 * to leave the next firm card at its anchor; only when there is no room above does it push cards
 * down like any other.
 */
export function stackCards(
    measured: Measured[],
    activeKey: string | null,
    gap: number,
): Map<string, number> {
    const sorted = sortByAnchor(measured);
    const tops = sorted.map((item) => item.want);
    // Walking up from each firm card, the ceiling under which a run of giving-way cards still
    // fits above it; a card below its ceiling stays at its anchor and lends no room upward.
    let ceiling = Number.POSITIVE_INFINITY;
    for (let i = sorted.length - 1; i >= 0; i--) {
        const item = sorted[i]!;
        if (!item.givesWay || item.key === activeKey) {
            ceiling = tops[i]!;
            continue;
        }
        ceiling -= item.height + gap;
        tops[i] = Math.min(tops[i]!, ceiling);
    }
    const pivot = Math.max(
        0,
        sorted.findIndex((item) => item.key === activeKey),
    );
    for (let i = pivot + 1; i < sorted.length; i++) {
        tops[i] = Math.max(tops[i]!, tops[i - 1]! + sorted[i - 1]!.height + gap);
    }
    for (let i = pivot - 1; i >= 0; i--) {
        tops[i] = Math.min(tops[i]!, tops[i + 1]! - sorted[i]!.height - gap);
    }
    // A run pushed above the rail's top comes back down to it and pushes only the cards it then
    // overlaps, so every card below that run, the active one included, keeps its anchor.
    for (let i = 0; i < sorted.length; i++) {
        tops[i] = Math.max(tops[i]!, 0, i > 0 ? tops[i - 1]! + sorted[i - 1]!.height + gap : 0);
    }
    return new Map(sorted.map((item, i) => [item.key, Math.round(tops[i]!)]));
}

function sortByAnchor<T extends Measured>(measured: T[]): T[] {
    const blockOf = (item: Measured) => item.block ?? item;
    const positions = new Map<unknown, number>();
    for (const item of measured) {
        const block = blockOf(item);
        positions.set(block, Math.min(positions.get(block) ?? Number.POSITIVE_INFINITY, item.want));
    }
    return [...measured].sort(
        (a, b) =>
            positions.get(blockOf(a))! - positions.get(blockOf(b))! ||
            (blockOf(a) === blockOf(b)
                ? Number(a.givesWay ?? false) - Number(b.givesWay ?? false)
                : 0) ||
            a.want - b.want,
    );
}
