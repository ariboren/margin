import { render } from "preact";
import type { DocStore } from "../core/model.ts";
import { BOOT_ELEMENT } from "../server/protocol.ts";
import { App } from "./app.tsx";
import { bootDaemonPage } from "./boot.tsx";
import type { DocLocation } from "./components/doc-name.tsx";
import "./fonts.css";

/** Mounts the review UI over any `DocStore`: the mockup's in-memory one, or the daemon's. */
export function mount(root: HTMLElement, store: DocStore, location: DocLocation): void {
    render(<App store={store} location={location} />, root);
}

// Only the daemon's shell carries boot data; the mockup imports `mount` and hosts itself.
if (typeof document !== "undefined" && document.getElementById(BOOT_ELEMENT)) {
    void bootDaemonPage(mount);
}
