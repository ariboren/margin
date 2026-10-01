import {
    isUnresolved,
    type Anchor,
    type Author,
    type DocSettingKey,
    type DocSettings,
    type DocSnapshot,
    type DocStore,
    type DocVerdict,
    type EditCause,
    type EditEvent,
    type FinishRequest,
    type FinishResult,
    type Offset,
    type ParsedDoc,
    type Range,
    type SaveResult,
    type SourceSplice,
    type Thread,
    type ThreadId,
    type ThreadState,
    type VerdictResult,
    type VerdictState,
    type WakeReason,
} from "../src/core/model.ts";
import { hashText, parseDoc, spliceEdit, unitAt } from "../src/core/blocks.ts";
import { createAnchor, rebaseAnchor, resolveAnchor } from "../src/core/anchor.ts";
import { editRange } from "../src/client/view-model.ts";

export interface Clock {
    now(): number;
    schedule(run: () => void, ms: number): void;
}

export const realClock: Clock = {
    now: () => Date.now(),
    schedule: (run, ms) => {
        setTimeout(run, ms);
    },
};

export interface Wake {
    id: ThreadId;
    reason: WakeReason;
}

/** The reasons about the doc as a whole, which name no thread. */
export type DocWake = Extract<WakeReason, "approved" | "declined" | "reopened">;

/** A thread placed at load time, in the source as it was before any seeded edit. */
export interface SeedThread {
    range: Range;
    state: ThreadState;
    createdBy: Author;
    messages: { by: Author; text: string }[];
    suggestion?: { by: Author; replace: string };
    /** An agent edit already applied without review. */
    applied?: string;
    /** Replaces `exact` so the quote no longer exists in the doc. */
    detachedExact?: string;
    agoMs: number;
}

export interface SeedEdit {
    range: Range;
    after: string;
    agoMs: number;
}

export class MemoryStore implements DocStore {
    private source: string;
    private doc: ParsedDoc;
    private readonly threads = new Map<ThreadId, Thread>();
    private readonly deleted = new Set<ThreadId>();
    private readonly edits: EditEvent[] = [];
    private readonly settings: DocSettings = {
        hold: false,
        autoApply: false,
    };
    private seq = 0;
    private nextId = 1;
    private agentSeenAt?: string;
    private changedOnDisk?: string;
    private verdict?: DocVerdict;
    private finish?: FinishRequest;
    private docWake?: DocWake;
    private readonly listeners = new Set<(snapshot: DocSnapshot) => void>();
    private cached: DocSnapshot;
    /** The scripted agent's inbox; the real daemon wakes `margin watch` instead. */
    onWake?: (batch: Wake[]) => void;
    /** A verdict, or the doc going back to open; the real daemon wakes `margin watch` with it. */
    onVerdict?: (reason: DocWake) => void;

    constructor(
        private readonly path: string,
        source: string,
        private readonly clock: Clock = realClock,
    ) {
        this.source = source;
        this.doc = parseDoc(source);
        this.cached = this.build();
    }

    snapshot(): DocSnapshot {
        return this.cached;
    }

