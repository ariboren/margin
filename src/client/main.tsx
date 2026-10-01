import { render } from "preact";
import type { DocStore } from "../core/model.ts";
import { BOOT_ELEMENT } from "../server/protocol.ts";
import { App } from "./app.tsx";
import { bootDaemonPage } from "./boot.tsx";
import type { DocLocation } from "./components/doc-name.tsx";
import { applyViewPrefs, loadPrefs } from "./preferences.ts";
import { DEV_RELOAD_EVENT } from "./server-store.ts";
import { applyTheme, readChoice } from "./theme.ts";
import { UndoStack, recording } from "./undo.ts";
import "./fonts.css";

const DEV_PLACE_KEY = "margin:dev-place";
const DEV_RESTORE_MS = 3_000;
const DEV_POLL_MS = 50;

interface Place {
    scrollY: number;
    activeId: string | null;
}

/** Mounts the review UI over any `DocStore`: the mockup's in-memory one, or the daemon's. */
export function mount(root: HTMLElement, store: DocStore, location: DocLocation): void {
    const undo = new UndoStack(store);
    render(<App store={recording(store, undo)} location={location} undo={undo} />, root);
}

// Only the daemon's shell carries boot data.
if (typeof document !== "undefined" && document.getElementById(BOOT_ELEMENT)) {
    // The hooks set these again after mount; set here, the saved layout and theme are what the
    // page first paints with, instead of the defaults for a frame.
    applyViewPrefs(loadPrefs());
    applyTheme(readChoice());
    keepPlaceAcrossDevReloads();
    void bootDaemonPage(mount);
}

/**
 * Only `bun run dev` fires the reload event, so outside it this saves and restores nothing.
 * The active thread comes back by clicking its card, which is best effort.
 */
function keepPlaceAcrossDevReloads(): void {
    const place = takeSavedPlace();
    // Set until restored, so a reload that lands first keeps this place, not the top.
    let pending = place;
    window.addEventListener(DEV_RELOAD_EVENT, () => {
        const current: Place = pending ?? {
            scrollY: window.scrollY,
            activeId: document.querySelector(".card-active")?.getAttribute("data-card") ?? null,
        };
        try {
            sessionStorage.setItem(DEV_PLACE_KEY, JSON.stringify(current));
        } catch {
            // Storage blocked: the reload starts at the top.
        }
    });
    if (!place) {
        return;
    }
    // The browser's own restore would land later and win with a stale position.
    history.scrollRestoration = "manual";
    // The doc renders after the snapshot arrives, so wait until the page is tall enough.
    const deadline = performance.now() + DEV_RESTORE_MS;
    const restore = () => {
        const tall =
            document.querySelector("[data-unit]") !== null &&
            document.documentElement.scrollHeight >= place.scrollY + window.innerHeight;
        if (!tall && performance.now() < deadline) {
            setTimeout(restore, DEV_POLL_MS);
            return;
        }
        if (place.activeId) {
            document
                .querySelector<HTMLElement>(`[data-card="${CSS.escape(place.activeId)}"]`)
                ?.click();
        }
        window.scrollTo(0, place.scrollY);
        setTimeout(() => {
            window.scrollTo(0, place.scrollY);
            pending = null;
        }, DEV_POLL_MS);
    };
    // Timers, not animation frames: a background tab gets no frames until it is shown.
    setTimeout(restore, DEV_POLL_MS);
}

function takeSavedPlace(): Place | null {
    try {
        const saved = sessionStorage.getItem(DEV_PLACE_KEY);
        sessionStorage.removeItem(DEV_PLACE_KEY);
        return saved ? (JSON.parse(saved) as Place) : null;
    } catch {
        return null;
    }
}
