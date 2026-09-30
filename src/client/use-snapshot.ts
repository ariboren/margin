import { useEffect, useState } from "preact/hooks";
import type { DocSnapshot, DocStore } from "../core/model.ts";

export function useSnapshot(store: DocStore): DocSnapshot {
    const [snapshot, setSnapshot] = useState(() => store.snapshot());
    useEffect(() => {
        setSnapshot(store.snapshot());
        return store.subscribe(setSnapshot);
    }, [store]);
    return snapshot;
}
