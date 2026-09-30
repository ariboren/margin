// What every command starts from: the doc's current source, its folded log, and where each thread
// sits now. Also finds the doc for id-only commands.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { resolveAnchor } from "../core/anchor.ts";
import { decodeSource, parseDoc } from "../core/blocks.ts";
import { clipQuote, threadContext, type ThreadContext } from "../core/context.ts";
import { readLog, sidecar } from "../core/log.ts";
import type { Ack, Event, ParsedDoc, Range, Thread, ThreadId } from "../core/model.ts";
import { foldLog, type DocState } from "../core/threads.ts";
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

/** Reads the doc and folds `events`. Inside a transaction, pass `txn.events`. */
export function viewOf(docPath: string, events: readonly Event[]): DocView {
    const path = sidecar(docPath).doc;
    const source = readSource(path);
    return { path, doc: source === null ? null : parseDoc(source), state: foldLog(events) };
}

export async function loadView(docPath: string): Promise<DocView> {
    return viewOf(docPath, (await readLog(docPath)).events);
}

export interface Located {
    /** Null when the quote is gone (detached) or the doc is missing. */
    range: Range | null;
    context: ThreadContext;
}

export function locate(view: DocView, thread: Thread): Located {
    const range = view.doc ? resolveAnchor(view.doc.source, thread.anchor) : null;
    if (view.doc && range) return { range, context: threadContext(view.doc, range) };
    return {
        range: null,
        context: {
            path: "",
            line: 0,
            quote: clipQuote(thread.anchor.exact),
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

/**
 * The doc a command acts on: the explicit argument, then `MARGIN_DOC`, then the recent docs
 * under cwd (those holding `id` when one is given). Anything but one match is an error naming
 * the candidates, so a reply never lands on the wrong doc's `c3`. The doc must be a file.
 */
export async function resolveDoc(input: {
    explicit?: string;
    id?: ThreadId;
    cwd: string;
    env: Env;
}): Promise<DocTarget> {
    const { explicit, id, cwd, env } = input;
    if (explicit !== undefined) return existing(resolve(cwd, explicit), explicit);
    if (env.MARGIN_DOC) return existing(resolve(cwd, env.MARGIN_DOC), env.MARGIN_DOC);

    let root = resolve(cwd);
    try {
        root = realpathSync(root);
    } catch {
        // Keep the given path.
    }
    const candidates = recentDocs(env).filter(
        (doc) => isUnder(doc, root) && existsSync(sidecar(doc).log),
    );
    const matches: string[] = [];
    for (const doc of candidates) {
        if (id === undefined || mentions((await readLog(doc)).events, id)) matches.push(doc);
    }
    if (matches.length === 1) return existing(matches[0]!, relative(root, matches[0]!));
    const named = (matches.length > 0 ? matches : candidates).map((doc) => relative(root, doc));
    return {
        ok: false,
        ack: {
            ok: false,
            ...(id === undefined ? {} : { id }),
            error: matches.length > 1 ? "not-unique" : "not-found",
            detail: named.length > 0 ? `pass the doc: ${named.join(" ")}` : "pass the doc",
        },
    };
}
