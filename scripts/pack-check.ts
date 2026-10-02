// Packs margin-md as npm would ship it, checks what is inside, then installs the tarball in a clean
// temp directory outside the repo and runs it there: `bunx margin-md fixtures/public-sample.md`
// with no build step and no dev dependencies, plus `margin setup` from the installed files.
// Output is paths, sizes and counts only, so it is safe to run with the private sample present.
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const publicSample = join(root, "fixtures/public-sample.md");
const privateSample = join(root, "fixtures/private/sample.md");

const EXACT = new Set([
    "package.json",
    "LICENSE",
    "README.md",
    "AGENTS.snippet.md",
    "skill/margin/SKILL.md",
]);
const REQUIRED = [
    "package.json",
    "LICENSE",
    "AGENTS.snippet.md",
    "skill/margin/SKILL.md",
    "src/cli/main.ts",
    "src/cli/agent-help.md",
    "dist/client/app.js",
    "dist/client/app.css",
];
/** Private sample lines shorter than this are too generic to prove a leak. */
const MIN_SCAN_LINE = 40;

class CheckFailed extends Error {}

function fail(message: string): never {
    throw new CheckFailed(message);
}

function allowed(path: string): boolean {
    if (EXACT.has(path) || path.startsWith("dist/client/")) return true;
    return (
        /^src\/(cli|core|server)\/[\w.-]+\.(ts|md)$/.test(path) &&
        !path.endsWith(".test.ts") &&
        path !== "src/cli/testing.ts" &&
        path !== "src/server/dev-open.ts"
    );
}

function exec(argv: string[], options: { cwd: string; env?: Record<string, string | undefined> }) {
    const result = Bun.spawnSync(argv, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
}

function must(argv: string[], options: { cwd: string; env?: Record<string, string | undefined> }) {
    const result = exec(argv, options);
    if (result.code !== 0) {
        fail(`${argv.join(" ")} exited ${result.code}\n${result.stderr}${result.stdout}`);
    }
    return result.stdout;
}

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    });
}

function kb(bytes: number): string {
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function checkContents(paths: string[]): void {
    const unexpected = paths.filter((path) => !allowed(path));
    if (unexpected.length > 0) fail(`unexpected in tarball:\n  ${unexpected.join("\n  ")}`);
    const missing = REQUIRED.filter((path) => !paths.includes(path));
    if (missing.length > 0) fail(`missing from tarball: ${missing.join(", ")}`);
    console.log(`paths: ${paths.length} files, all on the allow-list`);
}

/** Counts only: the sample's text never reaches the output. */
function scanPrivate(extracted: string): void {
    if (!existsSync(privateSample)) {
        console.log("private scan: skipped (no private sample)");
        return;
    }
    const lines = [
        ...new Set(
            readFileSync(privateSample, "utf8")
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length >= MIN_SCAN_LINE),
        ),
    ];
    const files = walk(extracted);
    let hits = 0;
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        hits += lines.filter((line) => text.includes(line)).length;
    }
    if (hits > 0) fail(`private scan: ${hits} sample lines found in the tarball`);
    console.log(`private scan: ${lines.length} sample lines, 0 found in ${files.length} files`);
}

function checkNoDevDependencies(app: string): void {
    const { devDependencies = {} } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // @types/* also arrive as real dependencies of the mdast packages.
    const present = Object.keys(devDependencies).filter(
        (name) => !name.startsWith("@types/") && existsSync(join(app, "node_modules", name)),
    );
    if (present.length > 0) fail(`dev dependencies installed: ${present.join(", ")}`);
}

