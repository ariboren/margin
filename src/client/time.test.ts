import { expect, test } from "bun:test";
import { relativeTime } from "./time.ts";

const now = Date.parse("2026-09-30T12:00:00Z");

test("under 45 seconds is just now", () => {
    expect(relativeTime("2026-09-30T12:00:00Z", now)).toBe("just now");
    expect(relativeTime("2026-09-30T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-09-30T12:00:30Z", now)).toBe("just now");
});

test("minutes are compact", () => {
    expect(relativeTime("2026-09-30T11:59:00Z", now)).toBe("1m ago");
    expect(relativeTime("2026-09-30T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-09-30T11:01:00Z", now)).toBe("59m ago");
});

test("hours are compact", () => {
    expect(relativeTime("2026-09-30T11:00:00Z", now)).toBe("1h ago");
    expect(relativeTime("2026-09-30T10:00:00Z", now)).toBe("2h ago");
    expect(relativeTime("2026-09-29T13:00:00Z", now)).toBe("23h ago");
});

test("days are compact", () => {
    expect(relativeTime("2026-09-29T12:00:00Z", now)).toBe("1d ago");
    expect(relativeTime("2026-09-27T12:00:00Z", now)).toBe("3d ago");
});
