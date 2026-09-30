import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export function newToken(): string {
    return randomBytes(32).toString("base64url");
}

/** Constant-time: both sides are hashed first, so length leaks nothing either. */
export function tokenMatches(given: string | null | undefined, token: string): boolean {
    if (!given) {
        return false;
    }
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(token).digest();
    return timingSafeEqual(a, b);
}

/** Loopback names only: a DNS-rebound name resolving to 127.0.0.1 still fails this. */
export function allowedHosts(port: number): string[] {
    return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function hostAllowed(host: string | null, port: number): boolean {
    return host !== null && allowedHosts(port).includes(host.toLowerCase());
}

/** A present Origin must be this daemon; a request that changes state must carry one. */
export function originAllowed(origin: string | null, port: number, method: string): boolean {
    if (origin === null) {
        return method === "GET" || method === "HEAD";
    }
    return allowedHosts(port).some((host) => origin.toLowerCase() === `http://${host}`);
}

export function requestToken(request: Request, url: URL, param: string): string | null {
    const header = request.headers.get("authorization");
    if (header?.startsWith("Bearer ")) {
        return header.slice("Bearer ".length);
    }
    return url.searchParams.get(param);
}

export const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
};

export const IMAGE_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
};

/**
 * Resolves an image path requested relative to the doc's directory. The real path (symlinks
 * followed) must stay inside that directory, be a regular file and carry an image extension;
 * anything else is null.
 */
export function resolveImage(
    docDir: string,
    requested: string,
): { path: string; type: string } | null {
    if (requested.includes("\0") || isAbsolute(requested)) {
        return null;
    }
    let root: string;
    let real: string;
    try {
        root = realpathSync(docDir);
        real = realpathSync(resolve(root, requested));
    } catch {
        return null;
    }
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
        return null;
    }
    const type = IMAGE_TYPES[extname(real).toLowerCase()];
    if (!type) {
        return null;
    }
    try {
        if (!statSync(real).isFile()) {
            return null;
        }
    } catch {
        return null;
    }
    return { path: real, type };
}
