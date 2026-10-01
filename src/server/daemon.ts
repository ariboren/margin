import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Server } from "bun";
import { sidecar } from "../core/log.ts";
import { LockTimeoutError } from "../core/lock.ts";
import {
    isVerdictState,
    type Anchor,
    type DocSettingKey,
    type ThreadId,
    type VerdictState,
} from "../core/model.ts";
import { isFile, repoRelativePath, resolveLinkedFile } from "./doc-location.ts";
import { openFile, openableLink, revealFile, type FileOpener } from "./open-file.ts";
import { openTab, type Env, type Opener } from "./open-tab.ts";
import {
    ensureStateDir,
    removeDaemonInfo,
    stateDir,
    statePaths,
    writeDaemonInfo,
} from "./paths.ts";
import { faviconHref } from "../core/favicon.ts";
import { connectedAgents } from "./presence.ts";
import {
    BOOT_ELEMENT,
    ICON_ELEMENT,
    DEV_EVENT,
    DOC_META,
    MUTATIONS,
    PROTOCOL_VERSION,
    SHORT_ID_LENGTH,
    SNAPSHOT_EVENT,
    TOKEN_META,
    TOKEN_PARAM,
    routes,
    shortDocId,
    type DaemonStatus,
    type DocId,
    type ErrorBody,
    type MutationName,
    type OpenFileResponse,
    type OpenUrlResponse,
    type PageBoot,
    type RegisterResponse,
    type WireError,
} from "./protocol.ts";
import {
    SECURITY_HEADERS,
    hostAllowed,
    newToken,
    originAllowed,
    requestToken,
    resolveImage,
    tokenMatches,
} from "./security.ts";
import {
    DocSession,
    WireFailure,
    type HashMemory,
    type KnownHash,
    type Versioned,
} from "./session.ts";
import { watchDoc, type WatchHandle } from "./watch.ts";

/** The daemon exits after this long with no tab connected. */
export const IDLE_EXIT_MS = 30 * 60 * 1000;

const KEEPALIVE_MS = 15_000;
/** How often a doc with open tabs rechecks its watcher's presence file. */
const PRESENCE_MS = 1_000;
const ROOT = join(import.meta.dir, "..", "..");
const DEFAULT_CLIENT_DIR = join(ROOT, "dist", "client");

export interface ServerOptions {
    token?: string;
    /** 0 (default) picks a free port. */
    port?: number;
    /** Exit hook for idle; unset means never idle out. */
    idleMs?: number;
    onIdle?: () => void;
    /** Called for `POST /api/stop` after the response is sent. */
    onStop?: () => void;
    clientDir?: string;
    watch?: { pollMs?: number };
    /** Where each doc's last seen hash is kept between runs; unset keeps nothing. */
    stateDir?: string;
    /** Handed to the openers (they pick Orca from any `ORCA_*` name). Defaults to process.env. */
    env?: Env;
    /** Opens an http(s) link for `open-url`; defaults to `openTab`. */
    openUrl?: (url: string, env: Env) => Promise<Opener>;
    /** Opens a file for `open-file`; defaults to `openFile`. */
    openFile?: (path: string, env: Env) => Promise<FileOpener>;
    /** Shows the doc in the file manager for `open-file` with `reveal`; defaults to `revealFile`. */
    revealFile?: (path: string, env: Env) => Promise<FileOpener>;
    /** `bun run dev` only: every event stream also carries a stamp that `reload()` changes. */
    dev?: boolean;
}

export interface MarginServer {
    port: number;
    token: string;
    origin: string;
    register(path: string): Promise<RegisterResponse>;
    session(docId: DocId): DocSession | undefined;
    status(): DaemonStatus;
    /** Dev only: changes the stamp so every open tab reloads. A no-op without `dev`. */
    reload(): void;
    stop(): Promise<void>;
}

interface Registered {
    session: DocSession;
    watcher: WatchHandle;
    relativePath: string;
    /** Last presence reading pushed to this doc's tabs, as its JSON, so a poll compares bytes. */
    agents: string;
    /** One resend per open event stream, for a presence change the log never sees. */
    streams: Set<() => void>;
}

