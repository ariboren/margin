import type { Author, Thread } from "../../core/model.ts";
import { parseMessage, type MessageBlock, type MessageInline } from "../render/message.tsx";

export interface ThreadSummary {
    /** Who wrote the last message; absent when the thread has none. */
    speaker?: ReturnType<typeof authorLabel>;
    /** The start of the last message as plain text, or what stands in for one. */
    preview: string;
}

export function authorLabel(by: Author): "Agent" | "You" {
    return by === "agent" ? "Agent" : "You";
}

export function suggestionLabel(by: Author): string {
    return by === "agent" ? "Agent suggests an edit" : "Your suggested edit";
}

/** The one line a collapsed card shows: the last message, flattened to its first block of text. */
export function summarize(thread: Thread): ThreadSummary {
    const last = thread.messages[thread.messages.length - 1];
    if (last) {
        const preview = previewText(last.text);
        if (preview) {
            return { speaker: authorLabel(last.by), preview };
        }
    }
    if (thread.suggestion) {
        return { preview: suggestionLabel(thread.suggestion.by) };
    }
    return { preview: squash(thread.anchor?.exact ?? "") };
}

/** Markdown reduced to the text of its first block; the CSS ellipsis does the clipping. */
export function previewText(markdown: string): string {
    const [first] = parseMessage(markdown);
    return first ? squash(blockText(first)) : "";
}

function blockText(block: MessageBlock): string {
    switch (block.type) {
        case "paragraph":
            return inlineText(block.children);
        case "list": {
            const [item] = block.items;
            return item?.[0] ? blockText(item[0]) : "";
        }
        case "code":
        case "raw":
            return block.value;
        case "quote": {
            const [child] = block.children;
            return child ? blockText(child) : "";
        }
    }
}

function inlineText(nodes: MessageInline[]): string {
    return nodes
        .map((node) => {
            switch (node.type) {
                case "text":
                case "code":
                    return node.value;
                case "break":
                    return " ";
                default:
                    return inlineText(node.children);
            }
        })
        .join("");
}

function squash(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}
