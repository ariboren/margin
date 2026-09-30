import { expect, test } from "bun:test";
import { linkKind } from "./links.ts";

test("fragments, web, mail and relative files are live", () => {
    expect(linkKind("#1-verdict")).toBe("fragment");
    expect(linkKind("https://example.com/a")).toBe("web");
    expect(linkKind("HTTP://example.com")).toBe("web");
    expect(linkKind("mailto:a@b.test")).toBe("mail");
    expect(linkKind("../notes/a.md#part")).toBe("file");
    expect(linkKind("a b.md")).toBe("file");
});

test("every other scheme and protocol-relative links are inert, however they are dressed", () => {
    for (const url of [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        " javascript:alert(1)",
        "java\tscript:alert(1)",
        "java\nscript:alert(1)",
        "\u0001javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:x",
        "file:///etc/hosts",
        "//evil.example/x",
        "\\\\evil.example\\x",
        "/\\evil.example",
        "https:evil.example",
        "",
    ]) {
        expect({ url, kind: linkKind(url) }).toEqual({ url, kind: "inert" });
    }
});
