import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ThreadId, Unit } from "../../core/model.ts";
import type { Decoration } from "../view-model.ts";

export interface RenderContext {
    source: string;
    /** Added to mdast offsets to get source offsets. */
    shift: number;
    decorations: Decoration[];
    activeId: ThreadId | "new" | null;
    units: Unit[];
    unitsByKey: Map<string, Unit>;
    /** Render key for a unit's block, stable while the unit is followed across reparses. */
    blockKeys: Map<Unit, string>;
    /** Renders the raw editor in place of `unit` when it is the one being edited, else null. */
    editorFor: (unit: Unit) => ComponentChildren | null;
    onEditAsSource: (unit: Unit) => void;
    /** Every link click in the doc goes through here: in-doc anchors, repo files, the web. */
    followLink: (event: MouseEvent, url: string) => void;
}

export const Render = createContext<RenderContext | null>(null);

export function useRender(): RenderContext {
    const context = useContext(Render);
    if (!context) {
        throw new Error("render context missing");
    }
    return context;
}
