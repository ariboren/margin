import type { JSX } from "preact";
import type { AgentClient } from "../../core/model.ts";

interface MarkProps {
    /** Width and height in px. */
    size?: number;
}

/**
 * A terminal prompt (`>_`) in a rounded frame, in the current colour, at the bar icons' 1.5
 * stroke. Straight edges sit on the 16 px grid so their outer edges land on whole pixels. It
 * stands for every client until that client's official mark is added below; it is also the
 * fallback for an unknown client.
 */
function NeutralMark({ size = 14 }: MarkProps): JSX.Element {
    return (
        <svg
            class="agent-mark"
            viewBox="0 0 16 16"
            width={size}
            height={size}
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" />
            <path d="M4.75 6l2 2-2 2M8.75 10.25h2.5" />
        </svg>
    );
}

// Claude mark, supplied by the owner 2026-09-30 (~/Downloads/claude.svg); trademark of Anthropic, PBC.
function ClaudeMark({ size = 14 }: MarkProps): JSX.Element {
    return (
        <svg
            class="agent-mark"
            viewBox="0 0 100 100"
            width={size}
            height={size}
            aria-hidden="true"
            fill="hsl(14.8, 63.1%, 59.6%)"
        >
            <path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
        </svg>
    );
}

/**
 * The mark shown for each client, one entry per vendor so a mark goes in or out in one line. A
 * vendor's entry takes its official asset, unmodified; nothing here is ever redrawn, so until
 * that asset is in hand the entry stays on the neutral prompt.
 */
const MARKS: Record<AgentClient, (props: MarkProps) => JSX.Element> = {
    "claude-code": ClaudeMark,
    codex: NeutralMark,
    cursor: NeutralMark,
    unknown: NeutralMark,
};

export function AgentMark({ client, size }: MarkProps & { client: AgentClient }): JSX.Element {
    const Mark = MARKS[client];
    return <Mark size={size} />;
}
