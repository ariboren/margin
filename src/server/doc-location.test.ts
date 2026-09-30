import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRelativePath, resolveLinkedFile } from "./doc-location.ts";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "margin-location-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

test("relative to the nearest .git directory", () => {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "docs", "guides"), { recursive: true });
    expect(repoRelativePath(join(root, "repo", "docs", "guides", "a.md"))).toBe("docs/guides/a.md");
    expect(repoRelativePath(join(root, "repo", "a.md"))).toBe("a.md");
});

test("a .git file (worktree) counts as the root", () => {
    mkdirSync(join(root, "wt", "docs"), { recursive: true });
    writeFileSync(join(root, "wt", ".git"), "gitdir: elsewhere\n");
    expect(repoRelativePath(join(root, "wt", "docs", "a.md"))).toBe("docs/a.md");
});

test("outside a repository, the file name", () => {
    mkdirSync(join(root, "plain", "deep"), { recursive: true });
    expect(repoRelativePath(join(root, "plain", "deep", "a.md"))).toBe("a.md");
});

describe("resolveLinkedFile", () => {
    const setup = () => {
        const repo = join(root, "repo");
        mkdirSync(join(repo, ".git"), { recursive: true });
        mkdirSync(join(repo, "docs", "sub"), { recursive: true });
        writeFileSync(join(repo, "docs", "doc.md"), "# Doc\n");
        writeFileSync(join(repo, "docs", "sub", "a b.md"), "# A\n");
        writeFileSync(join(repo, "README.md"), "# Readme\n");
        writeFileSync(join(root, "secret.md"), "outside\n");
        symlinkSync(join(root, "secret.md"), join(repo, "docs", "link.md"));
        return realpathSync(join(repo, "docs", "doc.md"));
    };

    test("relative links resolve to files inside the repository", () => {
        const doc = setup();
        const repo = realpathSync(join(root, "repo"));
        expect(resolveLinkedFile(doc, "sub/a%20b.md#part")).toEqual({
            ok: true,
            path: join(repo, "docs", "sub", "a b.md"),
        });
        expect(resolveLinkedFile(doc, "../README.md")).toEqual({
            ok: true,
            path: join(repo, "README.md"),
        });
        expect(resolveLinkedFile(doc, "./doc.md?x=1")).toEqual({ ok: true, path: doc });
    });

    test("outside the repository (symlinks resolved first) or a directory is refused", () => {
        const doc = setup();
        for (const link of ["../../secret.md", "link.md", "sub"]) {
            expect(resolveLinkedFile(doc, link)).toEqual({ ok: false, reason: "refused" });
        }
    });

    test("nothing there, a scheme or an absolute path is missing", () => {
        const doc = setup();
        for (const link of [
            "missing.md",
            "/etc/hosts",
            "file:///etc/hosts",
            "https://example.com",
            "#heading",
            "%E0%A4%A.md",
        ]) {
            expect(resolveLinkedFile(doc, link)).toEqual({ ok: false, reason: "missing" });
        }
    });

    test("outside a repository the doc's directory is the limit", () => {
        mkdirSync(join(root, "plain", "deep"), { recursive: true });
        writeFileSync(join(root, "plain", "up.md"), "# Up\n");
        writeFileSync(join(root, "plain", "deep", "doc.md"), "# Doc\n");
        writeFileSync(join(root, "plain", "deep", "near.md"), "# Near\n");
        const doc = realpathSync(join(root, "plain", "deep", "doc.md"));
        expect(resolveLinkedFile(doc, "near.md")).toEqual({
            ok: true,
            path: join(dirname(doc), "near.md"),
        });
        expect(resolveLinkedFile(doc, "../up.md")).toEqual({ ok: false, reason: "refused" });
    });
});
