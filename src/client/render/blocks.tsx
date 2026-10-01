import type { Nodes, PhrasingContent, RootContent, Table, TableCell } from "mdast";
import type { ComponentChildren, JSX } from "preact";
import type { Unit } from "../../core/model.ts";
import { unitKey } from "../view-model.ts";
import { useRender, type RenderContext } from "./context.ts";
import { DocLink } from "./link.tsx";
import { SourceText } from "./source-text.tsx";

function range(node: Nodes, shift: number): { start: number; end: number } {
    return { start: node.position!.start.offset! + shift, end: node.position!.end.offset! + shift };
}

function unitProps(unit: Unit | undefined): Record<string, string | number> {
    return unit ? { "data-unit": unit.start, "data-kind": unit.kind } : {};
}

export function Blocks({ nodes }: { nodes: RootContent[] }): JSX.Element {
    const context = useRender();
    // Keyed by the unit's stable key where it has one, so an edit above keeps this block (and an
    // editor open in it) mounted; offsets would shift and remount it.
    const keyOf = (node: RootContent, index: number) => {
        const start = (node.position?.start.offset ?? index) + context.shift;
        const unit = context.unitsByKey.get(unitKey({ kind: node.type as Unit["kind"], start }));
        return (unit && context.blockKeys.get(unit)) ?? `${node.type}-${start}`;
    };
    return (
        <>
            {nodes.map((node, index) => (
                <Block key={keyOf(node, index)} node={node} />
            ))}
        </>
    );
}

function Block({ node }: { node: RootContent }): JSX.Element | null {
    const context = useRender();
    const { start, end } = range(node, context.shift);
    const unit = context.unitsByKey.get(unitKey({ kind: node.type as Unit["kind"], start }));
    if (unit) {
        const editor = context.editorFor(unit);
        if (editor) {
            // A list item's editor stays in its li, so the items after it keep their numbers.
            return node.type === "listItem" ? (
                <li class={node.checked == null ? undefined : "task"}>{editor}</li>
            ) : (
                <>{editor}</>
            );
        }
    }
    const props = unitProps(unit);
    switch (node.type) {
        case "heading": {
            const Tag = `h${node.depth}` as "h1";
            return (
                <Tag id={`h-${start}`} {...props}>
                    <Phrasing nodes={node.children} />
                </Tag>
            );
        }
        case "paragraph":
            return (
                <p {...props}>
                    <Phrasing nodes={node.children} />
                </p>
            );
        case "list": {
            const Tag = node.ordered ? "ol" : "ul";
            const list = (
                <Tag start={node.start ?? undefined} {...props}>
                    <Blocks nodes={node.children} />
                </Tag>
            );
            return unit ? <SourceHatch unit={unit}>{list}</SourceHatch> : list;
        }
        case "listItem": {
            const { checked } = node;
            return (
                <li {...props} class={checked == null ? undefined : "task"}>
                    {checked == null ? null : <input type="checkbox" checked={checked} disabled />}
                    <Blocks nodes={node.children} />
                </li>
            );
        }
        case "blockquote":
            return (
                <blockquote {...props}>
                    <Blocks nodes={node.children} />
                </blockquote>
            );
        case "table":
            return <TableBlock node={node} unit={unit} context={context} />;
        case "code":
            return (
                <pre {...props} class="md-code-block" data-lang={node.lang ?? undefined}>
                    <code>
                        <SourceText value={node.value} start={start} end={end} />
                    </code>
                </pre>
            );
        case "html":
            return (
                <pre {...props} class="md-html">
                    <SourceText value={node.value} start={start} end={end} />
                </pre>
            );
        case "thematicBreak":
            return <hr {...props} />;
        case "definition":
            return (
                <p {...props} class="md-definition">
                    <SourceText value={context.source.slice(start, end)} start={start} end={end} />
                </p>
            );
        case "footnoteDefinition":
            return (
                <div {...props} class="md-footnote">
                    <span class="md-footnote-label">{node.label ?? node.identifier}</span>
                    <div>
                        <Blocks nodes={node.children} />
                    </div>
                </div>
            );
        default:
            // YAML frontmatter, and TOML, which parses to a node mdast's types do not list.
            return "value" in node && typeof node.value === "string" ? (
                <pre {...props} class="md-frontmatter">
                    <SourceText value={node.value} start={start} end={end} />
                </pre>
            ) : null;
    }
}

