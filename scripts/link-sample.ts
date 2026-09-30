// Copies the private sample into gitignored fixtures/private/sample.md. The source path is never
// hardcoded: the repo is public.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const target = join(import.meta.dir, "../fixtures/private/sample.md");
const source = process.argv[2] ?? process.env.MARGIN_SAMPLE;

if (!source) {
    console.error("usage: bun run link-sample <path-to-sample.md>  (or set MARGIN_SAMPLE)");
    process.exit(1);
}
const from = resolve(source);
if (!existsSync(from)) {
    console.error(`no file at ${from}`);
    process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(from, target);
console.log(`copied ${statSync(target).size} B to fixtures/private/sample.md`);
