import type { ComponentChildren, JSX } from "preact";
import { useId, useRef } from "preact/hooks";

/** The least room a tip keeps from the window's edges. */
const EDGE_PX = 8;

interface TooltipProps {
    /** One line of text, or lines of content such as a list of agents. */
    text: ComponentChildren;
    /**
     * Which edge of the trigger the tip lines up with. Near the bar's ends a centred tip would run
     * past the window, which the page clips.
     */
    align?: "start" | "center" | "end";
    /** Above the trigger for one docked at the bottom of the window. */
    side?: "below" | "above";
    /** Renders the trigger; it gets the tip's id for its aria-describedby. */
    children: (tipId: string) => ComponentChildren;
}

/** How far to slide a tip spanning `left` to `right` so it stays inside a window `width` wide. */
export function tipShift(left: number, right: number, width: number): number {
    if (left < EDGE_PX) {
        return EDGE_PX - left;
    }
    if (right > width - EDGE_PX) {
        return Math.max(EDGE_PX - left, width - EDGE_PX - right);
    }
    return 0;
}

/**
 * A small tip below its trigger on hover and keyboard focus. Native titles do not show in Orca's
 * browser, so the bar's icon buttons use this instead. The hidden tip keeps its layout, so it is
 * measured as it starts to show and slid back inside the window.
 */
export function Tooltip({
    text,
    align = "center",
    side = "below",
    children,
}: TooltipProps): JSX.Element {
    const id = useId();
    const tip = useRef<HTMLSpanElement>(null);
    const classes = `tip tip-${align}${side === "above" ? " tip-above" : ""}`;
    const fit = () => {
        const node = tip.current;
        if (!node) {
            return;
        }
        node.style.removeProperty("--tip-shift");
        const { left, right } = node.getBoundingClientRect();
        const shift = tipShift(left, right, document.documentElement.clientWidth);
        if (shift !== 0) {
            node.style.setProperty("--tip-shift", `${shift}px`);
        }
    };
    return (
        <span class="tip-host" onPointerEnter={fit} onFocusIn={fit}>
            {children(id)}
            <span id={id} role="tooltip" class={classes} ref={tip}>
                {text}
            </span>
        </span>
    );
}
