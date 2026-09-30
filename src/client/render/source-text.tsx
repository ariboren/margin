import { diffWords } from "diff";
import type { ComponentChildren, JSX } from "preact";
import type { Offset } from "../../core/model.ts";
import { spanAttributes, valueSpan, type SourceSpan } from "../source-map.ts";
import type { Decoration } from "../view-model.ts";
import { useRender } from "./context.ts";

interface SourceTextProps {
    value: string;
    /** The mdast node's own range, already in source space. */
    start: Offset;
    end: Offset;
}

function markClass(decorations: Decoration[], activeId: string | null): string {
    const kinds = new Set(decorations.map((decoration) => decoration.kind));
    const classes = ["hl"];
    for (const kind of kinds) {
        classes.push(`hl-${kind}`);
    }
    if (decorations.some((decoration) => decoration.id === activeId)) {
        classes.push("hl-active");
    }
    return classes.join(" ");
}

function threadIds(decorations: Decoration[]): string {
    return decorations.map((decoration) => decoration.id).join(" ");
}

/**
 * A run of rendered text that keeps its source range, split wherever a thread's quote starts or
 * ends so highlights and suggestion diffs sit inside the text without breaking the source map.
 */
export function SourceText({ value, start, end }: SourceTextProps): JSX.Element {
    const { source, decorations, activeId } = useRender();
    const span = valueSpan(source, value, start, end);
    const touching = decorations.filter(
        (decoration) => decoration.end > span.start && decoration.start < span.end,
    );
    if (touching.length === 0) {
        return <span {...spanAttributes(span)}>{value}</span>;
    }
    if (!span.exact) {
        return (
            <mark class={markClass(touching, activeId)} data-threads={threadIds(touching)}>
                <span {...spanAttributes(span)}>{value}</span>
            </mark>
        );
    }

    const cuts = new Set([span.start, span.end]);
    for (const decoration of touching) {
        for (const edge of [decoration.start, decoration.end]) {
            if (edge > span.start && edge < span.end) {
                cuts.add(edge);
            }
        }
    }
    const edges = [...cuts].sort((a, b) => a - b);
    const out: ComponentChildren[] = [];
    let i = 0;
    while (i < edges.length - 1) {
        const a = edges[i]!;
        const b = edges[i + 1]!;
        const inner = touching.find(
            (decoration) =>
                decoration.kind === "suggest" &&
                decoration.start === a &&
                decoration.end <= span.end,
        );
        if (inner) {
            out.push(
                <SuggestionDiff
                    key={a}
                    decoration={inner}
                    active={inner.id === activeId}
                    source={source}
                />,
            );
            i = edges.indexOf(inner.end);
            continue;
        }
        const covering = touching.filter(
            (decoration) => decoration.start <= a && decoration.end >= b,
        );
        out.push(
            <Piece
                key={a}
                span={{ start: a, end: b, exact: true }}
                text={source.slice(a, b)}
                covering={covering}
                activeId={activeId}
            />,
        );
        i++;
    }
    return <>{out}</>;
}

interface PieceProps {
    span: SourceSpan;
    text: string;
    covering: Decoration[];
    activeId: string | null;
}

function Piece({ span, text, covering, activeId }: PieceProps): JSX.Element {
    if (covering.length === 0) {
        return <span {...spanAttributes(span)}>{text}</span>;
    }
    const suggestion = covering.find((decoration) => decoration.kind === "suggest");
    const marks = covering.filter((decoration) => decoration !== suggestion);
    let body: JSX.Element = <span {...spanAttributes(span)}>{text}</span>;
    if (suggestion) {
        const active = suggestion.id === activeId ? " sg-active" : "";
        body = (
            <>
                <del
                    class={`sg-del${active}`}
                    data-threads={suggestion.id}
                    {...spanAttributes(span)}
                >
                    {text}
                </del>
                {span.end === suggestion.end ? (
                    <ins class={`sg-ins${active}`} data-threads={suggestion.id}>
                        {suggestion.replace}
                    </ins>
                ) : null}
            </>
        );
    }
    if (marks.length === 0) {
        return body;
    }
    return (
        <mark class={markClass(marks, activeId)} data-threads={threadIds(marks)}>
            {body}
        </mark>
    );
}

interface SuggestionDiffProps {
    decoration: Decoration;
    active: boolean;
    source: string;
}

/** Word-level diff of a suggestion whose quote sits inside one text run. */
function SuggestionDiff({ decoration, active, source }: SuggestionDiffProps): JSX.Element {
    const before = source.slice(decoration.start, decoration.end);
    const parts = diffWords(before, decoration.replace ?? "");
    let at = decoration.start;
    return (
        <span class={active ? "sg sg-active" : "sg"} data-threads={decoration.id}>
            {parts.map((part, index) => {
                if (part.added) {
                    return (
                        <ins key={index} class="sg-ins">
                            {part.value}
                        </ins>
                    );
                }
                const span = { start: at, end: at + part.value.length, exact: true };
                at = span.end;
                return part.removed ? (
                    <del key={index} class="sg-del" {...spanAttributes(span)}>
                        {part.value}
                    </del>
                ) : (
                    <span key={index} {...spanAttributes(span)}>
                        {part.value}
                    </span>
                );
            })}
        </span>
    );
}
