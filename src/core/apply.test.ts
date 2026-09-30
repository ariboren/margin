import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    chmodSync,
    copyFileSync,
    lstatSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit, locate } from "./apply.ts";
import { readLog } from "./log.ts";

const APPLY_MODULE = join(import.meta.dir, "apply.ts");
const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "margin-apply-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function writeDoc(text: string, name = "doc.md"): string {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
}

/** Only the doc and the sidecar dir: no temp file left behind. */
function dirEntries(): string[] {
    return readdirSync(dir).toSorted();
}

describe("locate", () => {
    test("prefers start, else the only occurrence, else refuses", () => {
        expect(locate("a b a", 4, "a")).toBe(4);
        expect(locate("x yz", 0, "yz")).toBe(2);
        expect(locate("a b a", 1, "a")).toBe("not-unique");
        expect(locate("abc", 0, "zz")).toBe("before-missing");
        expect(locate("abc", 3, "")).toBe(3);
        expect(locate("abc", 9, "")).toBe("before-missing");
    });
});

describe("applyEdit", () => {
    test("refuses when before is absent and leaves the file untouched", async () => {
        const doc = writeDoc("# Title\n\nFirst paragraph.\n");
        const bytes = readFileSync(doc);
        const result = await applyEdit(doc, {
            start: 9,
            before: "Missing paragraph.",
            after: "New.",
            cause: "user",
            by: "user",
        });
        expect(result).toMatchObject({ ok: false, reason: "before-missing" });
        expect(readFileSync(doc).equals(bytes)).toBe(true);
        expect((await readLog(doc)).events).toEqual([]);
        expect(dirEntries()).toEqual([".margin", "doc.md"]);
    });

    test("refuses when before moved and has several copies", async () => {
        const doc = writeDoc("same\n\nsame\n");
        const bytes = readFileSync(doc);
        const result = await applyEdit(doc, {
            start: 1,
            before: "same",
            after: "other",
            cause: "user",
            by: "user",
        });
        expect(result).toMatchObject({ ok: false, reason: "not-unique" });
        expect(readFileSync(doc).equals(bytes)).toBe(true);
        expect((await readLog(doc)).events).toEqual([]);
    });

    test("splices at start and logs the edit", async () => {
        const doc = writeDoc("# Title\n\n## Part\n\nOld words here.\n");
        const start = "# Title\n\n## Part\n\n".length;
        const result = await applyEdit(doc, {
            start,
            before: "Old words",
            after: "New words",
            cause: "apply",
            by: "agent",
            id: "c3",
        });
        expect(result.ok && result.status).toBe("changed");
        expect(readFileSync(doc, "utf8")).toBe("# Title\n\n## Part\n\nNew words here.\n");
        const { events } = await readLog(doc);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            type: "edit",
            seq: 1,
            by: "agent",
            cause: "apply",
            id: "c3",
            start,
            before: "Old words",
            after: "New words",
            line: 5,
            headingPath: ["Title", "Part"],
        });
        expect(dirEntries()).toEqual([".margin", "doc.md"]);
    });

    test("finds before at its unique new position after an earlier change", async () => {
        const doc = writeDoc("Inserted line.\n\nTarget sentence.\n");
        const result = await applyEdit(doc, {
            start: 0,
            before: "Target sentence.",
            after: "Changed sentence.",
            cause: "user",
            by: "user",
        });
        expect(result.ok && result.status === "changed" && result.event.start).toBe(16);
        expect(readFileSync(doc, "utf8")).toBe("Inserted line.\n\nChanged sentence.\n");
    });

    test("an unchanged edit writes nothing and logs nothing", async () => {
        const doc = writeDoc("Same text.\n");
        const before = statSync(doc);
        const result = await applyEdit(doc, {
            start: 0,
            before: "Same text.",
            after: "Same text.",
            cause: "user",
            by: "user",
        });
        expect(result).toMatchObject({ ok: true, status: "unchanged" });
        expect(statSync(doc).ino).toBe(before.ino);
        expect((await readLog(doc)).events).toEqual([]);
    });

    test("a missing doc is reported, not created", async () => {
        const doc = join(dir, "gone.md");
        const result = await applyEdit(doc, {
            start: 0,
            before: "",
            after: "x",
            cause: "user",
            by: "user",
        });
        expect(result).toEqual({ ok: false, reason: "missing" });
        expect(dirEntries()).not.toContain("gone.md");
    });

    test("keeps the file mode and writes through a symlink", async () => {
        const doc = writeDoc("Mode text.\n", "real.md");
        chmodSync(doc, 0o640);
        const link = join(dir, "link.md");
        symlinkSync(doc, link);
        await applyEdit(link, {
            start: 0,
            before: "Mode",
            after: "Kept",
            cause: "user",
            by: "user",
        });
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(doc, "utf8")).toBe("Kept text.\n");
        expect(statSync(doc).mode & 0o777).toBe(0o640);
    });

    for (const name of ["edge.md", "edge-bom.md", "edge-crlf.md", "edge-nonl.md"]) {
        test(`changes only the edited range in ${name}`, async () => {
            const doc = join(dir, name);
            copyFileSync(join(FIXTURES, name), doc);
            const original = readFileSync(doc);
            const source = new TextDecoder("utf-8", { ignoreBOM: true }).decode(original);
            const before = "soft break inside one paragraph.";
            const start = source.indexOf(before);
            const result = await applyEdit(doc, {
                start,
                before,
                after: "soft break,\nnow two lines.",
                cause: "user",
                by: "user",
            });
            expect(result.ok && result.status).toBe("changed");
            const eol = source.includes("\r\n") ? "\r\n" : "\n";
            const expected =
                source.slice(0, start) +
                `soft break,${eol}now two lines.` +
                source.slice(start + before.length);
            const written = readFileSync(doc);
            expect(written.equals(Buffer.from(new TextEncoder().encode(expected)))).toBe(true);
            const prefixBytes = Buffer.byteLength(source.slice(0, start));
            expect(written.subarray(0, prefixBytes).equals(original.subarray(0, prefixBytes))).toBe(
                true,
            );
            const suffixBytes = Buffer.byteLength(source.slice(start + before.length));
            expect(
                written
                    .subarray(written.length - suffixBytes)
                    .equals(original.subarray(original.length - suffixBytes)),
            ).toBe(true);
        });
    }

    test("escapes a pipe typed into a table cell", async () => {
        const doc = writeDoc("| A | B |\n| - | - |\n| one | two |\n");
        const start = "| A | B |\n| - | - |\n| ".length;
        const result = await applyEdit(doc, {
            start,
            before: "one",
            after: "x|y",
            cause: "user",
            by: "user",
        });
        expect(result.ok && result.status === "changed" && result.event.after).toBe("x\\|y");
        expect(readFileSync(doc, "utf8")).toBe("| A | B |\n| - | - |\n| x\\|y | two |\n");
    });

    test("20 processes editing different paragraphs all land", async () => {
        const workers = 20;
        const doc = writeDoc(
            Array.from({ length: workers }, (_, i) => `Paragraph ${i} old.`).join("\n\n") + "\n",
        );
        const script = join(dir, "worker.ts");
        writeFileSync(
            script,
            `import { applyEdit } from ${JSON.stringify(APPLY_MODULE)};
const i = Number(process.argv[2]);
const result = await applyEdit(${JSON.stringify(doc)}, {
    start: 0,
    before: \`Paragraph \${i} old.\`,
    after: \`Paragraph \${i} new.\`,
    cause: "user",
    by: "user",
}, { timeoutMs: 30_000 });
if (!result.ok) process.exit(1);
`,
        );
        const children = Array.from({ length: workers }, (_, i) =>
            Bun.spawn([process.execPath, script, String(i)], {
                stdout: "inherit",
                stderr: "inherit",
            }),
        );
        const codes = await Promise.all(children.map(async (child) => await child.exited));
        expect(codes.every((code) => code === 0)).toBe(true);
        expect(readFileSync(doc, "utf8")).toBe(
            Array.from({ length: workers }, (_, i) => `Paragraph ${i} new.`).join("\n\n") + "\n",
        );
        const { events } = await readLog(doc);
        expect(events.map((event) => event.seq)).toEqual(
            Array.from({ length: workers }, (_, i) => i + 1),
        );
        expect(dirEntries()).toEqual([".margin", "doc.md", "worker.ts"]);
    }, 60_000);
});
