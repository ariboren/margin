import { useEffect, useState } from "preact/hooks";
import type { DocStore, StoreStatus } from "../core/model.ts";
import {
    initialPresence,
    nextPresenceDeadline,
    updatePresence,
    type PresenceState,
} from "./components/presence.ts";
import type { ClientSnapshot } from "./server-store.ts";

export interface PresenceView {
    state: PresenceState;
    status: StoreStatus;
    /** The time the state was last evaluated at; re-renders arrive when the view changes on its own. */
    clock: number;
}

function useStoreStatus(store: DocStore): StoreStatus {
    const [status, setStatus] = useState<StoreStatus>(
        () => store.status?.() ?? { connection: "live" },
    );
    useEffect(() => store.subscribeStatus?.(setStatus), [store]);
    return status;
}

/** Re-renders once `deadline` passes. */
function useDeadline(deadline: number | null): void {
    const [, bump] = useState(0);
    useEffect(() => {
        if (deadline === null) {
            return;
        }
        const timer = setTimeout(() => bump((n) => n + 1), Math.max(0, deadline - Date.now()));
        return () => clearTimeout(timer);
    }, [deadline]);
}

/** The one presence fold behind the agent chip and the tab icon. */
export function usePresence(store: DocStore, snapshot: ClientSnapshot): PresenceView {
    const status = useStoreStatus(store);
    const { connection } = status;
    const { agents, expected, agentSeenAt: seenAt } = snapshot;
    const [state, setState] = useState(() =>
        initialPresence({ agents, expected, seenAt, connection }, Date.now()),
    );
    useEffect(() => {
        setState((current) =>
            updatePresence(current, { agents, expected, seenAt, connection }, Date.now()),
        );
    }, [agents, expected, seenAt, connection]);
    const clock = Date.now();
    useDeadline(nextPresenceDeadline(state, clock));
    return { state, status, clock };
}
