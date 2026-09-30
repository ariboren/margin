// The browser tab's side of the wire, for driving a live daemon without a browser.
import { createAnchor } from "../../src/core/anchor.ts";
import type { Range, SaveResult, ThreadId } from "../../src/core/model.ts";
import {
    routes,
    TOKEN_PARAM,
    type MutationName,
    type MutationResponse,
    type Mutations,
    type WireSnapshot,
} from "../../src/server/protocol.ts";

export class Tab {
    private readonly origin: string;
    private readonly token: string;

    /** `url` is the tab URL `openDoc` returns, token included. */
    constructor(
        url: string,
        private readonly docId: string,
    ) {
        const parsed = new URL(url);
        this.origin = parsed.origin;
        this.token = parsed.searchParams.get(TOKEN_PARAM) ?? "";
    }

    private headers(): Record<string, string> {
        return {
            authorization: `Bearer ${this.token}`,
            origin: this.origin,
            "content-type": "application/json",
        };
    }

    async post<N extends MutationName>(
        action: N,
        body: Mutations[N]["req"],
    ): Promise<MutationResponse<N>> {
        const response = await fetch(`${this.origin}${routes.mutate(this.docId, action)}`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(body),
        });
        if (response.status !== 200) throw new Error(`${action}: HTTP ${response.status}`);
        return (await response.json()) as MutationResponse<N>;
    }

    async snapshot(): Promise<WireSnapshot> {
        const response = await fetch(`${this.origin}${routes.snapshot(this.docId)}`, {
            headers: this.headers(),
        });
        return (await response.json()) as WireSnapshot;
    }

    /** A comment on the only occurrence of `exact`, anchored as the tab's selection would be. */
    async comment(exact: string, text: string): Promise<ThreadId> {
        const { source } = await this.snapshot();
        const start = source.indexOf(exact);
        if (start === -1 || source.indexOf(exact, start + 1) !== -1) {
            throw new Error("comment: the quote must occur exactly once");
        }
        return await this.commentAt(source, { start, end: start + exact.length }, text);
    }

    async commentAt(source: string, range: Range, text: string): Promise<ThreadId> {
        const anchor = createAnchor(source, range);
        return (await this.post("comment", { anchor, text })).id;
    }

    async accept(id: ThreadId): Promise<SaveResult> {
        const { version: _version, ...result } = await this.post("accept", { id });
        return result as SaveResult;
    }

    async thread(id: ThreadId) {
        return (await this.snapshot()).threads.find((thread) => thread.id === id);
    }
}
