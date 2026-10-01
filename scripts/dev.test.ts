import { describe, expect, test } from "bun:test";
import { jobsFor } from "./dev.ts";

describe("jobsFor", () => {
    test("client changes rebuild, server changes restart, core changes do both", () => {
        expect(jobsFor(["client/app.tsx"])).toEqual({ build: true, restart: false });
        expect(jobsFor(["client/app.css"])).toEqual({ build: true, restart: false });
        expect(jobsFor(["server/daemon.ts"])).toEqual({ build: false, restart: true });
        expect(jobsFor(["core/threads.ts"])).toEqual({ build: true, restart: true });
        expect(jobsFor(["client/app.tsx", "server/api.ts"])).toEqual({
            build: true,
            restart: true,
        });
    });

    test("tests, test helpers and the CLI need nothing", () => {
        expect(
            jobsFor([
                "core/threads.test.ts",
                "client/app.test.tsx",
                "core/testing.ts",
                "cli/main.ts",
            ]),
        ).toEqual({ build: false, restart: false });
    });
});
