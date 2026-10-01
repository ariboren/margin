import { describe, expect, test } from "bun:test";
import { byteLength } from "../core/diff.ts";
import type { Ack, AckError, PendingReview } from "../core/model.ts";
import { applyEdit } from "../core/apply.ts";
import { formatAck, formatPending, formatWatch } from "./format.ts";
import { sandbox } from "./testing.ts";

const ACK_CEILING = 24;

describe("acks", () => {
    test("every success form fits the ceiling up to id c1000", () => {
        const acks: Ack[] = [
            { ok: true, id: "c1000", state: "replied" },
            { ok: true, id: "c1000", state: "resolved" },
        ];
        for (const ack of acks) expect(byteLength(formatAck(ack))).toBeLessThanOrEqual(ACK_CEILING);
    });

    test("every error without detail fits the ceiling up to id c1000", () => {
        const errors: AckError[] = [
            "not-found",
            "resolved",
            "detached",
            "before-missing",
            "not-unique",
            "bad-args",
            "locked",
            "deleted",
            "no-anchor",
        ];
        for (const error of errors) {
            expect(byteLength(formatAck({ ok: false, id: "c1000", error }))).toBeLessThanOrEqual(
                ACK_CEILING,
            );
        }
    });

    test("a success names the state", () => {
        expect(formatAck({ ok: true, id: "c3", state: "replied" })).toBe("ok c3 replied");
    });

    test("errors carry their detail after a semicolon", () => {
        expect(formatAck({ ok: false, id: "c3", error: "not-found", detail: "pass the doc" })).toBe(
            "err c3 not-found; pass the doc",
        );
    });
});

describe("watch line", () => {
    test("groups ids by reason, with the path when the group shares one", () => {
        expect(
            formatWatch({
                form: "compact",
                groups: [
                    { reason: "new", ids: ["c1", "c2"], path: 'A "quoted" > B' },
                    { reason: "reply", ids: ["c3"] },
                    { reason: "rejected", ids: ["c5"], path: "C" },
                ],
            }),
        ).toBe('new c1 c2 "A \\"quoted\\" > B" | reply c3 | rejected c5 "C"');
    });

    test("a doc-note group says doc in the path's place", () => {
        expect(
            formatWatch({
                form: "compact",
                groups: [
                    { reason: "new", ids: ["c9"], doc: true },
                    { reason: "reply", ids: ["c3"], path: "C" },
                ],
            }),
        ).toBe('new c9 doc | reply c3 "C"');
    });
});

test("a doc note in pending is its header and messages only", () => {
    expect(
        formatPending({
            threads: [
                {
                    id: "c2",
                    state: "open",
                    doc: true,
                    path: "",
                    line: 0,
                    detached: false,
                    quote: "",
                    before: "",
                    after: "",
                    messages: [{ by: "user", text: "Overall?" }],
                },
            ],
            edits: [],
        }),
    ).toBe("c2 open doc\n  user: Overall?");
});

test("empty pending says none", () => {
    expect(formatPending({ threads: [], edits: [] })).toBe("none");
});

describe("doc status", () => {
    test("a watch group for the doc is its word alone, and finish lists its threads", () => {
        expect(
            formatWatch({
                form: "compact",
                groups: [
                    { reason: "declined", ids: [] },
                    { reason: "new", ids: ["c7"], path: "A" },
                ],
            }),
        ).toBe('declined | new c7 "A"');
        for (const reason of ["approved", "declined", "reopened"] as const) {
            expect(formatWatch({ form: "compact", groups: [{ reason, ids: [] }] })).toBe(reason);
        }
        expect(
            formatWatch({ form: "compact", groups: [{ reason: "finish", ids: ["c3", "c5"] }] }),
        ).toBe("finish c3 c5");
    });

    test("the pending header is one line, alone when nothing waits", () => {
        const header = (review: PendingReview) => formatPending({ threads: [], edits: [], review });
        expect(header({ verdict: "approved" })).toBe("approved");
        expect(header({ verdict: "approved", note: "Ship it" })).toBe("approved: Ship it");
        expect(header({ verdict: "approved", changed: true })).toBe("approved changed");
        expect(header({ verdict: "approved", changed: true, note: "a\nb" })).toBe(
            "approved changed: a\\nb",
        );
        expect(header({ verdict: "declined" })).toBe("declined");
        expect(header({ verdict: "declined", note: "Later" })).toBe("declined: Later");
        expect(header({ finish: true })).toBe("finish");
        expect(header({ reopened: true })).toBe("reopened");
        expect(header({})).toBe("none");
    });
});

describe("a multi-line setext heading", () => {
    const doc = "# Title\n\nFindings\nand more\n--------\n\nThe cold path rarely runs.\n";

    test("keeps pending, show, the edit block and watch on one line each", async () => {
        const box = sandbox(doc);
        try {
            await box.comment("cold path", "Why?");
            const watched = await box.cli(["watch", "doc.md", "--once"]);
            expect(watched.stdout).toBe('new c1 "Findings and more"\n');

            const start = doc.indexOf("rarely");
            await applyEdit(box.doc, {
                start,
                before: "rarely",
                after: "never",
                cause: "user",
                by: "user",
            });
            const pending = (await box.cli(["pending", "doc.md"])).stdout;
            const heads = pending.split("\n").filter((line) => line && !line.startsWith("  "));
            expect(heads).toEqual(["c1 open L7 Findings and more", "edit L7 Findings and more"]);

            const show = (await box.cli(["show", "doc.md", "c1"])).stdout;
            expect(show.split("\n")[0]).toBe("c1 working L7 Findings and more");
        } finally {
            box.cleanup();
        }
    });
});
