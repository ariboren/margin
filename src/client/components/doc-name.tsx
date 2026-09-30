import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { copyText } from "../clipboard.ts";

/** Where the doc lives and how to open things from it. The host (mockup or daemon) supplies it. */
export interface DocLocation {
    /** Absolute path on disk. */
    path: string;
    /** Path relative to the doc's repository root. */
    relativePath: string;
    /**
     * Opens the doc (no argument), or a file a relative link in it points to, in a normal file
     * tab. The daemon does this; the page never names a path.
     */
    openFile?: (link?: string) => void;
    /** Opens an http(s) link where a plain link cannot: Orca's browser blocks popups. */
    openUrl?: (url: string) => void;
    /** For a host with no daemon (the mockup): a URL for the doc's text. */
    rawUrl?: () => string;
}

function openDoc(location: DocLocation): void {
    if (location.openFile) {
        location.openFile();
    } else if (location.rawUrl) {
        window.open(location.rawUrl(), "_blank", "noopener");
    }
}

/** The filename; hovering shows the full path with open and copy actions, ⌘/Ctrl-click opens the file. */
export function DocName({ location }: { location: DocLocation }): JSX.Element {
    const [copied, setCopied] = useState<"path" | "relative" | null>(null);
    const name = location.path.split("/").pop() ?? location.path;
    const copy = async (which: "path" | "relative") => {
        if (await copyText(which === "path" ? location.path : location.relativePath)) {
            setCopied(which);
            setTimeout(() => setCopied(null), 1400);
        }
    };
    return (
        <span class="doc-name">
            <button
                type="button"
                class="doc-name-button"
                aria-haspopup="true"
                onClick={(event) => {
                    if (event.metaKey || event.ctrlKey) {
                        openDoc(location);
                    }
                }}
            >
                {name}
            </button>
            <span class="doc-name-menu" role="group" aria-label="File">
                <span class="doc-name-path">{location.path}</span>
                <span class="doc-name-actions">
                    <button
                        type="button"
                        class="button button-quiet"
                        onClick={() => openDoc(location)}
                    >
                        Open file
                    </button>
                    <button
                        type="button"
                        class="button button-quiet"
                        onClick={() => void copy("path")}
                    >
                        {copied === "path" ? "Copied" : "Copy path"}
                    </button>
                    <button
                        type="button"
                        class="button button-quiet"
                        onClick={() => void copy("relative")}
                    >
                        {copied === "relative" ? "Copied" : "Copy relative path"}
                    </button>
                </span>
                <span class="doc-name-hint">⌘-click the name to open the file</span>
            </span>
        </span>
    );
}
