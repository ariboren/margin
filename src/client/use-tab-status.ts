import { useEffect, useRef, useState } from "preact/hooks";
import type { DocSnapshot } from "../core/model.ts";
import { ICON_ELEMENT } from "../server/protocol.ts";
import type { AgentChipKind } from "./components/agent-chip.tsx";
import { baseTitle, tabStatus, unreadAgentMessages } from "./tab-status.ts";
import { latestAgentSeq } from "./view-model.ts";

function iconLink(): HTMLLinkElement {
    let link = document.getElementById(ICON_ELEMENT) as HTMLLinkElement | null;
    if (!link) {
        link = document.createElement("link");
        link.id = ICON_ELEMENT;
        link.rel = "icon";
        document.head.append(link);
    }
    return link;
}

function useHidden(): boolean {
    const [hidden, setHidden] = useState(() => document.hidden);
    useEffect(() => {
        const update = () => setHidden(document.hidden);
        document.addEventListener("visibilitychange", update);
        return () => document.removeEventListener("visibilitychange", update);
    }, []);
    return hidden;
}

/**
 * Keeps the tab's icon and title in step with the agent: a dot for its standing, and while the
 * tab is hidden, a count of replies that landed since the user last looked. A reply seen with the
 * tab visible is never counted, so the count only ever means news.
 */
export function useTabStatus(snapshot: DocSnapshot, kind: AgentChipKind): void {
    const hidden = useHidden();
    const latest = latestAgentSeq(snapshot.threads);
    const [seen, setSeen] = useState(latest);
    useEffect(() => {
        if (!hidden) {
            setSeen(latest);
        }
    }, [hidden, latest]);
    const unread = hidden ? unreadAgentMessages(snapshot.threads, seen) : 0;
    const base = useRef<string | null>(null);
    useEffect(() => {
        base.current ??= baseTitle(document.title);
        const { href, title } = tabStatus({ kind, unread }, base.current);
        iconLink().href = href;
        document.title = title;
    }, [kind, unread]);
}
