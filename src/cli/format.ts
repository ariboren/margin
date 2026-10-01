// Plain-text renderings of the model.ts CLI shapes. Text is what the agent reads: it is smaller
// than the JSON on both samples, and every byte here is paid for on every wake.
import { formatEdit } from "../core/diff.ts";
import {
    isDocNote,
    type Ack,
    type PendingJson,
    type PendingThread,
    type ShowOutput,
    type WatchLine,
} from "../core/model.ts";

export function oneLine(text: string): string {
    return text.replace(/\r?\n/g, "\\n");
}

export type CompactLine = Extract<WatchLine, { form: "compact" }>;

/**
 * One line per batch: ids grouped by reason, with the heading path when the group shares one, or
 * `doc` when the group is doc notes.
 */
export function formatWatch(line: CompactLine): string {
    return line.groups
        .map((group) =>
            [
                group.reason,
                ...group.ids,
                ...(group.doc ? ["doc"] : group.path ? [JSON.stringify(group.path)] : []),
            ].join(" "),
        )
        .join(" | ");
}

interface Header {
    id: string;
    state: string;
    detached: boolean;
    line: number;
    path: string;
    doc: boolean;
}

/** `c3 open doc` for a doc note; otherwise the state, `detached` if so, the line and the path. */
function threadHeader(head: Header): string {
    if (head.doc) return `${head.id} ${head.state} doc`;
    const detached = head.detached ? " detached" : "";
    return `${head.id} ${head.state}${detached} L${head.line} ${head.path}`.trimEnd();
}

export function formatThread(thread: PendingThread, withMessages = true): string {
    const lines = [threadHeader({ ...thread, doc: thread.doc === true })];
    if (!thread.doc) {
        lines.push(
            `  ${oneLine(thread.before)}[[${oneLine(thread.quote)}]]${oneLine(thread.after)}`,
        );
    }
    if (thread.cell) {
        lines.push(`  header: ${oneLine(thread.cell.header)} | row: ${oneLine(thread.cell.row)}`);
    }
    if (thread.suggestion) {
        lines.push(
            `  suggestion ${thread.suggestion.status}: ${oneLine(thread.suggestion.replace)}`,
        );
    }
    if (withMessages) {
        for (const message of thread.messages) {
            lines.push(`  ${message.by}: ${oneLine(message.text)}`);
        }
    }
    return lines.join("\n");
}

export function formatPending(pending: PendingJson): string {
    const blocks = [
        ...pending.threads.map((thread) => formatThread(thread)),
        ...pending.edits.map(formatEdit),
    ];
    return blocks.length === 0 ? "none" : blocks.join("\n");
}

/** `show` prints the unit verbatim: it is what a `--replace` is written against. */
export function formatShow(show: ShowOutput): string {
    const { thread } = show;
    const lines = [threadHeader({ ...show, ...thread, doc: isDocNote(thread) })];
    if (thread.anchor) {
        lines.push(`quote: ${oneLine(thread.anchor.exact)}`, "unit:", show.unit);
    }
    if (thread.suggestion) {
        lines.push(`suggestion ${thread.suggestion.status}: ${oneLine(thread.suggestion.replace)}`);
    }
    for (const message of thread.messages) {
        lines.push(`${message.by}: ${oneLine(message.text)}`);
    }
    return lines.join("\n");
}

/** At most 24 B up to id c1000. */
export function formatAck(ack: Ack): string {
    if (!ack.ok) {
        const id = ack.id === undefined ? "" : ` ${ack.id}`;
        return `err${id} ${ack.error}${ack.detail ? `; ${ack.detail}` : ""}`;
    }
    return `ok ${ack.id} ${ack.state}`;
}
