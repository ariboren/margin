import type { ComponentChildren, JSX } from "preact";
import { linkKind } from "../links.ts";

interface DocLinkProps {
    url: string;
    title?: string | null;
    /** Every link click goes through here: in-doc anchors, repo files, the web. */
    followLink: (event: MouseEvent, url: string) => void;
    children: ComponentChildren;
}

/**
 * A markdown link from untrusted text (the doc or a thread message). Only the kinds `linkKind`
 * allows get an `href`; the rest render as inert text that shows the URL on hover.
 */
export function DocLink({ url, title, followLink, children }: DocLinkProps): JSX.Element {
    const kind = linkKind(url);
    if (kind === "inert") {
        return (
            <span class="md-link-inert" title={url}>
                {children}
            </span>
        );
    }
    return (
        <a
            href={url}
            title={title ?? undefined}
            {...(kind === "fragment" ? {} : { target: "_blank", rel: "noreferrer noopener" })}
            onClick={(event) => followLink(event, url)}
        >
            {children}
        </a>
    );
}
