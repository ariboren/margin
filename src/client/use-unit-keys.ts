import { useRef } from "preact/hooks";
import { carryKeys } from "../core/align.ts";
import type { Unit } from "../core/model.ts";

/**
 * Stable render keys for units across reparses: a unit keeps its key while alignment follows it,
 * so an edit above a block (which shifts every offset below) does not remount it, or the editor
 * open inside it.
 */
export function useUnitKeys(units: Unit[]): Map<Unit, string> {
    const state = useRef<{ units: Unit[]; keys: Map<Unit, string>; minted: number } | null>(null);
    const current = state.current;
    if (!current || current.units !== units) {
        let minted = current?.minted ?? 0;
        const keys = carryKeys(
            current?.keys ?? new Map(),
            current?.units ?? [],
            units,
            () => `u${++minted}`,
        );
        state.current = { units, keys, minted };
    }
    return state.current!.keys;
}