async function smoke(tgz: string, extracted: string, scratch: string): Promise<void> {
    const app = join(scratch, "app");
    mkdirSync(join(app, "fixtures"), { recursive: true });
    writeFileSync(join(app, "package.json"), '{ "name": "margin-pack-check", "private": true }\n');
    must(["bun", "add", tgz], { cwd: app });
    checkNoDevDependencies(app);
    const installKb = Number(must(["du", "-sk", "node_modules"], { cwd: app }).split(/\s/)[0]);
    console.log(`install: node_modules ${(installKb / 1024).toFixed(1)} MB`);
    copyFileSync(publicSample, join(app, "fixtures/public-sample.md"));

    // A temp HOME too: `margin <doc>` looks at the user's installed skill, and the real one is
    // not this check's to read.
    const home = join(scratch, "home");
    mkdirSync(home);
    const env = {
        ...process.env,
        MARGIN_NO_OPEN: "1",
        MARGIN_STATE_DIR: join(scratch, "state"),
        HOME: home,
    };
    try {
        const opened = exec(["bunx", "margin-md", "fixtures/public-sample.md"], { cwd: app, env });
        const url = opened.stdout.split("\n")[0] ?? "";
        if (opened.code !== 0 || !url.startsWith("http://127.0.0.1:")) {
            fail(`bunx margin-md exited ${opened.code}\n${opened.stderr}${opened.stdout}`);
        }
        const page = await fetch(url);
        if (page.status !== 200 || !(await page.text()).includes("/app.js")) {
            fail(`the doc page answered ${page.status}`);
        }
        const js = await fetch(new URL("/app.js", url));
        const shipped = readFileSync(join(extracted, "dist/client/app.js"));
        if (js.status !== 200 || (await js.arrayBuffer()).byteLength !== shipped.byteLength) {
            fail(`/app.js answered ${js.status} without the shipped client`);
        }
        console.log("bunx margin-md fixtures/public-sample.md: page and prebuilt client served");
    } finally {
        exec(["bunx", "margin-md", "stop"], { cwd: app, env });
    }

    const skill = readFileSync(join(extracted, "skill/margin/SKILL.md"), "utf8");
    const runs: [string[], string, string][] = [
        [["setup"], "ok installed .claude/skills/margin/SKILL.md", join(app, ".claude")],
        [["setup"], "ok unchanged .claude/skills/margin/SKILL.md", join(app, ".claude")],
        [
            ["setup", "--user"],
            "ok installed ~/.claude/skills/margin/SKILL.md",
            join(home, ".claude"),
        ],
    ];
    for (const [args, ack, base] of runs) {
        const out = must(["bunx", "margin-md", ...args], { cwd: app, env });
        if (out.split("\n")[0] !== ack) fail(`margin ${args.join(" ")}: ${out.split("\n")[0]}`);
        if (readFileSync(join(base, "skills/margin/SKILL.md"), "utf8") !== skill) {
            fail(`margin ${args.join(" ")} installed a different skill`);
        }
    }
    if (existsSync(join(app, "AGENTS.md"))) fail("margin setup wrote AGENTS.md");
    console.log("margin setup, setup again, setup --user: skill installed from the package");
}

async function main(): Promise<void> {
    const scratch = mkdtempSync(join(tmpdir(), "margin-pack-"));
    try {
        const packDir = join(scratch, "pack");
        must(["bun", "pm", "pack", "--destination", packDir, "--quiet"], { cwd: root });
        const tgz = join(
            packDir,
            readdirSync(packDir).find((name) => name.endsWith(".tgz"))!,
        );
        // Bun lists a file once per bin that points at it; the archive holds the same bytes.
        const paths = [
            ...new Set(
                must(["tar", "-tzf", tgz], { cwd: scratch })
                    .split("\n")
                    .filter((line) => line.startsWith("package/") && !line.endsWith("/"))
                    .map((line) => line.slice("package/".length)),
            ),
        ].sort();
        checkContents(paths);

        const extracted = join(scratch, "extract");
        mkdirSync(extracted);
        must(["tar", "-xzf", tgz, "-C", extracted, "--strip-components=1"], { cwd: scratch });
        const sizes = paths.map((path) => statSync(join(extracted, path)).size);
        for (const [index, path] of paths.entries()) {
            console.log(`  ${kb(sizes[index]!).padStart(9)}  ${path}`);
        }
        const unpacked = sizes.reduce((sum, size) => sum + size, 0);
        console.log(`tarball: ${kb(statSync(tgz).size)} packed, ${kb(unpacked)} unpacked`);
        scanPrivate(extracted);

        await smoke(tgz, extracted, scratch);
        console.log("pack check passed");
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        if (!(error instanceof CheckFailed)) throw error;
        console.error(`pack check failed: ${error.message}`);
        process.exit(1);
    }
}
