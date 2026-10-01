import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { flattenUnits } from "../src/core/blocks.ts";
import { isUnresolved, type Range, type Unit } from "../src/core/model.ts";
import { proposeEdit } from "./agent.ts";
import type { MemoryStore } from "./memory-store.ts";
import { editable, plainPhrase } from "./seed.ts";

/** Mockup-only controls for events the static page cannot cause itself. Not part of the client. */
export function DemoMenu({ store }: { store: MemoryStore }): JSX.Element {
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState("");

    const agentEditsOpenUnit = () => {
        const editor = document.querySelector("[data-editing]");
        const { doc } = store.snapshot();
        const unit = editor
            ? flattenUnits(doc.units).find(
                  (candidate) =>
                      candidate.start === Number(editor.getAttribute("data-unit")) &&
                      candidate.kind === editor.getAttribute("data-kind"),
              )
            : undefined;
        if (!unit) {
            setNote("Click a passage to edit it first, then try again.");
            return;
        }
        const { range, replace } = agentChange(doc.source, unit);
        store.agentFind(range, replace, { apply: true, note: "Tightened this passage." });
        setNote("");
    };

    const changeOnDisk = () => {
        const { doc } = store.snapshot();
        const paragraphs = doc.units.filter(
            (unit) => unit.kind === "paragraph" && unit.end - unit.start > 160,
        );
        const unit = paragraphs[Math.floor(paragraphs.length * 0.85)] ?? paragraphs[0];
        if (unit) {
            const { range, replace } = agentChange(doc.source, unit);
            store.simulateOutsideChange(range, replace);
        }
    };

    const resolveAll = () => {
        for (const thread of store.snapshot().threads.filter(isUnresolved)) {
            store.agentResolve(thread.id);
        }
    };

    return (
        <div class="demo">
            {open ? (
                <div class="demo-panel" onMouseDown={(event) => event.preventDefault()}>
                    <p class="demo-title">Mockup controls</p>
                    <button type="button" onClick={agentEditsOpenUnit}>
                        Agent edits the passage you're editing
                    </button>
                    <button type="button" onClick={changeOnDisk}>
                        Change the file on disk
                    </button>
                    <button type="button" onClick={resolveAll}>
                        Resolve every thread
                    </button>
                    <button type="button" onClick={() => store.ageWorking(11 * 60_000)}>
                        Fast-forward 11 minutes
                    </button>
                    {note ? <p class="demo-note">{note}</p> : null}
                </div>
            ) : null}
            <button
                type="button"
                class="demo-toggle"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setOpen(!open)}
            >
                {open ? "Close" : "Mockup controls"}
            </button>
        </div>
    );
}

function agentChange(source: string, unit: Unit): { range: Range; replace: string } {
    const range = plainPhrase(source, unit, 160, editable);
    if (range) {
        return { range, replace: proposeEdit(source.slice(range.start, range.end))! };
    }
    const text = source.slice(unit.start, unit.end);
    return { range: { start: unit.start, end: unit.end }, replace: `${text} (revised)` };
}
