import { describe, expect, test } from "bun:test";
import { faviconHref } from "../core/favicon.ts";
import type { Thread } from "../core/model.ts";
import { baseTitle, dotFor, tabStatus, tabTitle, unreadAgentMessages } from "./tab-status.ts";
import { latestAgentSeq } from "./view-model.ts";

function thread(id: Thread["id"], ...messages: [by: "user" | "agent", seq: number][]): Thread {
    return {
        id,
        state: "replied",
        detached: false,
        createdBy: "user",
        messages: messages.map(([by, seq]) => ({ seq, at: "", by, text: "…" })),
        claimed: false,
        lastActivity: "",
    };
}

describe("dotFor", () => {
    test("unread replies first, then the daemon link, then the agent", () => {
        expect(dotFor({ kind: "offline", unread: 2 })).toBe("accent");
        expect(dotFor({ kind: "offline", unread: 0 })).toBe("err");
        expect(dotFor({ kind: "connected", unread: 0 })).toBe("ok");
        for (const kind of ["stalled", "disconnected", "none"] as const) {
            expect(dotFor({ kind, unread: 0 })).toBe("warn");
        }
    });

    test("an agent on its way gets the neutral dot, and news still wins", () => {
        expect(dotFor({ kind: "connecting", unread: 0 })).toBeNull();
        expect(dotFor({ kind: "connecting", unread: 1 })).toBe("accent");
        expect(tabStatus({ kind: "connecting", unread: 0 }, "doc.md").href).toBe(faviconHref(null));
    });
});

describe("title", () => {
    test("prefixes the count and strips an earlier one", () => {
        expect(tabTitle("review.md · margin", 2)).toBe("(2) review.md · margin");
        expect(tabTitle("review.md · margin", 0)).toBe("review.md · margin");
        expect(baseTitle("(7) review.md · margin")).toBe("review.md · margin");
        expect(baseTitle("review.md · margin")).toBe("review.md · margin");
    });
});

describe("unread", () => {
    const threads = [
        thread("c1", ["user", 1], ["agent", 2]),
        thread("c2", ["agent", 4], ["user", 5]),
    ];

    test("counts agent messages past the seen seq across threads", () => {
        expect(latestAgentSeq(threads)).toBe(4);
        expect(unreadAgentMessages(threads, 0)).toBe(2);
        expect(unreadAgentMessages(threads, 2)).toBe(1);
        expect(unreadAgentMessages(threads, 4)).toBe(0);
        expect(latestAgentSeq([])).toBe(0);
    });

    test("tabStatus puts both together", () => {
        expect(tabStatus({ kind: "connected", unread: 3 }, "a.md · margin")).toEqual({
            href: faviconHref("accent"),
            title: "(3) a.md · margin",
        });
    });
});
