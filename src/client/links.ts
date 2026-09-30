export type LinkKind = "fragment" | "web" | "mail" | "file" | "inert";

/**
 * What a link in the doc may do. Only `#heading`, http(s), mailto and relative paths are live;
 * any other scheme (`javascript:`, `data:`, `file:`) and protocol-relative `//host` render inert,
 * since an AI-written doc is not trusted and Preact does not sanitize `href`. Classified the way
 * a browser parses: tabs and newlines inside, and control characters around, are dropped, and
 * `\` counts as `/`.
 */
export function linkKind(url: string): LinkKind {
    const parsed = url
        .replace(/[\t\n\r]/g, "")
        .replace(/^[\u0000- ]+|[\u0000- ]+$/g, "")
        .replace(/\\/g, "/");
    if (parsed === "") {
        return "inert";
    }
    if (parsed.startsWith("#")) {
        return "fragment";
    }
    if (/^https?:\/\//i.test(parsed)) {
        return "web";
    }
    if (/^mailto:/i.test(parsed)) {
        return "mail";
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(parsed) || parsed.startsWith("//")) {
        return "inert";
    }
    return "file";
}
