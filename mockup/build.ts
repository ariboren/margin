import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildClient } from "../scripts/build.ts";
import { decodeSource } from "../src/core/blocks.ts";

const root = join(import.meta.dir, "..");
const samplePath = join(root, "fixtures/private/sample.md");
const outdir = join(root, "mockup/dist");
const staging = join(outdir, ".build");

/** Keeps embedded text from closing the script element it sits in. */
function scriptSafe(text: string): string {
    return text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

if (!existsSync(samplePath)) {
    console.error(
        `No sample at ${relative(root, samplePath)}. Run: bun run link-sample <path to the sample doc>`,
    );
    process.exit(1);
}

const source = decodeSource(readFileSync(samplePath));
mkdirSync(outdir, { recursive: true });
const built = await buildClient({
    entry: join(root, "mockup/main.tsx"),
    css: join(root, "src/client/app.css"),
    outdir: staging,
});
if (built.assets.length > 0) {
    throw new Error(
        `expected every asset inlined, got ${built.assets.map((path) => relative(root, path)).join(", ")}`,
    );
}

const js = readFileSync(built.js, "utf8");
const css = built.css ? readFileSync(built.css, "utf8") : "";
const payload = JSON.stringify({ path: "sample.md", source })
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>margin · mockup</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<div id="demo"></div>
<script type="application/json" id="margin-doc">${scriptSafe(payload)}</script>
<script type="module">${scriptSafe(js)}</script>
</body>
</html>
`;
const page = join(outdir, "index.html");
writeFileSync(page, html);
rmSync(staging, { recursive: true, force: true });
console.log(`${relative(root, page)} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