export async function startServer(options: ServerOptions = {}): Promise<MarginServer> {
    const token = options.token ?? newToken();
    const clientDir = options.clientDir ?? DEFAULT_CLIENT_DIR;
    const env = options.env ?? process.env;
    const openUrl = options.openUrl ?? openTab;
    const openPath = options.openFile ?? openFile;
    const revealPath = options.revealFile ?? revealFile;
    const startedAt = new Date().toISOString();
    const docs = new Map<DocId, Registered>();
    const opening = new Map<DocId, Promise<Registered>>();
    let lastActivity = Date.now();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const boot = randomUUID();
    let builds = 0;
    const devStamp = options.dev ? () => `${boot}.${builds}` : undefined;

    const clients = () => [...docs.values()].reduce((sum, doc) => sum + doc.session.clients, 0);

    const armIdle = () => {
        if (options.idleMs === undefined || !options.onIdle) {
            return;
        }
        clearTimeout(idleTimer);
        const wait = Math.max(0, lastActivity + options.idleMs - Date.now());
        idleTimer = setTimeout(() => {
            if (clients() > 0) {
                return;
            }
            if (Date.now() - lastActivity >= options.idleMs!) {
                options.onIdle!();
            } else {
                armIdle();
            }
        }, wait);
    };

    const register = async (path: string): Promise<RegisterResponse> => {
        const real = sidecar(path).doc;
        if (!isFile(real)) {
            throw new WireFailure(404, "missing", "doc not found");
        }
        const docId = createHash("sha256").update(real).digest("hex").slice(0, 12);
        if (!docs.has(docId)) {
            let open = opening.get(docId);
            if (!open) {
                open = (async () => {
                    const session = await DocSession.open(
                        docId,
                        real,
                        options.stateDir === undefined
                            ? undefined
                            : hashMemory(options.stateDir, docId),
                    );
                    const watcher = watchDoc(
                        real,
                        session.sidecar.log,
                        () => void session.sync().catch(logError),
                        options.watch,
                    );
                    // Catches a write that landed between the first read and arming the watcher.
                    void session.sync().catch(logError);
                    const entry: Registered = {
                        session,
                        watcher,
                        relativePath: repoRelativePath(real),
                        agents: JSON.stringify(connectedAgents(real)),
                        streams: new Set(),
                    };
                    docs.set(docId, entry);
                    return entry;
                })();
                opening.set(docId, open);
                open.finally(() => opening.delete(docId)).catch(() => undefined);
            }
            await open;
        }
        return {
            docId,
            url: `${origin}${pagePath(docId)}?${TOKEN_PARAM}=${token}`,
            clients: docs.get(docId)?.session.clients ?? 0,
        };
    };

    /** The short id, unless another open doc shares it; then the full id keeps the two apart. */
    const pageId = (docId: DocId): string => {
        const short = shortDocId(docId);
        const shared = [...docs.keys()].some((other) => other !== docId && other.startsWith(short));
        return shared ? docId : short;
    };

    const pagePath = (docId: DocId): string =>
        routes.page(pageId(docId), basename(docs.get(docId)!.session.path));

    /** By the id segment alone: a full id, or a short one that names exactly one open doc. */
    const resolvePageId = (id: string): DocId | undefined => {
        if (id.length !== SHORT_ID_LENGTH) {
            return docs.has(id) ? id : undefined;
        }
        const matches = [...docs.keys()].filter((docId) => docId.startsWith(id));
        return matches.length === 1 ? matches[0] : undefined;
    };

    const status = (): DaemonStatus => ({
        pid: process.pid,
        port,
        protocol: PROTOCOL_VERSION,
        startedAt,
        docs: [...docs.entries()].map(([docId, { session }]) => ({
            docId,
            path: session.path,
            clients: session.clients,
            missing: session.isMissing,
        })),
    });

    const serveClient = async (pathname: string): Promise<Response> => {
        const name = pathname.slice(1);
        if (!/^(app\.(js|css)|assets\/[\w.-]+)$/.test(name)) {
            return error(404, "not-found");
        }
        // The package ships dist/client; only a checkout that skipped the build lands here.
        if (!existsSync(join(clientDir, "app.js"))) {
            return error(503, "internal", "client not built; run bun run build");
        }
        const file = Bun.file(join(clientDir, name));
        if (!(await file.exists())) {
            return error(404, "not-found");
        }
        return new Response(file, {
            headers: { ...SECURITY_HEADERS, "cache-control": "no-cache" },
        });
    };

    const handle = async (request: Request, server: Server<undefined>): Promise<Response> => {
        const url = new URL(request.url);
        if (
            !hostAllowed(request.headers.get("host"), port) ||
            !originAllowed(request.headers.get("origin"), port, request.method)
        ) {
            return error(403, "forbidden");
        }
        const { pathname } = url;
        if (
            request.method === "GET" &&
            (pathname === "/app.js" || pathname === "/app.css" || pathname.startsWith("/assets/"))
        ) {
            // The prebuilt client is the same public code the package ships; it carries no doc data.
            return await serveClient(pathname);
        }
        if (!tokenMatches(requestToken(request, url, TOKEN_PARAM), token)) {
            return error(403, "forbidden");
        }
        lastActivity = Date.now();
        armIdle();

        if (pathname === routes.register && request.method === "POST") {
            const body = await readJson(request);
            if (typeof body?.path !== "string") {
                return error(400, "bad-request");
            }
            return json(await register(body.path));
        }
        if (pathname === routes.status && request.method === "GET") {
            return json(status());
        }
        if (pathname === routes.stop && request.method === "POST") {
            setTimeout(() => options.onStop?.(), 0);
            return json({ ok: true });
        }

        const image = /^\/d\/([0-9a-f]{12})\/asset\/(.+)$/.exec(pathname);
        if (image && request.method === "GET") {
            const doc = docs.get(image[1]!);
            return doc ? asset(doc.session, image[2]!) : error(404, "not-found");
        }

        const page = /^\/d\/([0-9a-f]{8}|[0-9a-f]{12})(?:\/([^/]*))?$/.exec(pathname);
        if (page && request.method === "GET") {
            const docId = resolvePageId(page[1]!);
            if (docId === undefined) {
                return error(404, "not-found");
            }
            const doc = docs.get(docId)!;
            if (
                page[1] !== pageId(docId) ||
                decodeSegment(page[2]) !== basename(doc.session.path)
            ) {
                // Path-only, so it stays on this origin; the query, token included, goes along.
                return new Response(null, {
                    status: 302,
                    headers: { ...SECURITY_HEADERS, location: `${pagePath(docId)}${url.search}` },
                });
            }
            return shell(doc, token);
        }

        const api = /^\/api\/docs\/([0-9a-f]{12})\/([a-z-]+)$/.exec(pathname);
        const doc = api ? docs.get(api[1]!) : undefined;
        if (!api || !doc) {
            return error(404, "not-found");
        }
        const action = api[2]!;
        if (action === "snapshot" && request.method === "GET") {
            return new Response(wireJson(doc, doc.session.snapshotJson()), {
                headers: {
                    ...SECURITY_HEADERS,
                    "content-type": "application/json",
                    "cache-control": "no-store",
                },
            });
        }
        if (action === "events" && request.method === "GET") {
            server.timeout(request, 0);
            return events(
                doc,
                request,
                () => {
                    lastActivity = Date.now();
                    armIdle();
                },
                devStamp,
            );
        }
        if (action === "open-file" && request.method === "POST") {
            const body = await readJson(request);
            if (
                !body ||
                (body.link !== undefined && typeof body.link !== "string") ||
                (body.reveal !== undefined && typeof body.reveal !== "boolean") ||
                (body.reveal === true && body.link !== undefined)
            ) {
                return error(400, "bad-request");
            }
            let path: string;
            if (body.link === undefined) {
                if (doc.session.isMissing) {
                    return error(404, "not-found");
                }
                path = doc.session.path;
            } else {
                const linked = resolveLinkedFile(doc.session.path, body.link);
                if (!linked.ok && linked.reason === "missing") {
                    return error(404, "not-found");
                }
                if (!linked.ok || !openableLink(linked.path)) {
                    return error(403, "not-openable");
                }
                path = linked.path;
            }
            const opened: OpenFileResponse = {
                opened: await (body.reveal === true ? revealPath : openPath)(path, env),
            };
            return json(opened);
        }
        if (action === "open-url" && request.method === "POST") {
            const body = await readJson(request);
            if (typeof body?.url !== "string" || !isWebUrl(body.url)) {
                return error(400, "bad-request");
            }
            const opened: OpenUrlResponse = { opened: await openUrl(body.url, env) };
            return json(opened);
        }
        if (request.method === "POST" && (MUTATIONS as readonly string[]).includes(action)) {
            const body = await readJson(request);
            if (!body) {
                return error(400, "bad-request");
            }
            return json(await mutate(doc.session, action as MutationName, body));
        }
        return error(404, "not-found");
    };

    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: options.port ?? 0,
        fetch: async (request, server) => {
            try {
                return await handle(request, server);
            } catch (caught) {
                if (caught instanceof WireFailure) {
                    return error(caught.status, caught.error, caught.message);
                }
                if (caught instanceof LockTimeoutError) {
                    return error(503, "locked");
                }
                logError(caught);
                return error(500, "internal");
            }
        },
    });
    const port = server.port!;
    const origin = `http://127.0.0.1:${port}`;
    armIdle();
    const presence = setInterval(() => {
        for (const doc of docs.values()) {
            if (
                doc.streams.size > 0 &&
                JSON.stringify(connectedAgents(doc.session.path)) !== doc.agents
            ) {
                for (const resend of doc.streams) {
                    resend();
                }
            }
        }
    }, PRESENCE_MS);

    return {
        port,
        token,
        origin,
        register,
        session: (docId) => docs.get(docId)?.session,
        status,
        reload() {
            if (!devStamp) {
                return;
            }
            builds += 1;
            for (const doc of docs.values()) {
                for (const resend of doc.streams) {
                    resend();
                }
            }
        },
        async stop() {
            clearTimeout(idleTimer);
            clearInterval(presence);
            for (const { watcher } of docs.values()) {
                watcher.close();
            }
            await server.stop(true);
        },
    };
}

