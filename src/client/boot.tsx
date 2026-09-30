import { render, type JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { DocStore } from "../core/model.ts";
import { BOOT_ELEMENT, TOKEN_META, type PageBoot } from "../server/protocol.ts";
import type { DocLocation } from "./components/doc-name.tsx";
import { RequestError, ServerStore, httpTransport, type StoreStatus } from "./server-store.ts";

type Mount = (root: HTMLElement, store: DocStore, location: DocLocation) => void;

/** Orca's built-in browser blocks popups, so external links ask the daemon to open the tab. */
function inOrcaBrowser(): boolean {
    return /\bOrca\//.test(navigator.userAgent);
}

/** The daemon's page: boot data from the shell, the store over the protocol, then the app. */
export async function bootDaemonPage(mount: Mount): Promise<void> {
    const boot = JSON.parse(document.getElementById(BOOT_ELEMENT)!.textContent!) as PageBoot;
    const token =
        document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content ?? "";
    const transport = httpTransport(boot.docId, token);
    const status = document.createElement("div");
    document.body.append(status);
    let store: ServerStore;
    try {
        store = await ServerStore.connect(transport);
    } catch {
        render(
            <ConnectionBanner
                status={{
                    connection: "lost",
                    problem: "Could not load the doc from margin. Run margin on the file again.",
                }}
            />,
            status,
        );
        return;
    }
    const report = async (opening: Promise<unknown>, refused: string) => {
        try {
            await opening;
        } catch (caught) {
            store.reportProblem(
                caught instanceof RequestError &&
                    (caught.status === 404 || caught.body?.error === "not-openable")
                    ? refused
                    : "Could not reach the margin daemon.",
            );
        }
    };
    mount(document.getElementById("app")!, store, {
        path: boot.path,
        relativePath: boot.relativePath,
        openFile: (link) =>
            void report(
                transport.openFile(link),
                link === undefined
                    ? "The file is missing on disk."
                    : "That link does not lead to a file in this repository.",
            ),
        ...(inOrcaBrowser()
            ? {
                  openUrl: (url: string) =>
                      void report(transport.openUrl(url), "That link could not be opened."),
              }
            : {}),
    });
    render(<LiveBanner store={store} />, status);
}

function LiveBanner({ store }: { store: ServerStore }): JSX.Element | null {
    const [status, setStatus] = useState(store.status());
    useEffect(() => store.subscribeStatus(setStatus), [store]);
    return <ConnectionBanner status={status} />;
}

/** Lives outside `App`: connection state is the host's concern, not the doc's. */
function ConnectionBanner({ status }: { status: StoreStatus }): JSX.Element | null {
    const text =
        status.problem ??
        (status.connection === "reconnecting"
            ? "Reconnecting to margin…"
            : status.connection === "lost"
              ? "Lost the connection to margin. Retrying; if it persists, run margin on the file again."
              : null);
    if (!text) {
        return null;
    }
    return (
        <div class="connection-banner" role="status">
            {text}
        </div>
    );
}
