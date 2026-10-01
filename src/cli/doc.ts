// What every command starts from: the doc's current source, its folded log, and where each thread
// sits now. Also finds the doc for id-only commands.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { resolveAnchor } from "../core/anchor.ts";
import { decodeSource, parseDoc } from "../core/blocks.ts";
import { clipQuote, threadContext, type ThreadContext } from "../core/context.ts";
import { readLog, sidecar } from "../core/log.ts";
import type { Ack, Event, ParsedDoc, Range, Thread, ThreadId } from "../core/model.ts";
import { foldLog, withoutDeleted, type DocState } from "../core/threads.ts";
import { isFile } from "../server/doc-location.ts";
import type { Env } from "../server/open-tab.ts";
import { recentDocs } from "./registry.ts";

export interface DocView {
    /** Absolute doc path, symlinks resolved. */
    path: string;
    /** Null when the doc is missing on disk; the log outlives it. */
    doc: ParsedDoc | null;
    state: DocState;
}

export function readSource(path: string): string | null {
    try {
        return decodeSource(readFileSync(path));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

/**
 * Reads the doc and folds `events`, deleted threads left out (`state.deleted` still names them).
 * Inside a transaction, pass `txn.events`.
 */
export function viewOf(docPath: string, events: readonly Event[]): DocView {
    const path = sidecar(docPath).doc;
    const source = readSource(path);
    return {
        path,
        doc: source === null ? null : parseDoc(source),
        state: withoutDeleted(foldLog(events)),
    };
}

export async function loadView(docPath: string): Promise<DocView> {
    return viewOf(docPath, (await readLog(docPath)).events);
}

export interface Located {
    /** Null when the quote is gone (detached) or the doc is missing. */
    range: Range | null;
    /** The thread has a quote and it no longer resolves; never true for a doc note. */
    detached: boolean;
    context: ThreadContext;
}

/** A doc note locates nowhere: `range` null, empty context, and it is never detached. */
export function locate(view: DocView, thread: Thread): Located {
    const range = view.doc && thread.anchor ? resolveAnchor(view.doc.source, thread.anchor) : null;
    if (view.doc && range) {
        return { range, detached: false, context: threadContext(view.doc, range) };
    }
    return {
        range: null,
        detached: thread.anchor !== undefined,
        context: {
            path: "",
            line: 0,
            quote: thread.anchor ? clipQuote(thread.anchor.exact) : "",
            before: "",
            after: "",
        },
    };
}

export function isThreadId(text: string): text is ThreadId {
    return /^c\d+$/.test(text);
}

/** `missing` is the doc as the user named it, when that names no file. */
export type DocTarget =
    { ok: true; path: string } | { ok: false; ack: Ack } | { ok: false; missing: string };

/** Checked before anything touches `.margin/`, so a mistyped path creates nothing. */
function existing(path: string, named: string): DocTarget {
    return isFile(path) ? { ok: true, path } : { ok: false, missing: named };
}

function mentions(events: readonly Event[], id: ThreadId): boolean {
    return events.some((event) => "id" in event && event.id === id);
}

function isUnder(path: string, dir: string): boolean {
    return path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Candidate docs named in one error; the registry holds far more than an error line should. */
const NAMED_MAX = 3;

function awaitsAnswer(events: readonly Event[], id: ThreadId): boolean {
    const state = withoutDeleted(foldLog(events)).threads.get(id)?.state;
    return state === "open" || state === "working" || state === "replied";
}

/**
 * The doc a command acts on: the explicit argument, then `MARGIN_DOC`, then the recent docs.
 * Without an id only those under cwd count. A read with an id takes the cwd doc holding it, else
 * any recent doc holding it, because a doc is often opened from another directory.
 *
 * Ids repeat across docs, so a write (`write`) with an id is narrower:
 * 1. a cwd doc where the thread is unresolved;
 * 2. no cwd doc holds the id: an outside doc where it is unresolved, so a mistyped id cannot
 *    land on an old doc;
 * 3. a cwd doc holds it resolved and an outside doc holds it unresolved: refused, naming both.
 *    Either guess can be wrong, and a wrong `resolve` silently closes the other doc's thread;
 * 4. a cwd doc holds it resolved and no outside doc holds it unresolved: the cwd doc, whose own
 *    answer is then right.
 *
 * Anything but one match is an error naming the candidates, newest first. The doc must be a file.
 */
export async function resolveDoc(input: {
    explicit?: string;
    id?: ThreadId;
    write?: boolean;
    cwd: string;
    env: Env;
}): Promise<DocTarget> {
    const { explicit, id, write = false, cwd, env } = input;
    if (explicit !== undefined) return existing(resolve(cwd, explicit), explicit);
    if (env.MARGIN_DOC) return existing(resolve(cwd, env.MARGIN_DOC), env.MARGIN_DOC);

    let root = resolve(cwd);
    try {
        root = realpathSync(root);
    } catch {
        // Keep the given path.
    }
    const name = (doc: string) => (isUnder(doc, root) ? relative(root, doc) : doc);
    const one = (doc: string) => existing(doc, name(doc));
    const fail = (error: "not-unique" | "not-found", docs: string[]): DocTarget => ({
        ok: false,
        ack: {
            ok: false,
            ...(id === undefined ? {} : { id }),
            error,
            detail:
                docs.length > 0
                    ? `pass the doc: ${docs.slice(0, NAMED_MAX).map(name).join(" ")}`
                    : "pass the doc",
        },
    });

    const recent = recentDocs(env).filter((doc) => existsSync(sidecar(doc).log));
    const local = recent.filter((doc) => isUnder(doc, root));
    if (id === undefined) {
        if (local.length === 1) return one(local[0]!);
        return fail(local.length > 1 ? "not-unique" : "not-found", local);
    }

    const localHolders: string[] = [];
    const localUsable: string[] = [];
    for (const doc of local) {
        const { events } = await readLog(doc);
        if (!mentions(events, id)) continue;
        localHolders.push(doc);
        if (!write || awaitsAnswer(events, id)) localUsable.push(doc);
    }
    if (localUsable.length === 1) return one(localUsable[0]!);
    if (localUsable.length > 1) return fail("not-unique", localUsable);

    const holders: string[] = [];
    const usable: string[] = [];
    for (const doc of recent) {
        if (isUnder(doc, root)) continue;
        const { events } = await readLog(doc);
        if (!mentions(events, id)) continue;
        holders.push(doc);
        if (!write || awaitsAnswer(events, id)) usable.push(doc);
    }
    if (localHolders.length > 0) {
        if (usable.length > 0) {
            // Leaves room for an outside doc, so the line always shows both sides of the clash.
            return fail("not-unique", [...localHolders.slice(0, NAMED_MAX - 1), ...usable]);
        }
        if (localHolders.length === 1) return one(localHolders[0]!);
        return fail("not-unique", localHolders);
    }
    if (usable.length === 1) return one(usable[0]!);
    if (usable.length > 1) return fail("not-unique", usable);
    return fail("not-found", holders.length > 0 ? holders : local.length > 0 ? local : recent);
}
