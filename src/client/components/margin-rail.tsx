import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export interface RailItem {
    key: string;
    /** Finds the element this card sits beside (a highlight, or the unit for a detached quote). */
    anchor: () => Element | null;
    node: ComponentChildren;
}

interface MarginRailProps {
    items: RailItem[];
    activeKey: string | null;
    /** Cards float beside their anchors; otherwise they stack in a scrolling drawer. */
    floating: boolean;
}

export function MarginRail({ items, activeKey, floating }: MarginRailProps): JSX.Element {
    const rail = useRef<HTMLDivElement>(null);
    const tops = useRef<Map<string, number>>(new Map());
    const [, setTick] = useState(0);
    const keys = items.map((item) => item.key).join(" ");

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

    // Positions are written straight to the slots before the browser paints. A slot placed for the
    // first time skips the slide, so a card never shows at the top of the rail and glides down.
    useLayoutEffect(() => {
        const element = rail.current;
        if (!floating || !element) {
            return;
        }
        const base = element.getBoundingClientRect().top;
        const slots = new Map<string, HTMLElement>();
        for (const slot of element.querySelectorAll<HTMLElement>("[data-rail-key]")) {
            slots.set(slot.dataset.railKey!, slot);
        }
        const measured = items.map((item) => {
            const anchor = item.anchor();
            return {
                key: item.key,
                want: anchor
                    ? anchor.getBoundingClientRect().top - base
                    : (tops.current.get(item.key) ?? 0),
                height: slots.get(item.key)?.offsetHeight ?? 0,
            };
        });
        const next = stackCards(measured, activeKey, 12);
        for (const [key, top] of next) {
            const slot = slots.get(key);
            if (!slot) {
                continue;
            }
            if ("placed" in slot.dataset) {
                slot.style.top = `${top}px`;
                continue;
            }
            slot.dataset.placed = "";
            slot.style.transition = "none";
            slot.style.top = `${top}px`;
            slot.style.visibility = "visible";
            // Commit the first position before the slide comes back on.
            void slot.offsetHeight;
            slot.style.transition = "";
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
    return (
        <div class="rail rail-floating" ref={rail}>
            {items.map((item) => (
                <div
                    key={item.key}
                    data-rail-key={item.key}
                    class={item.key === activeKey ? "rail-slot rail-slot-active" : "rail-slot"}
                >
                    {item.node}
                </div>
            ))}
        </div>
    );
}

interface Measured {
    key: string;
    want: number;
    height: number;
}

/**
 * Places cards as close to their anchors as possible without overlap. The active card sits exactly at
 * its anchor; cards above it move up and cards below move down to make room.
 */
export function stackCards(
    measured: Measured[],
    activeKey: string | null,
    gap: number,
): Map<string, number> {
    const sorted = [...measured].sort((a, b) => a.want - b.want);
    const tops = sorted.map((item) => item.want);
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
    const floor = Math.min(0, ...tops);
    return new Map(sorted.map((item, index) => [item.key, Math.round(tops[index]! - floor)]));
}
