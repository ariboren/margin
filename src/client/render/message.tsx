import type { BlockContent, DefinitionContent, Nodes, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { JSX } from "preact";
import { useMemo } from "preact/hooks";
import { DocLink } from "./link.tsx";

/**
 * The markdown a thread message may use. Anything outside it (raw HTML, images, tables, link
 * references, footnotes) is kept as the source text it was written as.
 */
export type MessageInline =
    | { type: "text"; value: string }
    | { type: "break" }
    | { type: "code"; value: string }
    | { type: "strong" | "emphasis" | "delete"; children: MessageInline[] }
    | { type: "link"; url: string; title?: string; children: MessageInline[] };

export type MessageBlock =
    | { type: "paragraph"; children: MessageInline[] }
    | { type: "list"; ordered: boolean; start?: number; items: MessageBlock[][] }
    | { type: "code"; value: string }
    | { type: "quote"; children: MessageBlock[] }
    | { type: "raw"; value: string };

const extensions = [gfm()];
const mdastExtensions = [gfmFromMarkdown()];

export function parseMessage(text: string): MessageBlock[] {
    const tree = fromMarkdown(text, { extensions, mdastExtensions });
    const source = (node: Nodes): string =>
        text.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);

    // A newline inside a paragraph is a line break, as in chat and GitHub comments.
    const textWithBreaks = (value: string): MessageInline[] =>
        value
            .split(/\r?\n/)
            .flatMap((line, index): MessageInline[] =>
                index === 0
                    ? [{ type: "text", value: line }]
                    : [{ type: "break" }, { type: "text", value: line }],
            )
            .filter((node) => node.type !== "text" || node.value !== "");

    const inline = (nodes: PhrasingContent[]): MessageInline[] =>
        nodes.flatMap((node): MessageInline[] => {
            switch (node.type) {
                case "text":
                    return textWithBreaks(node.value);
                case "break":
                    return [{ type: "break" }];
                case "inlineCode":
                    return [{ type: "code", value: node.value }];
                case "strong":
                case "emphasis":
                case "delete":
                    return [{ type: node.type, children: inline(node.children) }];
                case "link":
                    return [
                        {
                            type: "link",
                            url: node.url,
                            ...(node.title ? { title: node.title } : {}),
                            children: inline(node.children),
                        },
                    ];
                default:
                    return textWithBreaks(source(node));
            }
        });

    const blocks = (nodes: (RootContent | BlockContent | DefinitionContent)[]): MessageBlock[] =>
        nodes.flatMap((node): MessageBlock[] => {
            switch (node.type) {
                case "paragraph":
                    return [{ type: "paragraph", children: inline(node.children) }];
                case "heading":
                    return [
                        {
                            type: "paragraph",
                            children: [{ type: "strong", children: inline(node.children) }],
                        },
                    ];
                case "list":
                    return [
                        {
                            type: "list",
                            ordered: node.ordered === true,
                            ...(node.ordered && node.start != null && node.start !== 1
                                ? { start: node.start }
                                : {}),
                            items: node.children.map((item) => {
                                const content = blocks(item.children);
                                if (item.checked == null) {
                                    return content;
                                }
                                const box: MessageInline = {
                                    type: "text",
                                    value: item.checked ? "[x] " : "[ ] ",
                                };
                                const [first, ...rest] = content;
                                return first?.type === "paragraph"
                                    ? [{ ...first, children: [box, ...first.children] }, ...rest]
                                    : [{ type: "paragraph", children: [box] }, ...content];
                            }),
                        },
                    ];
                case "code":
                    return [{ type: "code", value: node.value }];
                case "blockquote":
                    return [{ type: "quote", children: blocks(node.children) }];
                default:
                    return [{ type: "raw", value: source(node) }];
            }
        });

    return blocks(tree.children);
}

interface MessageBodyProps {
    text: string;
    followLink: (event: MouseEvent, url: string) => void;
}

export function MessageBody({ text, followLink }: MessageBodyProps): JSX.Element {
    const parsed = useMemo(() => parseMessage(text), [text]);
    return (
        <div class="message-body">
            <MessageBlocks blocks={parsed} followLink={followLink} />
        </div>
    );
}

type FollowLink = MessageBodyProps["followLink"];

export function MessageBlocks({
    blocks,
    followLink,
}: {
    blocks: MessageBlock[];
    followLink: FollowLink;
}): JSX.Element {
    return (
        <>
            {blocks.map((block, index) => (
                <Block key={index} block={block} followLink={followLink} />
            ))}
        </>
    );
}

function Block({
    block,
    followLink,
}: {
    block: MessageBlock;
    followLink: FollowLink;
}): JSX.Element {
    switch (block.type) {
        case "paragraph":
            return (
                <p>
                    <Inlines nodes={block.children} followLink={followLink} />
                </p>
            );
        case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
                <Tag start={block.start}>
                    {block.items.map((item, index) => (
                        <li key={index}>
                            <MessageBlocks blocks={item} followLink={followLink} />
                        </li>
                    ))}
                </Tag>
            );
        }
        case "code":
            return (
                <pre>
                    <code>{block.value}</code>
                </pre>
            );
        case "quote":
            return (
                <blockquote>
                    <MessageBlocks blocks={block.children} followLink={followLink} />
                </blockquote>
            );
        case "raw":
            return <p class="message-raw">{block.value}</p>;
    }
}

function Inlines({
    nodes,
    followLink,
}: {
    nodes: MessageInline[];
    followLink: FollowLink;
}): JSX.Element {
    return (
        <>
            {nodes.map((node, index) => (
                <Inline key={index} node={node} followLink={followLink} />
            ))}
        </>
    );
}

function Inline({
    node,
    followLink,
}: {
    node: MessageInline;
    followLink: FollowLink;
}): JSX.Element {
    switch (node.type) {
        case "text":
            return <>{node.value}</>;
        case "break":
            return <br />;
        case "code":
            return <code class="md-code">{node.value}</code>;
        case "strong":
            return (
                <strong>
                    <Inlines nodes={node.children} followLink={followLink} />
                </strong>
            );
        case "emphasis":
            return (
                <em>
                    <Inlines nodes={node.children} followLink={followLink} />
                </em>
            );
        case "delete":
            return (
                <s>
                    <Inlines nodes={node.children} followLink={followLink} />
                </s>
            );
        case "link":
            return (
                <DocLink url={node.url} title={node.title} followLink={followLink}>
                    <Inlines nodes={node.children} followLink={followLink} />
                </DocLink>
            );
    }
}