type Body = Record<string, unknown>;

async function mutate(
    session: DocSession,
    action: MutationName,
    body: Body,
): Promise<Versioned<object>> {
    const id = () => threadId(body.id);
    switch (action) {
        case "comment":
            return await session.comment({
                ...(body.anchor === undefined ? {} : { anchor: anchor(body.anchor) }),
                text: text(body.text),
            });
        case "suggest":
            return await session.suggest({
                anchor: anchor(body.anchor),
                replace: text(body.replace),
                ...(body.text === undefined ? {} : { text: text(body.text) }),
            });
        case "reply":
            return await session.reply(id(), text(body.text));
        case "accept":
            return await session.accept(id());
        case "reject":
            return await session.reject(
                id(),
                body.note === undefined ? undefined : text(body.note),
            );
        case "resolve":
            return await session.resolve(id());
        case "reopen":
            return await session.reopen(id());
        case "delete":
            return await session.deleteThread(id());
        case "undelete":
            return await session.undeleteThread(id());
        case "retract":
            return await session.retract(id(), integer(body.seq));
        case "revert":
            return await session.revert(id());
        case "save":
            return await session.save({
                start: integer(body.start),
                before: text(body.before),
                after: text(body.after),
                ...(body.version === undefined ? {} : { version: integer(body.version) }),
                ...(body.strict === undefined ? {} : { strict: flag(body.strict) }),
                ...(body.undoes === undefined ? {} : { undoes: integer(body.undoes) }),
            });
        case "follow-through":
            return await session.followThrough(integer(body.editSeq), text(body.text));
        case "hold":
            return await session.setHold(flag(body.on));
        case "send-all":
            return await session.sendAll();
        case "setting":
            return await session.setSetting(settingKey(body.key), flag(body.value));
        case "verdict":
            return await session.setVerdict({
                state: verdictState(body.state),
                ...(body.note === undefined ? {} : { note: text(body.note) }),
                ...(body.asIs === undefined ? {} : { asIs: flag(body.asIs) }),
            });
        case "finish":
            return await session.requestFinish();
    }
}

