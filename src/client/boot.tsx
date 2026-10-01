import { render } from "preact";
import type { DocStore } from "../core/model.ts";
import { BOOT_ELEMENT, TOKEN_META, type PageBoot } from "../server/protocol.ts";
import type { DocLocation } from "./components/doc-name.tsx";
import { RequestError, ServerStore, httpTransport } from "./server-store.ts";

type Mount = (root: HTMLElement, store: DocStore, location: DocLocation) => void;

/** The faces the page sets text in; each is a swap font the first layout would otherwise lack. */
const FACES = [
    "1em 'Source Serif 4 Variable'",
    "italic 1em 'Source Serif 4 Variable'",
    "1em 'Inter Variable'",
    "1em 'JetBrains Mono Variable'",
];
/** How long the mount waits for the faces; a missing font must never hold the page. */
const FONT_WAIT_MS = 500;

/**
 * Loaded in parallel with the connect: the rail stacks its cards on the first layout, and a
 * font swapping in after it would move every card.
 */
async function fontsLoaded(): Promise<void> {
    const timeout = new Promise<void>((done) => setTimeout(done, FONT_WAIT_MS));
    try {
        await Promise.race([Promise.all(FACES.map((face) => document.fonts.load(face))), timeout]);
    } catch {
        // A face that fails to load falls back; the page mounts all the same.
    }
}

/** Orca's built-in browser blocks popups, so external links ask the daemon to open the tab. */
function inOrcaBrowser(): boolean {
    return /\bOrca\//.test(navigator.userAgent);
}

export interface OpeningCopy {
    /** The daemon refused: the file is gone, or the link is not one it opens. */
    refused: string;
    /** The daemon tried and no command on this machine worked. */
    failed: string;
}

/** What to tell the reader about a host action, or undefined when it worked. */
export async function openingProblem(
    opening: Promise<{ opened: string }>,
    copy: OpeningCopy,
): Promise<string | undefined> {
    try {
        return (await opening).opened === "none" ? copy.failed : undefined;
    } catch (caught) {
        return caught instanceof RequestError &&
            (caught.status === 404 || caught.body?.error === "not-openable")
            ? copy.refused
            : "Could not reach the margin daemon.";
    }
}

/** The daemon's page: boot data from the shell, the store over the protocol, then the app. */
export async function bootDaemonPage(mount: Mount): Promise<void> {
    const boot = JSON.parse(document.getElementById(BOOT_ELEMENT)!.textContent!) as PageBoot;
    const token =
        document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content ?? "";
    const transport = httpTransport(boot.docId, token);
    let store: ServerStore;
    try {
        [store] = await Promise.all([ServerStore.connect(transport), fontsLoaded()]);
    } catch {
        // Only for a page that never connected: once the app is up, the chip under the bar shows
        // the store's connection state and refused requests.
        const banner = document.createElement("div");
        document.body.append(banner);
        render(
            <div class="connection-banner" role="status">
                Could not load the doc from margin. Run margin on the file again.
            </div>,
            banner,
        );
        return;
    }
    const report = async (opening: Promise<{ opened: string }>, copy: OpeningCopy) => {
        const problem = await openingProblem(opening, copy);
        if (problem) {
            store.reportProblem(problem);
        }
    };
    mount(document.getElementById("app")!, store, {
        path: boot.path,
        relativePath: boot.relativePath,
        openFile: (link) =>
            void report(transport.openFile(link), {
                refused:
                    link === undefined
                        ? "The file is missing on disk."
                        : "That link does not lead to a file in this repository.",
                failed: "The file could not be opened.",
            }),
        revealFile: () =>
            void report(transport.revealFile(), {
                refused: "The file is missing on disk.",
                failed: "The file could not be shown in the file manager.",
            }),
        ...(inOrcaBrowser()
            ? {
                  openUrl: (url: string) =>
                      void report(transport.openUrl(url), {
                          refused: "That link could not be opened.",
                          failed: "That link could not be opened.",
                      }),
              }
            : {}),
    });
}
