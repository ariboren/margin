import { expect, test } from "bun:test";
import { refusalText } from "./use-apply.ts";

test("a refused accept or revert says why; success says nothing", () => {
    expect(refusalText("accept", { ok: true })).toBeNull();
    expect(refusalText("accept", { ok: false, reason: "conflict", current: "x" })).toContain(
        "not applied",
    );
    expect(refusalText("revert", { ok: false, reason: "conflict", current: "x" })).toContain(
        "not reverted",
    );
    expect(refusalText("revert", { ok: false, reason: "missing" })).toContain("missing");
});
