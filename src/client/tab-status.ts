// The browser tab as a status light: a dot in the agent's standing colour, and an unread count of
// agent replies that landed while the tab was hidden. Pure; `useTabStatus` applies it to the
// document.
import type { Thread } from "../core/model.ts";
import { faviconHref, type Dot } from "../core/favicon.ts";
import type { AgentChipKind } from "./components/agent-chip.tsx";

export interface TabInput {
    kind: AgentChipKind;
    /** Agent replies the user has not seen; counted only while the tab is hidden. */
    unread: number;
}

/** News beats standing; the daemon link beats the agent. */
export function dotFor(input: TabInput): Dot {
    if (input.unread > 0) return "accent";
    switch (input.kind) {
        case "offline":
            return "err";
        case "connected":
            return "ok";
        default:
            return "warn";
    }
}

/** The title without an earlier unread prefix. */
export function baseTitle(title: string): string {
    return title.replace(/^\(\d+\) /, "");
}

export function tabTitle(base: string, unread: number): string {
    return unread > 0 ? `(${unread}) ${base}` : base;
}

/** Agent messages past `seenSeq`, across every thread. */
export function unreadAgentMessages(threads: readonly Thread[], seenSeq: number): number {
    let count = 0;
    for (const thread of threads) {
        for (const message of thread.messages) {
            if (message.by === "agent" && message.seq > seenSeq) count += 1;
        }
    }
    return count;
}

export function tabStatus(input: TabInput, base: string): { href: string; title: string } {
    return {
        href: faviconHref(dotFor(input)),
        title: tabTitle(base, input.unread),
    };
}
