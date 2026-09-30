import type { Heading, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import { resolveAnchor } from "../core/anchor.ts";
import { docTree, flattenUnits, unitAt } from "../core/blocks.ts";
import type {
    DocSnapshot,
    EditEvent,
    Offset,
    Range,
    Thread,
    ThreadId,
    Unit,
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
    /** User edits the agent has not been asked to follow through on. */
    userEdits: EditEvent[];
}

export function isStalled(thread: Thread, now: number): boolean {
    return thread.state === "working" && now - Date.parse(thread.lastActivity) > 10 * 60_000;
}

export function unitKey(unit: Pick<Unit, "kind" | "start">): string {
    return `${unit.kind}@${unit.start}`;
}

export function threadPosition(view: DocView, thread: Thread): Offset {
    return view.ranges.get(thread.id)?.start ?? thread.anchor.hint;
}

/** `showResolved` paints resolved threads faintly; otherwise their text carries no highlight. */
export function buildView(snapshot: DocSnapshot, showResolved = false): DocView {
    const { doc, threads } = snapshot;
    const { tree, shift } = docTree(doc);
    const ranges = new Map<ThreadId, Range>();
    for (const thread of threads) {
        const range = thread.detached ? null : resolveAnchor(doc.source, thread.anchor);
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
    const position = (thread: Thread): Offset => ranges.get(thread.id)?.start ?? thread.anchor.hint;
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
        threads.map((thread) => thread.followsEdit).filter((seq) => seq !== undefined),
    );
    const userEdits = snapshot.edits
        .filter((edit) => edit.cause === "user" && !followed.has(edit.seq))
        .slice(-3);

    return {
        tree,
        shift,
        units: flattenUnits(doc.units),
        ranges,
        outline,
        order,
        decorations,
        userEdits,
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
