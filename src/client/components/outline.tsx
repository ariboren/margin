import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { OutlineEntry } from "../view-model.ts";

interface OutlineProps {
    entries: OutlineEntry[];
    onNavigate?: () => void;
}

/** Headings with a count of open threads under each; the section in view is marked. */
export function Outline({ entries, onNavigate }: OutlineProps): JSX.Element {
    const current = useCurrentHeading(entries);
    const minDepth = Math.min(...entries.map((entry) => entry.depth));
    return (
        <nav class="toc" aria-label="Outline">
            <p class="toc-title">Outline</p>
            <ol>
                {entries.map((entry) => (
                    <li
                        key={entry.start}
                        style={{ paddingLeft: `${(entry.depth - minDepth) * 12}px` }}
                    >
                        <a
                            href={`#h-${entry.start}`}
                            class={entry.start === current ? "toc-link toc-current" : "toc-link"}
                            onClick={(event) => {
                                event.preventDefault();
                                document
                                    .getElementById(`h-${entry.start}`)
                                    ?.scrollIntoView({ block: "start", behavior: "smooth" });
                                onNavigate?.();
                            }}
                        >
                            <span class="toc-text">{entry.text}</span>
                            {entry.openThreads > 0 ? (
                                <span
                                    class="toc-count"
                                    aria-label={`${entry.openThreads} open threads`}
                                >
                                    {entry.openThreads}
                                </span>
                            ) : null}
                        </a>
                    </li>
                ))}
            </ol>
        </nav>
    );
}

function useCurrentHeading(entries: OutlineEntry[]): number | null {
    const [current, setCurrent] = useState<number | null>(null);
    useEffect(() => {
        let frame = 0;
        const update = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                let found: number | null = entries[0]?.start ?? null;
                for (const entry of entries) {
                    const element = document.getElementById(`h-${entry.start}`);
                    if (element && element.getBoundingClientRect().top < 140) {
                        found = entry.start;
                    }
                }
                setCurrent(found);
            });
        };
        update();
        window.addEventListener("scroll", update, { passive: true });
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener("scroll", update);
        };
    }, [entries]);
    return current;
}