function badRequest(what: string): WireFailure {
    return new WireFailure(400, "bad-request", what);
}

function text(value: unknown): string {
    if (typeof value !== "string") {
        throw badRequest("expected a string");
    }
    return value;
}

function integer(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw badRequest("expected a non-negative integer");
    }
    return value;
}

function flag(value: unknown): boolean {
    if (typeof value !== "boolean") {
        throw badRequest("expected a boolean");
    }
    return value;
}

function threadId(value: unknown): ThreadId {
    if (typeof value !== "string" || !/^c\d+$/.test(value)) {
        throw badRequest("expected a thread id");
    }
    return value as ThreadId;
}

function settingKey(value: unknown): DocSettingKey {
    if (value !== "autoApply") {
        throw badRequest("unknown setting");
    }
    return value;
}

function verdictState(value: unknown): VerdictState {
    if (!isVerdictState(value)) {
        throw badRequest("unknown verdict state");
    }
    return value;
}

function anchor(value: unknown): Anchor {
    const candidate = value as Partial<Anchor> | null;
    if (
        typeof candidate !== "object" ||
        candidate === null ||
        typeof candidate.exact !== "string" ||
        candidate.exact === "" ||
        typeof candidate.prefix !== "string" ||
        typeof candidate.suffix !== "string" ||
        typeof candidate.hint !== "number"
    ) {
        throw badRequest("expected an anchor");
    }
    return {
        exact: candidate.exact,
        prefix: candidate.prefix,
        suffix: candidate.suffix,
        hint: candidate.hint,
    };
}