/** Tables and lists edit per cell or item; this is the escape hatch to edit the whole thing as source. */
function SourceHatch({ unit, children }: { unit: Unit; children: ComponentChildren }): JSX.Element {
    const { onEditAsSource } = useRender();
    return (
        <div class="source-hatch">
            {children}
            <button
                type="button"
                class="source-hatch-button"
                onClick={(event) => {
                    event.stopPropagation();
                    onEditAsSource(unit);
                }}
            >
                Edit as source
            </button>
        </div>
    );
}

function TableBlock({
    node,
    unit,
    context,
}: {
    node: Table;
    unit: Unit | undefined;
    context: RenderContext;
}): JSX.Element {
    const { start, end } = range(node, context.shift);
    const cells = new Map<string, Unit>();
    for (const candidate of context.units) {
        if (
            candidate.kind === "tableCell" &&
            candidate.cell &&
            candidate.start >= start &&
            candidate.end <= end
        ) {
            cells.set(`${candidate.cell.row}:${candidate.cell.column}`, candidate);
        }
    }
    const [head, ...body] = node.children;
    const renderRow = (row: Table["children"][number], rowIndex: number, Cell: "th" | "td") => (
        <tr key={rowIndex}>
            {row.children.map((cell, column) => (
                <CellBlock
                    key={column}
                    Cell={Cell}
                    cell={cell}
                    unit={cells.get(`${rowIndex}:${column}`)}
                    align={node.align?.[column] ?? null}
                />
            ))}
        </tr>
    );
    const table = (
        <div class="table-scroll" {...unitProps(unit)}>
            <table>
                {head ? <thead>{renderRow(head, 0, "th")}</thead> : null}
                <tbody>{body.map((row, index) => renderRow(row, index + 1, "td"))}</tbody>
            </table>
        </div>
    );
    return unit ? <SourceHatch unit={unit}>{table}</SourceHatch> : table;
}

interface CellBlockProps {
    Cell: "th" | "td";
    cell: TableCell;
    unit: Unit | undefined;
    align: Table["align"] extends (infer A)[] | null | undefined ? A : never;
}

function CellBlock({ Cell, cell, unit, align }: CellBlockProps): JSX.Element {
    const { editorFor } = useRender();
    const editor = unit ? editorFor(unit) : null;
    return (
        <Cell
            {...unitProps(unit)}
            style={align ? { textAlign: align } : undefined}
            class={editor ? "cell-editing" : undefined}
        >
            {editor ? (
                <>
                    <span class="cell-ghost" aria-hidden="true">
                        <Phrasing nodes={cell.children} />
                    </span>
                    {editor}
                </>
            ) : (
                <Phrasing nodes={cell.children} />
            )}
        </Cell>
    );
}

function Phrasing({ nodes }: { nodes: PhrasingContent[] }): JSX.Element {
    return (
        <>
            {nodes.map((node, index) => (
                <Inline key={index} node={node} />
            ))}
        </>
    );
}

function Inline({ node }: { node: PhrasingContent }): JSX.Element | null {
    const render = useRender();
    const { shift, source } = render;
    const { start, end } = range(node, shift);
    switch (node.type) {
        case "text":
            return <SourceText value={node.value} start={start} end={end} />;
        case "inlineCode":
            return (
                <code class="md-code">
                    <SourceText value={node.value} start={start} end={end} />
                </code>
            );
        case "emphasis":
            return (
                <em>
                    <Phrasing nodes={node.children} />
                </em>
            );
        case "strong":
            return (
                <strong>
                    <Phrasing nodes={node.children} />
                </strong>
            );
        case "delete":
            return (
                <s>
                    <Phrasing nodes={node.children} />
                </s>
            );
        case "link":
            return (
                <DocLink url={node.url} title={node.title} followLink={render.followLink}>
                    <Phrasing nodes={node.children} />
                </DocLink>
            );
        case "linkReference":
            return (
                <span class="md-ref">
                    <Phrasing nodes={node.children} />
                </span>
            );
        case "image":
        case "imageReference":
            return <span class="md-image">{node.alt ? `Image: ${node.alt}` : "Image"}</span>;
        case "break":
            return <br />;
        case "html":
            return <SourceText value={source.slice(start, end)} start={start} end={end} />;
        case "footnoteReference":
            return <sup class="md-footnote-ref">{node.label ?? node.identifier}</sup>;
        default:
            return null;
    }
}
