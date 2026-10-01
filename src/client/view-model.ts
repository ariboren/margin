import type { Heading, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import { resolveAnchor } from "../core/anchor.ts";
import { docTree, flattenUnits, unitAt } from "../core/blocks.ts";
import { netEdits } from "../core/diff.ts";
import {
    isDocNote,
    type DocSnapshot,
    type EditEvent,
    type Offset,
    type Range,
    type Thread,
    type ThreadId,
    type ThreadState,
    type Unit,
} from "../core/model.ts";

type DecorationKind = "comment" | "draft" | "suggest" | "applied" | "pending" | "resolved";

/** A highlighted source range the renderer paints: a thread's quote or the selection being commented. */
export interface Decoration {
    id: ThreadId | "new";
    kind: DecorationKind;
    start: Offset;
    end: Offset;
    replace?: string;
}

export interface OutlineEntry {
    start: Offset;
    depth: number;
    text: string;
    /** GitHub's anchor for the heading, which `#slug` links in the doc point at. */
    slug: string;
    openThreads: number;
}

/**
 * GitHub-style heading anchors, in document order: lowercase, punctuation and symbols dropped,
 * spaces to hyphens; a repeat gets `-1`, `-2` and so on.
 */
export function headingSlugs(texts: string[]): string[] {
    const seen = new Map<string, number>();
    return texts.map((text) => {
        const base = text
            .toLowerCase()
            .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
            .replace(/ /g, "-");
        let slug = base;
        while (seen.has(slug)) {
            const count = seen.get(base)! + 1;
            seen.set(base, count);
            slug = `${base}-${count}`;
        }
        seen.set(slug, 0);
        return slug;
    });
}

export interface DocView {
    tree: Root;
    /** Added to mdast offsets to get source offsets. */
    shift: number;
    units: Unit[];
    ranges: Map<ThreadId, Range>;
    outline: OutlineEntry[];
    /** Open threads in document order, for `j`/`k`. */
    order: ThreadId[];
    decorations: Decoration[];
    /**
     * User edits the agent has not been asked to follow through on, with a card each; empty
     * unless resolved threads are shown, since a done edit is no more actionable than one.
     */
    userEdits: EditEvent[];
    /** What the "show resolved" setting governs: resolved threads plus the edit cards. */
    settled: number;
}

export function isStalled(thread: Thread, now: number): boolean {
    return thread.state === "working" && now - Date.parse(thread.lastActivity) > 10 * 60_000;
}

/**
 * An open thread the agent's `margin watch` has printed but nothing has claimed yet: a cursor
 * that named it came after its last activity. A cursor that moved past it unprinted names it not.
 */
function isAgentNotified(thread: Thread): boolean {
    return (
        thread.state === "open" &&
        thread.notifiedAt !== undefined &&
        Date.parse(thread.notifiedAt) > Date.parse(thread.lastActivity)
    );
}

/** A held draft deletes at once; a thread the agent may have seen asks first. */
export function needsDeleteConfirm(thread: Thread): boolean {
    return thread.state !== "draft";
}

export type ThreadStatus = ThreadState | "detached" | "stalled" | "notified";

/** The quote is gone and the thread is still open. A doc note has no quote, so it never is. */
export function isDetached(thread: Thread): boolean {
    return thread.detached && thread.state !== "resolved";
}

/** What a thread card's pill shows. */
export function threadStatus(thread: Thread, now: number): ThreadStatus {
    if (isDetached(thread)) {
        return "detached";
    }
    if (isStalled(thread, now)) {
        return "stalled";
    }
    if (isAgentNotified(thread)) {
        return "notified";
    }
    return thread.state;
}

export function unitKey(unit: Pick<Unit, "kind" | "start">): string {
    return `${unit.kind}@${unit.start}`;
}

/** Where a thread's card sits; a doc note has no place in the doc and never asks. */
export function threadPosition(view: DocView, thread: Thread): Offset {
    return view.ranges.get(thread.id)?.start ?? thread.anchor?.hint ?? 0;
}

/** Threads with a place in the doc: everything but doc notes. */
export function anchoredThreads(threads: readonly Thread[]): Thread[] {
    return threads.filter((thread) => !isDocNote(thread));
}

/** Doc notes, resolved ones only on request, oldest first (the panel reads like a chat). */
export function docNotes(threads: readonly Thread[], showResolved: boolean): Thread[] {
    return threads.filter(
        (thread) => isDocNote(thread) && (showResolved || thread.state !== "resolved"),
    );
}

/**
 * The highest agent message seq across `threads`, 0 with none: what the doc notes panel and the
 * tab title count unread replies against.
 */
export function latestAgentSeq(threads: readonly Thread[]): number {
    let latest = 0;
    for (const thread of threads) {
        for (const message of thread.messages) {
            if (message.by === "agent") latest = Math.max(latest, message.seq);
        }
    }
    return latest;
}

/** The agent is on a doc note: notified of it or responding to it. */
export function docNotesBusy(notes: readonly Thread[], now: number): boolean {
    return notes.some((note) => {
        const status = threadStatus(note, now);
        return status === "notified" || status === "working";
    });
}

/**
 * `showResolved` paints resolved threads faintly; otherwise their text carries no highlight. Doc
 * notes have no range, decoration, outline count or place in the `j`/`k` order.
 */
export function buildView(snapshot: DocSnapshot, showResolved = false): DocView {
    const { doc } = snapshot;
    const threads = anchoredThreads(snapshot.threads);
    const { tree, shift } = docTree(doc);
    const ranges = new Map<ThreadId, Range>();
    for (const thread of threads) {
        const range =
            thread.detached || !thread.anchor ? null : resolveAnchor(doc.source, thread.anchor);
        if (range) {
            ranges.set(thread.id, range);
        }
    }

    const decorations: Decoration[] = [];
    for (const thread of threads) {
        const range = ranges.get(thread.id);
        if (!range) {
            continue;
        }
        if (thread.state === "resolved") {
            if (showResolved) {
                decorations.push({ id: thread.id, kind: "resolved", ...range });
            }
        } else if (thread.suggestion?.status === "pending") {
            decorations.push({
                id: thread.id,
                kind: "suggest",
                ...range,
                replace: thread.suggestion.replace,
            });
        } else if (thread.applied && !thread.applied.reverted) {
            decorations.push({ id: thread.id, kind: "applied", ...range });
        } else {
            decorations.push({
                id: thread.id,
                kind: thread.state === "draft" ? "draft" : "comment",
                ...range,
            });
        }
    }

    const live = threads.filter((thread) => thread.state !== "resolved");
    const position = (thread: Thread): Offset =>
        ranges.get(thread.id)?.start ?? thread.anchor?.hint ?? 0;
    const headings = tree.children.filter((node): node is Heading => node.type === "heading");
    const slugs = headingSlugs(headings.map((heading) => toString(heading)));
    const outline = headings.map((heading, index) => {
        const start = heading.position!.start.offset! + shift;
        const next = headings[index + 1];
        const end = next ? next.position!.start.offset! + shift : Number.POSITIVE_INFINITY;
        const openThreads = live.filter((thread) => {
            const at = position(thread);
            return at >= start && at < end;
        }).length;
        return {
            start,
            depth: heading.depth,
            text: toString(heading),
            slug: slugs[index]!,
            openThreads,
        };
    });

    const order = [...live].sort((a, b) => position(a) - position(b)).map((thread) => thread.id);

    const followed = new Set(
        snapshot.threads.map((thread) => thread.followsEdit).filter((seq) => seq !== undefined),
    );
    const edits = netEdits(
        snapshot.edits.filter((edit) => edit.cause === "user" || edit.cause === "undo"),
    )
        .filter((edit) => !followed.has(edit.seq))
        .slice(-3);
    const resolved = snapshot.threads.filter((thread) => thread.state === "resolved").length;

    return {
        tree,
        shift,
        units: flattenUnits(doc.units),
        ranges,
        outline,
        order,
        decorations,
        userEdits: showResolved ? edits : [],
        settled: resolved + edits.length,
    };
}

export function editRange(source: string, edit: EditEvent): Range | null {
    if (source.slice(edit.start, edit.start + edit.after.length) === edit.after) {
        return { start: edit.start, end: edit.start + edit.after.length };
    }
    const at = source.indexOf(edit.after);
    return at >= 0 ? { start: at, end: at + edit.after.length } : null;
}

export function unitFor(snapshot: DocSnapshot, offset: Offset): Unit | undefined {
    return unitAt(snapshot.doc.units, { start: offset, end: offset });
}

/** Working threads with no activity for the stall window, in thread order. */
export function stalledThreads(threads: readonly Thread[], now: number): ThreadId[] {
    return threads.filter((thread) => isStalled(thread, now)).map((thread) => thread.id);
}