async function readJson(request: Request): Promise<Body | null> {
    try {
        const body: unknown = await request.json();
        return typeof body === "object" && body !== null && !Array.isArray(body)
            ? (body as Body)
            : null;
    } catch {
        return null;
    }
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...SECURITY_HEADERS,
            "content-type": "application/json",
            "cache-control": "no-store",
        },
    });
}

function error(status: number, code: WireError, detail?: string): Response {
    const body: ErrorBody = detail === undefined ? { error: code } : { error: code, detail };
    return json(body, status);
}

/** The session's snapshot JSON plus the presence reading, taken fresh and remembered. */
function wireJson(doc: Registered, snapshot: string): string {
    doc.agents = JSON.stringify(connectedAgents(doc.session.path));
    return `${snapshot.slice(0, -1)},"agents":${doc.agents}}`;
}

function events(
    doc: Registered,
    request: Request,
    onClientsChanged: () => void,
    devStamp?: () => string,
): Response {
    const { session } = doc;
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const write = (chunk: string) => {
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    cleanup();
                }
            };
            const send = (snapshot: string, version: number) =>
                write(
                    `event: ${SNAPSHOT_EVENT}\nid: ${version}\ndata: ${wireJson(doc, snapshot)}\n\n`,
                );
            const resend = () => {
                if (devStamp) {
                    write(`event: ${DEV_EVENT}\ndata: ${devStamp()}\n\n`);
                }
                send(session.snapshotJson(), session.version);
            };
            write("retry: 1000\n\n");
            resend();
            const unsubscribe = session.subscribe(send);
            doc.streams.add(resend);
            const keepalive = setInterval(() => write(": ping\n\n"), KEEPALIVE_MS);
            let done = false;
            cleanup = () => {
                if (done) {
                    return;
                }
                done = true;
                unsubscribe();
                doc.streams.delete(resend);
                clearInterval(keepalive);
                onClientsChanged();
            };
            request.signal.addEventListener("abort", () => cleanup());
        },
        cancel() {
            cleanup();
        },
    });
    return new Response(stream, {
        headers: {
            ...SECURITY_HEADERS,
            "content-type": "text/event-stream",
            "cache-control": "no-store",
        },
    });
}

