import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

/** The nearest ancestor of the doc holding `.git` (a directory, or a file in a worktree). */
export function repoRoot(docPath: string): string | null {
    let dir = dirname(docPath);
    while (true) {
        if (existsSync(join(dir, ".git"))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

/**
 * The doc's path relative to its git repository root; outside a repository, just the file name.
 * Stable whichever directory `margin` was run from, like an editor's "copy relative path".
 */
export function repoRelativePath(docPath: string): string {
    const root = repoRoot(docPath);
    return root ? relative(root, docPath).split(sep).join("/") : basename(docPath);
}

function inside(path: string, dir: string): boolean {
    const rel = relative(dir, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export type LinkedFile =
    | { ok: true; path: string }
    /** `missing`: nothing there, or not a relative path. `refused`: exists, but not allowed. */
    | { ok: false; reason: "missing" | "refused" };

/**
 * Resolves a relative link in the doc (`other.md`, `../notes/a.md#part`) to a file on disk.
 * Only files inside the doc's repository (or its directory, outside a repository) qualify; the
 * realpath is taken before that check, so no symlink can lead out.
 */
export function resolveLinkedFile(docPath: string, link: string): LinkedFile {
    const bare = link.replace(/[?#].*$/, "");
    if (bare === "" || isAbsolute(bare) || /^[a-z][a-z0-9+.-]*:/i.test(bare)) {
        return { ok: false, reason: "missing" };
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(bare);
    } catch {
        return { ok: false, reason: "missing" };
    }
    const scope = realpathSync(repoRoot(docPath) ?? dirname(docPath));
    let target: string;
    try {
        target = realpathSync(resolve(dirname(docPath), decoded));
    } catch {
        return { ok: false, reason: "missing" };
    }
    return inside(target, scope) && statSync(target).isFile()
        ? { ok: true, path: target }
        : { ok: false, reason: "refused" };
}
