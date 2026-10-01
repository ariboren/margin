import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

/** The slide back under the bar; matches the CSS transition. */
const EXIT_MS = 260;

/**
 * Keeps the last text mounted while it slides back under the bar, and paints a new one in its
 * hidden place before it slides out, so both directions animate.
 */
function useShownText(text: string | null): {
    shown: string | null;
    out: boolean;
    node: { current: HTMLDivElement | null };
} {
    const node = useRef<HTMLDivElement>(null);
    const [shown, setShown] = useState(text);
    const [out, setOut] = useState(false);
    useEffect(() => {
        if (text !== null) {
            setShown(text);
            return;
        }
        setOut(false);
        const timer = setTimeout(() => setShown(null), EXIT_MS);
        return () => clearTimeout(timer);
    }, [text]);
    useEffect(() => {
        if (shown !== null && text !== null) {
            // Forces the hidden position to be styled first, so the move out is a transition.
            node.current?.getBoundingClientRect();
            setOut(true);
        }
    }, [shown, text]);
    return { shown, out, node };
}

/**
 * A request the daemon refused, at the top centre under the bar until the store clears it. The
 * connection itself lives in the agent chip.
 */
export function RequestToast({ problem }: { problem: string | undefined }): JSX.Element | null {
    const { shown, out, node } = useShownText(problem ?? null);
    if (shown === null) {
        return null;
    }
    return (
        <div
            class={out ? "request-toast request-toast-out" : "request-toast"}
            ref={node}
            role="alert"
        >
            {shown}
        </div>
    );
}
