import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { copyText } from "../clipboard.ts";
import type { Replacement } from "../replacements.ts";
import type { Replacements } from "../use-replacements.ts";
import { CardHead } from "./card-head.tsx";
import { Icon } from "./icons.tsx";

/**
 * Beside a unit where "keep mine" overwrote the agent's version: shows both, puts theirs back.
 * Collapsed to its label and the start of their text until opened.
 */
export function ReplacedCard({
    replacement,
    replacements,
}: {
    replacement: Replacement;
    replacements: Replacements;
}): JSX.Element {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [copied, setCopied] = useState<"theirs" | "mine" | null>(null);
    const restore = async () => {
        setBusy(true);
        setNotice(await replacements.restore(replacement));
        setBusy(false);
    };
    const copy = async (which: "theirs" | "mine") => {
        const text = which === "theirs" ? replacement.replaced : replacement.mine;
        if (await copyText(text)) {
            setCopied(which);
        }
    };
    // One article either way: the quote is the same element open or closed, so opening only
    // reveals the note and the actions under it. Collapsed, a click anywhere opens it.
    return (
        <article
            class={open ? "card card-edit" : "card card-edit card-collapsed"}
            data-card={`replaced-${replacement.id}`}
            onClick={open ? undefined : () => setOpen(true)}
        >
            <CardHead
                expanded={open}
                onToggle={open ? () => setOpen(false) : undefined}
                pill={<span class="pill pill-edit">Kept your text</span>}
            />
            <blockquote class="replaced-text">{replacement.replaced || "(empty)"}</blockquote>
            {open ? <p class="card-note">Agent's version, which your text replaced.</p> : null}
            {notice ? (
                <p class="card-notice" role="alert">
                    {notice}
                </p>
            ) : null}
            {open ? (
                <div class="card-actions">
                    <button
                        type="button"
                        class="button button-quiet"
                        onClick={() => void copy("theirs")}
                    >
                        <Icon name={copied === "theirs" ? "check" : "copy"} />
                        {copied === "theirs" ? "Copied" : "Copy theirs"}
                    </button>
                    <button
                        type="button"
                        class="button button-quiet"
                        onClick={() => void copy("mine")}
                    >
                        <Icon name={copied === "mine" ? "check" : "copy"} />
                        {copied === "mine" ? "Copied" : "Copy yours"}
                    </button>
                    <span class="card-actions-end">
                        <button
                            type="button"
                            class="button button-quiet"
                            disabled={busy}
                            onClick={() => replacements.dismiss(replacement)}
                        >
                            <Icon name="close" />
                            Dismiss
                        </button>
                        {replacement.refused ? null : (
                            <button
                                type="button"
                                class="button"
                                disabled={busy}
                                onClick={() => void restore()}
                            >
                                <Icon name="undo" />
                                Restore
                            </button>
                        )}
                    </span>
                </div>
            ) : null}
        </article>
    );
}
