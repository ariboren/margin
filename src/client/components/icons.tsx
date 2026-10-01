import type { JSX } from "preact";

const paths = {
    check: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5zM5.25 8.25l2 2 3.5-4",
    slash: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5zM3.6 3.6l8.8 8.8",
    reopen: "M2.75 8a5.25 5.25 0 1 0 1.7-3.85M2.5 2v3h3",
    undo: "M5.5 3.5 2.5 6.5l3 3M2.5 6.5h7a4 4 0 0 1 0 8H7",
    open: "M9.5 2.5h4v4M13.5 2.5l-6 6M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3",
    folder: "M1.75 4.5a1 1 0 0 1 1-1h3.1l1.5 1.5h5.9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z",
    copy: "M6.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2",
    trash: "M2.5 4.5h11M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5M4 4.5l.6 8.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.1M6.75 7v4M9.25 7v4",
    send: "M14 2 7.25 8.75M14 2 9.75 13.75l-2.5-5-5-2.5z",
    plus: "M8 3.25v9.5M3.25 8h9.5",
} as const;

export type IconName = keyof typeof paths;

/**
 * A decorative mark beside a button's label. Its look is carried as attributes, so it draws the
 * same wherever it is placed, with no stylesheet rule to match.
 */
export function Icon({ name }: { name: IconName }): JSX.Element {
    return (
        <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            style={{ flex: "none" }}
            aria-hidden="true"
        >
            <path d={paths[name]} />
        </svg>
    );
}