function shell(doc: Registered, token: string): Response {
    const { session } = doc;
    const title = escapeHtml(`${basename(session.path)} · margin`);
    const boot: PageBoot = {
        docId: session.docId,
        path: session.path,
        relativePath: doc.relativePath,
    };
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="${TOKEN_META}" content="${escapeHtml(token)}">
<meta name="${DOC_META}" content="${session.docId}">
<title>${title}</title>
<link rel="icon" id="${ICON_ELEMENT}" href="${faviconHref(null)}">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="app"></div>
<script type="application/json" id="${BOOT_ELEMENT}">${scriptJson(boot)}</script>
<script type="module" src="/app.js"></script>
</body>
</html>
`;
    return new Response(html, {
        headers: {
            ...SECURITY_HEADERS,
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

function decodeSegment(segment: string | undefined): string | undefined {
    try {
        return segment === undefined ? undefined : decodeURIComponent(segment);
    } catch {
        return undefined;
    }
}

function asset(session: DocSession, encoded: string): Response {
    let relative: string;
    try {
        relative = encoded.split("/").map(decodeURIComponent).join("/");
    } catch {
        return error(400, "bad-request");
    }
    const image = resolveImage(dirname(session.path), relative);
    if (!image) {
        return error(404, "not-found");
    }
    return new Response(Bun.file(image.path), {
        headers: {
            ...SECURITY_HEADERS,
            // An SVG opened on its own must not run script in this origin.
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "content-type": image.type,
            "cache-control": "no-cache",
        },
    });
}

function hashMemory(dir: string, docId: DocId): HashMemory {
    const path = join(dir, "docs", `${docId}.json`);
    return {
        read() {
            try {
                const known = JSON.parse(readFileSync(path, "utf8")) as Partial<KnownHash>;
                return typeof known.seq === "number" && typeof known.hash === "string"
                    ? { seq: known.seq, hash: known.hash }
                    : null;
            } catch {
                return null;
            }
        },
        write(known) {
            try {
                mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
                writeFileSync(path, JSON.stringify(known), { mode: 0o600 });
            } catch (caught) {
                logError(caught);
            }
        },
    };
}

/** JSON safe inside a `<script>` element: no `</script>` or `<!--` can close or open anything. */
function scriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

function isWebUrl(value: string): boolean {
    try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function logError(caught: unknown): void {
    const message = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
    console.error(`[margin ${new Date().toISOString()}] ${message}`);
}

/** The detached daemon: serve, publish `daemon.json`, exit on stop, signal or idle. */
async function runDaemon(): Promise<void> {
    const paths = statePaths(ensureStateDir(stateDir()));
    const idleMs = Number(process.env.MARGIN_IDLE_MS) || IDLE_EXIT_MS;
    const dev = process.env.MARGIN_DEV === "1";
    let server: MarginServer | undefined;
    let stopping = false;
    const shutdown = async () => {
        if (stopping) {
            return;
        }
        stopping = true;
        removeDaemonInfo(paths.info, process.pid);
        await server?.stop();
        process.exit(0);
    };
    server = await startServer({
        stateDir: paths.dir,
        onStop: () => void shutdown(),
        // Under `bun run dev` the supervisor owns the lifetime, and a pinned port and token let
        // open tabs reconnect across restarts.
        ...(dev
            ? {
                  dev,
                  port: Number(process.env.MARGIN_DEV_PORT) || 0,
                  token: process.env.MARGIN_DEV_TOKEN || undefined,
                  clientDir: process.env.MARGIN_DEV_CLIENT_DIR || undefined,
              }
            : { idleMs, onIdle: () => void shutdown() }),
    });
    writeDaemonInfo(paths.info, {
        pid: process.pid,
        port: server.port,
        token: server.token,
        protocol: PROTOCOL_VERSION,
        startedAt: new Date().toISOString(),
    });
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
    process.on("SIGHUP", () => undefined);
    if (dev) {
        process.on("SIGUSR2", () => server?.reload());
    }
}

if (import.meta.main) {
    await runDaemon();
}
