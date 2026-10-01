import { describe, expect, test } from "bun:test";
import { openingProblem, type OpeningCopy } from "./boot.tsx";
import { RequestError } from "./server-store.ts";

const OPEN: OpeningCopy = {
    refused: "The file is missing on disk.",
    failed: "The file could not be opened.",
};
const REVEAL: OpeningCopy = {
    refused: "The file is missing on disk.",
    failed: "The file could not be shown in the file manager.",
};

describe("openingProblem", () => {
    test("says nothing when the daemon opened or revealed the file", async () => {
        for (const opened of ["orca", "system", "browser"]) {
            expect(await openingProblem(Promise.resolve({ opened }), OPEN)).toBeUndefined();
        }
    });

    test("open file: a daemon that found no command to run is a problem, not silence", async () => {
        expect(await openingProblem(Promise.resolve({ opened: "none" }), OPEN)).toBe(OPEN.failed);
    });

    test("reveal file: a daemon that found no command to run is a problem, not silence", async () => {
        expect(await openingProblem(Promise.resolve({ opened: "none" }), REVEAL)).toBe(
            REVEAL.failed,
        );
    });

    test("a refusal reads as the refusal, anything else as a lost daemon", async () => {
        const refusals = [
            new RequestError(404, { error: "not-found" }),
            new RequestError(403, { error: "not-openable" }),
        ];
        for (const refusal of refusals) {
            expect(await openingProblem(Promise.reject(refusal), REVEAL)).toBe(REVEAL.refused);
        }
        for (const lost of [
            new RequestError(403, { error: "forbidden" }),
            new TypeError("fetch"),
        ]) {
            expect(await openingProblem(Promise.reject(lost), REVEAL)).toBe(
                "Could not reach the margin daemon.",
            );
        }
    });
});
