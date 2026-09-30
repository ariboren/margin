// Builds the browser client into prebuilt assets so users never run a build step. W1a's
// mockup/build.ts reuses `buildClient`.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

export interface BuildClientOptions {
    /**
     * TSX/TS entry. Import fonts here, not from the Tailwind input: Tailwind leaves their url()s
     * pointing into node_modules, while Bun inlines them as data URLs (import only the subsets
     * you need; all three families with every subset add about 650 KB).
     */
    entry: string;
    /** Tailwind input. Defaults to `app.css` beside the entry when that file exists. */
    css?: string;
    outdir: string;
    minify?: boolean;
    define?: Record<string, string>;
}

export interface BuildClientResult {
    js: string;
    css?: string;
    assets: string[];
}

const root = join(import.meta.dir, "..");
const tailwindCli = join(root, "node_modules/@tailwindcss/cli/dist/index.mjs");

export const clientEntry = join(root, "src/client/main.tsx");
export const clientOutdir = join(root, "dist/client");

export async function buildClient(options: BuildClientOptions): Promise<BuildClientResult> {
    const { entry, outdir, minify = true, define } = options;
    const result = await Bun.build({
        entrypoints: [entry],
        outdir,
        target: "browser",
        minify,
        define,
        naming: { entry: "app.[ext]", asset: "assets/[name]-[hash].[ext]" },
    });
    if (!result.success) {
        throw new AggregateError(result.logs, `client build failed for ${relative(root, entry)}`);
    }

    const js = join(outdir, "app.js");
    const bundledCss = join(outdir, "app.css");
    const imported =
        (await result.outputs.find((output) => output.path === bundledCss)?.text()) ?? "";
    const css = options.css ?? join(dirname(entry), "app.css");
    const tailwind = existsSync(css) ? await runTailwind(css, minify) : "";
    if (tailwind || imported) {
        writeFileSync(bundledCss, tailwind + imported);
    }

    return {
        js,
        css: tailwind || imported ? bundledCss : undefined,
        assets: result.outputs
            .filter((output) => output.kind === "asset")
            .map((output) => output.path)
            .filter((path) => path !== bundledCss),
    };
}

async function runTailwind(input: string, minify: boolean): Promise<string> {
    const scratch = mkdtempSync(join(tmpdir(), "margin-tw-"));
    const output = join(scratch, "tailwind.css");
    try {
        const proc = Bun.spawn(
            [
                process.execPath,
                tailwindCli,
                "-i",
                input,
                "-o",
                output,
                ...(minify ? ["--minify"] : []),
            ],
            { cwd: root, stdout: "pipe", stderr: "pipe" },
        );
        const code = await proc.exited;
        if (code !== 0) {
            throw new Error(`tailwind failed (${code}): ${await new Response(proc.stderr).text()}`);
        }
        return readFileSync(output, "utf8");
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

// Also the `prepack` hook: the tarball ships dist/client as built here, so start clean (hashed
// asset names from earlier builds would otherwise ride along) and fail rather than pack nothing.
if (import.meta.main) {
    if (!existsSync(clientEntry)) {
        console.error(`no client entry at ${relative(root, clientEntry)}`);
        process.exit(1);
    }
    rmSync(clientOutdir, { recursive: true, force: true });
    const built = await buildClient({ entry: clientEntry, outdir: clientOutdir });
    for (const path of [built.js, built.css, ...built.assets]) {
        if (path) {
            console.log(relative(root, path));
        }
    }
}
