import type { ComponentChildren, JSX } from "preact";

interface CardHeadProps {
    expanded: boolean;
    /** Off, the header is plain text: the card never collapses. */
    interactive?: boolean;
    /** The header button's click; a collapsed thread card leaves it to the card's own activation. */
    onToggle?: () => void;
    pill: ComponentChildren;
    meta?: ComponentChildren;
    /** One line under the pill row while collapsed; the CSS ellipsis clips it. */
    summary?: ComponentChildren;
}

/**
 * A card's header in both states: the pill row stays where it is, so expanding does not move it,
 * and the summary row shows only while collapsed. One button either way, so the focus that
 * expanded the card stays on it.
 */
export function CardHead({
    expanded,
    interactive = true,
    onToggle,
    pill,
    meta,
    summary,
}: CardHeadProps): JSX.Element {
    const rows = (
        <>
            <span class="card-head-row">
                {pill}
                {meta ? <span class="card-meta">{meta}</span> : null}
            </span>
            {summary ? (
                // Kept in the DOM while expanded: a click on it that expanded the card must still
                // read as a click inside the card to the page's deselect handler.
                <span class="card-summary" hidden={expanded}>
                    <span class="card-summary-text">{summary}</span>
                </span>
            ) : null}
        </>
    );
    return (
        <header class="card-head">
            {interactive ? (
                <button
                    type="button"
                    class="card-toggle"
                    aria-expanded={expanded}
                    onClick={onToggle}
                >
                    {rows}
                </button>
            ) : (
                <span class="card-toggle">{rows}</span>
            )}
        </header>
    );
}