    subscribe(listener: (snapshot: DocSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    async comment(input: { anchor?: Anchor; text: string }): Promise<ThreadId> {
        const thread = this.open(input.anchor, "user", input.text);
        this.reviveDoc();
        this.emit();
        this.wakeIfOpen([thread], "new");
        return thread.id;
    }

    async suggest(input: { anchor: Anchor; replace: string; text?: string }): Promise<ThreadId> {
        const thread = this.open(input.anchor, "user", input.text);
        thread.suggestion = {
            seq: this.tick(),
            by: "user",
            replace: input.replace,
            status: "pending",
        };
        this.reviveDoc();
        this.emit();
        this.wakeIfOpen([thread], "new");
        return thread.id;
    }

    async reply(id: ThreadId, text: string): Promise<void> {
        const thread = this.thread(id);
        this.message(thread, "user", text);
        if (thread.state !== "draft") {
            thread.state = "open";
        }
        this.reviveDoc();
        this.emit();
        this.wakeIfOpen([thread], "reply");
    }

    async accept(id: ThreadId): Promise<SaveResult> {
        const thread = this.thread(id);
        const suggestion = thread.suggestion;
        if (!suggestion || suggestion.status !== "pending") {
            return { ok: true };
        }
        const result = this.replaceAnchored(thread, suggestion.replace, "accept", "user");
        if (!result.ok) {
            return result;
        }
        suggestion.status = "accepted";
        this.setState(thread, "resolved");
        this.emit();
        return { ok: true };
    }

    async reject(id: ThreadId, note?: string): Promise<void> {
        const thread = this.thread(id);
        if (thread.suggestion?.status === "pending") {
            thread.suggestion.status = "rejected";
        }
        if (note) {
            this.message(thread, "user", note);
            this.setState(thread, "open");
            this.reviveDoc();
        } else {
            this.setState(thread, "resolved");
        }
        this.emit();
        if (note) {
            this.wakeIfOpen([thread], "rejected");
        }
    }

    async resolve(id: ThreadId): Promise<void> {
        this.setState(this.thread(id), "resolved");
        this.emit();
    }

    async reopen(id: ThreadId): Promise<void> {
        this.setState(this.thread(id), "open");
        this.reviveDoc();
        this.emit();
    }

    async deleteThread(id: ThreadId): Promise<void> {
        this.thread(id);
        this.deleted.add(id);
        this.tick();
        this.emit();
    }

    async undeleteThread(id: ThreadId): Promise<void> {
        const thread = this.thread(id);
        this.deleted.delete(id);
        this.tick();
        if (isUnresolved(thread)) {
            this.reviveDoc();
        }
        this.emit();
    }

    async revert(id: ThreadId): Promise<SaveResult> {
        const thread = this.thread(id);
        const applied = thread.applied;
        if (!applied || applied.reverted) {
            return { ok: true };
        }
        const result = this.replaceAnchored(thread, applied.before, "revert", "user");
        if (!result.ok) {
            return result;
        }
        applied.reverted = true;
        this.emit();
        return { ok: true };
    }

    async saveUnit(edit: { start: Offset; before: string; after: string }): Promise<SaveResult> {
        const result = spliceEdit(this.doc, edit);
        if (result.status === "unchanged") {
            return { ok: true };
        }
        if (result.status === "conflict") {
            const unit = unitAt(this.doc.units, { start: edit.start, end: edit.start });
            return {
                ok: false,
                reason: "conflict",
                current: unit ? this.source.slice(unit.start, unit.end) : "",
            };
        }
        this.recordEdit("user", "user", result.edit);
        this.setSource(result.source, result.edit);
        this.emit();
        return { ok: true };
    }

    async followThrough(editSeq: number, text: string): Promise<ThreadId> {
        const edit = this.edits.find((candidate) => candidate.seq === editSeq);
        const range = edit ? editRange(this.source, edit) : null;
        const anchor =
            range && range.end > range.start
                ? createAnchor(this.source, range)
                : { exact: edit?.after ?? "", prefix: "", suffix: "", hint: edit?.start ?? 0 };
        const thread = this.open(anchor, "user", text);
        thread.followsEdit = editSeq;
        this.reviveDoc();
        this.emit();
        this.wakeIfOpen([thread], "new");
        return thread.id;
    }

    async setHold(on: boolean): Promise<void> {
        this.settings.hold = on;
        this.tick();
        this.emit();
    }

    async sendAll(): Promise<void> {
        const drafts = this.live().filter((thread) => thread.state === "draft");
        for (const thread of drafts) {
            this.setState(thread, "open");
        }
        this.emit();
        this.wakeIfOpen(drafts, "new");
    }

    async setSetting(key: DocSettingKey, value: boolean): Promise<void> {
        this.settings[key] = value;
        this.tick();
        this.emit();
    }

    async setVerdict(input: {
        state: VerdictState;
        note?: string;
        asIs?: boolean;
    }): Promise<VerdictResult> {
        const { state, note } = input;
        if (state === "open" && (this.verdict?.state ?? "open") === "open") {
            return { ok: true };
        }
        const unresolved = state === "approved" ? this.unresolved() : [];
        const ids = unresolved.map((thread) => thread.id);
        if (unresolved.length > 0 && !input.asIs) {
            return { ok: false, reason: "unresolved", ids };
        }
        const at = this.isoNow();
        for (const thread of unresolved) {
            thread.state = "resolved";
            thread.lastActivity = at;
            if (thread.suggestion?.status === "pending") {
                thread.suggestion.status = "rejected";
            }
        }
        this.verdict = {
            state,
            seq: this.tick(),
            at,
            hash: hashText(this.source),
            ...(note ? { note } : {}),
            ...(ids.length > 0 ? { closed: ids } : {}),
        };
        this.finish = undefined;
        this.docWake = state === "open" ? "reopened" : state;
        this.emit();
        return { ok: true };
    }

    async requestFinish(): Promise<FinishResult> {
        const unapplied: ThreadId[] = [];
        for (const thread of this.unresolved()) {
            const suggestion = thread.suggestion;
            if (suggestion?.by !== "agent" || suggestion.status !== "pending") {
                continue;
            }
            if (this.replaceAnchored(thread, suggestion.replace, "accept", "user").ok) {
                suggestion.status = "accepted";
                this.setState(thread, "resolved");
            } else {
                unapplied.push(thread.id);
            }
        }
        const handed = this.unresolved();
        const ids = handed.map((thread) => thread.id);
        if (handed.length > 0) {
            for (const thread of handed) {
                this.setState(thread, "open");
            }
            this.finish = { seq: this.tick(), at: this.isoNow(), ids };
            this.reviveDoc();
        }
        this.emit();
        if (handed.length > 0) {
            this.onWake?.(ids.map((id) => ({ id, reason: "finish" })));
        }
        return { ids, unapplied };
    }

    dismissChangedOnDisk(): void {
        this.changedOnDisk = undefined;
        this.emit();
    }

    // The agent side, driven by the scripted agent. The real agent reaches these through the CLI.

    agentClaim(ids: ThreadId[]): void {
        for (const id of ids.filter((claimed) => !this.deleted.has(claimed))) {
            const thread = this.thread(id);
            thread.claimed = true;
            if (thread.state === "open") {
                this.setState(thread, "working");
            }
        }
        this.agentSeenAt = this.isoNow();
        this.emit();
    }

    /** Like the CLI, the agent's writes to a deleted thread are refused. */
    agentReply(id: ThreadId, text: string): void {
        if (this.deleted.has(id)) {
            return;
        }
        const thread = this.thread(id);
        this.message(thread, "agent", text);
        this.setState(thread, "replied");
        this.emit();
    }

    /** `margin suggest`, with `--apply` when `apply` is set. */
    agentSuggest(id: ThreadId, replace: string, options: { apply: boolean; note?: string }): void {
        if (this.deleted.has(id)) {
            return;
        }
        const thread = this.thread(id);
        if (options.apply || this.settings.autoApply) {
            this.applyAgentEdit(thread, replace);
        } else {
            thread.suggestion = { seq: this.tick(), by: "agent", replace, status: "pending" };
        }
        if (options.note) {
            this.message(thread, "agent", options.note);
        }
        this.setState(thread, "replied");
        this.emit();
    }

    /** `margin resolve`, or the `--resolve` of a reply: how the agent settles a finish request. */
    agentResolve(id: ThreadId): void {
        if (this.deleted.has(id)) {
            return;
        }
        this.setState(this.thread(id), "resolved");
        this.emit();
    }

    /** `margin suggest --find`: an agent-initiated thread. */
    agentFind(range: Range, replace: string, options: { apply: boolean; note: string }): ThreadId {
        const thread = this.open(createAnchor(this.source, range), "agent");
        thread.claimed = true;
        this.agentSuggest(thread.id, replace, options);
        return thread.id;
    }

    // Mockup-only controls for the demo menu.

    simulateOutsideChange(range: Range, after: string): void {
        const result = spliceEdit(this.doc, {
            start: range.start,
            before: this.source.slice(range.start, range.end),
            after,
        });
        if (result.status === "changed") {
            this.setSource(result.source, result.edit);
        }
        this.changedOnDisk = this.isoNow();
        this.emit();
    }

    /** Push every working thread's last activity back, so it reads as stalled. */
    ageWorking(ms: number): void {
        for (const thread of this.threads.values()) {
            if (thread.state === "working") {
                thread.lastActivity = new Date(Date.parse(thread.lastActivity) - ms).toISOString();
            }
        }
        this.tick();
        this.emit();
    }

    seed(threads: SeedThread[], edits: SeedEdit[]): void {
        const original = this.source;
        const placed = threads.map((spec) => {
            const at = new Date(this.clock.now() - spec.agoMs).toISOString();
            const anchor = createAnchor(original, spec.range);
            if (spec.detachedExact) {
                anchor.exact = spec.detachedExact;
            }
            const thread = this.open(anchor, spec.createdBy);
            for (const message of spec.messages) {
                this.message(thread, message.by, message.text);
            }
            if (spec.suggestion) {
                thread.suggestion = { seq: this.tick(), ...spec.suggestion, status: "pending" };
            }
            thread.state = spec.state;
            thread.claimed = spec.state !== "open" || spec.createdBy === "agent";
            thread.lastActivity = at;
            for (const message of thread.messages) {
                message.at = at;
            }
            return { thread, spec };
        });
        for (const edit of edits) {
            const before = original.slice(edit.range.start, edit.range.end);
            const start = this.source.indexOf(before);
            if (start >= 0) {
                void this.saveUnit({ start, before, after: edit.after });
                this.edits[this.edits.length - 1]!.at = new Date(
                    this.clock.now() - edit.agoMs,
                ).toISOString();
            }
        }
        for (const { thread, spec } of placed) {
            if (spec.applied !== undefined) {
                this.applyAgentEdit(thread, spec.applied);
            }
        }
        this.agentSeenAt = new Date(this.clock.now() - 20_000).toISOString();
        // The seeded watch printed every thread so far.
        for (const thread of this.threads.values()) {
            thread.notifiedAt = this.agentSeenAt;
        }
        this.emit();
    }

    /** Without an anchor, a doc note. */
    private open(anchor: Anchor | undefined, by: Author, text?: string): Thread {
        const id: ThreadId = `c${this.nextId++}`;
        const thread: Thread = {
            id,
            state: by === "user" && this.settings.hold ? "draft" : "open",
            ...(anchor ? { anchor } : {}),
            detached: false,
            createdBy: by,
            messages: [],
            claimed: false,
            lastActivity: this.isoNow(),
        };
        this.threads.set(id, thread);
        if (text) {
            this.message(thread, by, text);
        }
        return thread;
    }

    private live(): Thread[] {
        return [...this.threads.values()].filter((thread) => !this.deleted.has(thread.id));
    }

    private unresolved(): Thread[] {
        return this.live().filter(isUnresolved);
    }

    /** The user's own thread activity puts an approved or declined doc back to open. */
    private reviveDoc(): void {
        if (this.verdict && this.verdict.state !== "open") {
            this.verdict = { state: "open", seq: this.seq, at: this.isoNow() };
            this.docWake = "reopened";
        }
    }

    private thread(id: ThreadId): Thread {
        const thread = this.threads.get(id);
        if (!thread) {
            throw new Error(`no thread ${id}`);
        }
        return thread;
    }

    private message(thread: Thread, by: Author, text: string): void {
        const at = this.isoNow();
        thread.messages.push({ seq: this.tick(), at, by, text });
        thread.lastActivity = at;
    }

    private setState(thread: Thread, state: ThreadState): void {
        thread.state = state;
        thread.lastActivity = this.isoNow();
        this.tick();
    }

    private wakeIfOpen(threads: Thread[], reason: WakeReason): void {
        const batch = threads
            .filter((thread) => thread.state !== "draft")
            .map((thread) => ({ id: thread.id, reason }));
        if (batch.length > 0) {
            this.onWake?.(batch);
        }
    }

    /** The agent's edit over the thread's quote, recorded on the thread when it lands. */
    private applyAgentEdit(thread: Thread, replace: string): void {
        const before = this.anchoredText(thread);
        if (before === null || !this.replaceAnchored(thread, replace, "apply", "agent").ok) {
            return;
        }
        const range = thread.anchor && resolveAnchor(this.source, thread.anchor);
        if (range) {
            const seq = this.edits[this.edits.length - 1]!.seq;
            thread.applied = { seq, start: range.start, before, after: replace, reverted: false };
        }
    }

    private anchoredText(thread: Thread): string | null {
        const range = thread.anchor ? resolveAnchor(this.source, thread.anchor) : null;
        return range ? this.source.slice(range.start, range.end) : null;
    }

    /** Compare-and-swap on the thread's quote, then move the anchor onto the new text. */
    private replaceAnchored(
        thread: Thread,
        replace: string,
        cause: EditCause,
        by: Author,
    ): { ok: true } | { ok: false; reason: "conflict"; current: string } {
        const range = thread.anchor ? resolveAnchor(this.source, thread.anchor) : null;
        if (!range) {
            return { ok: false, reason: "conflict", current: "" };
        }
        const before = this.source.slice(range.start, range.end);
        const result = spliceEdit(this.doc, { start: range.start, before, after: replace });
        if (result.status === "unchanged") {
            return { ok: true };
        }
        if (result.status === "conflict") {
            return { ok: false, reason: "conflict", current: before };
        }
        this.recordEdit(cause, by, result.edit, thread.id);
        this.setSource(result.source, result.edit, thread);
        return { ok: true };
    }

    private recordEdit(cause: EditCause, by: Author, edit: SourceSplice, id?: ThreadId): void {
        const unit = unitAt(this.doc.units, { start: edit.start, end: edit.start });
        this.edits.push({
            type: "edit",
            seq: this.tick(),
            at: this.isoNow(),
            by,
            cause,
            ...edit,
            line: unit?.line ?? 1,
            headingPath: unit?.headingPath ?? [],
            id,
        });
    }

    /** Rebase every anchor across the splice; the thread that caused it moves onto the new text. */
    private setSource(source: string, edit: SourceSplice, moved?: Thread): void {
        this.source = source;
        this.doc = parseDoc(source);
        for (const thread of this.threads.values()) {
            if (!thread.anchor) {
                continue;
            }
            if (thread === moved && edit.after.length > 0) {
                thread.anchor = createAnchor(source, {
                    start: edit.start,
                    end: edit.start + edit.after.length,
                });
            } else {
                thread.anchor = rebaseAnchor(thread.anchor, edit) ?? thread.anchor;
            }
            const found = resolveAnchor(source, thread.anchor);
            if (found && thread.applied) {
                thread.applied.start = found.start;
            }
        }
    }

    private tick(): number {
        this.seq += 1;
        return this.seq;
    }

    private isoNow(): string {
        return new Date(this.clock.now()).toISOString();
    }

    private emit(): void {
        this.cached = this.build();
        for (const listener of this.listeners) {
            listener(this.cached);
        }
        const wake = this.docWake;
        this.docWake = undefined;
        if (wake) {
            this.onVerdict?.(wake);
        }
    }

    private build(): DocSnapshot {
        return {
            path: this.path,
            doc: this.doc,
            threads: this.live().map((thread) => ({
                ...thread,
                ...(thread.anchor ? { anchor: { ...thread.anchor } } : {}),
                detached: !!thread.anchor && resolveAnchor(this.source, thread.anchor) === null,
                messages: [...thread.messages],
                suggestion: thread.suggestion && { ...thread.suggestion },
                applied: thread.applied && { ...thread.applied },
            })),
            edits: [...this.edits],
            settings: { ...this.settings },
            agentSeenAt: this.agentSeenAt,
            changedOnDisk: this.changedOnDisk,
            missing: false,
            version: this.seq,
            ...(this.verdict ? { verdict: { ...this.verdict } } : {}),
            ...(this.finish ? { finish: { ...this.finish } } : {}),
        };
    }
}
