import { describe, expect, test } from "bun:test";
import { Fragment, type ComponentChildren, type VNode } from "preact";
import { MessageBlocks, parseMessage } from "./message.tsx";

const escape = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Enough of a server renderer for hook-free components: elements, fragments, text. */
function toHtml(node: ComponentChildren): string {
    if (node == null || typeof node === "boolean") {
        return "";
    }
    if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
        return escape(String(node));
    }
    if (Array.isArray(node)) {
        return node.map(toHtml).join("");
    }
    const vnode = node as VNode<Record<string, unknown>>;
    const { children, ...props } = vnode.props as { children?: ComponentChildren };
    if (vnode.type === Fragment) {
        return toHtml(children);
    }
    if (typeof vnode.type === "function") {
        return toHtml((vnode.type as (props: unknown) => ComponentChildren)(vnode.props));
    }
    const attributes = Object.entries(props)
        .filter(([, value]) => value != null && typeof value !== "function")
        .map(([name, value]) => ` ${name}="${escape(String(value))}"`)
        .join("");
    return `<${vnode.type}${attributes}>${toHtml(children)}</${vnode.type}>`;
}

const render = (text: string): string =>
    toHtml(MessageBlocks({ blocks: parseMessage(text), followLink: () => {} }));

describe("parseMessage", () => {
    test("paragraphs, and a single newline as a line break", () => {
        expect(parseMessage("One\ntwo\n\nThree")).toEqual([
            {
                type: "paragraph",
                children: [
                    { type: "text", value: "One" },
                    { type: "break" },
                    { type: "text", value: "two" },
                ],
            },
            { type: "paragraph", children: [{ type: "text", value: "Three" }] },
        ]);
    });

    test("bullet and numbered lists keep their items and start", () => {
        const [bullets, numbers] = parseMessage("- a\n- b\n\n3. c\n4. d");
        expect(bullets).toMatchObject({ type: "list", ordered: false });
        expect(bullets?.type === "list" && bullets.items.length).toBe(2);
        expect(numbers).toMatchObject({ type: "list", ordered: true, start: 3 });
    });

    test("headings become bold paragraphs", () => {
        expect(parseMessage("## Summary")).toEqual([
            {
                type: "paragraph",
                children: [{ type: "strong", children: [{ type: "text", value: "Summary" }] }],
            },
        ]);
    });

    test("tables, images and link references stay as their source text", () => {
        expect(parseMessage("| a | b |\n| - | - |\n| 1 | 2 |")).toEqual([
            { type: "raw", value: "| a | b |\n| - | - |\n| 1 | 2 |" },
        ]);
        expect(
            parseMessage(
                "See ![chart](https://example.com/c.png) and [x][ref]\n\n[ref]: https://example.com",
            ),
        ).toEqual([
            {
                type: "paragraph",
                children: [
                    { type: "text", value: "See " },
                    { type: "text", value: "![chart](https://example.com/c.png)" },
                    { type: "text", value: " and " },
                    { type: "text", value: "[x][ref]" },
                ],
            },
            { type: "raw", value: "[ref]: https://example.com" },
        ]);
    });
});

describe("MessageBlocks", () => {
    test("renders the markdown subset", () => {
        expect(
            render(
                "Two points:\n\n- **bold** and *italic*\n- `code` and [docs](https://example.com)\n\n```ts\nconst a = 1;\n```",
            ),
        ).toBe(
            "<p>Two points:</p>" +
                "<ul><li><p><strong>bold</strong> and <em>italic</em></p></li>" +
                '<li><p><code class="md-code">code</code> and ' +
                '<a href="https://example.com" target="_blank" rel="noreferrer noopener">docs</a></p></li></ul>' +
                "<pre><code>const a = 1;</code></pre>",
        );
    });

    test("bare URLs become links", () => {
        expect(render("See https://example.com/a now")).toContain('href="https://example.com/a"');
    });

    test("raw HTML is shown as text, never as markup", () => {
        const html = render('<script>alert(1)</script>\n\nHi <img src=x onerror="alert(1)"> there');
        expect(html).not.toContain("<script");
        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    });

    test("unsafe link schemes are inert, with no href", () => {
        for (const url of ["javascript:alert(1)", "data:text/html,x", "//evil.example/x"]) {
            const html = render(`[click](${url})`);
            expect(html).not.toContain("href=");
            expect(html).toContain('class="md-link-inert"');
        }
    });

    test("images never load", () => {
        const html = render("![x](https://example.com/track.png)");
        expect(html).not.toContain("<img");
        expect(html).toContain("![x](https://example.com/track.png)");
    });
});
