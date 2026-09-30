import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { copyText } from "../clipboard.ts";
import type { Replacement } from "../replacements.ts";
import type { Replacements } from "../use-replacements.ts";

/** Beside a unit where "keep mine" overwrote the agent's version: shows both, puts theirs back. */
export function ReplacedCard({
    replacement,
    replacements,
}: {
    replacement: Replacement;
    replacements: Replacements;
}): JSX.Element {
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
    return (
        <article class="card card-edit" data-card={`replaced-${replacement.id}`}>
            <header class="card-head">
                <span class="pill pill-edit">Replaced the agent's version</span>
            </header>
            <p class="card-note">You kept your text. The agent's version was:</p>
            <blockquote class="replaced-text">{replacement.replaced || "(empty)"}</blockquote>
            {notice ? (
                <p class="card-notice" role="alert">
                    {notice}
                </p>
            ) : null}
            <div class="card-actions">
                <button
                    type="button"
                    class="button button-quiet"
                    onClick={() => void copy("theirs")}
                >
                    {copied === "theirs" ? "Copied" : "Copy theirs"}
                </button>
                <button type="button" class="button button-quiet" onClick={() => void copy("mine")}>
                    {copied === "mine" ? "Copied" : "Copy yours"}
                </button>
                <span class="card-actions-end">
                    <button
                        type="button"
                        class="button button-quiet"
                        disabled={busy}
                        onClick={() => replacements.dismiss(replacement)}
                    >
                        Dismiss
                    </button>
                    {replacement.refused ? null : (
                        <button
                            type="button"
                            class="button"
                            disabled={busy}
                            onClick={() => void restore()}
                        >
                            Restore
                        </button>
                    )}
                </span>
            </div>
        </article>
    );
}
