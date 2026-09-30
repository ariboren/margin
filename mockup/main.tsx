import { render } from "preact";
import { mount } from "../src/client/main.tsx";
import { attachScriptedAgent } from "./agent.ts";
import { DemoMenu } from "./demo-menu.tsx";
import { MemoryStore, realClock } from "./memory-store.ts";
import { planSeeds } from "./seed.ts";

interface Payload {
    path: string;
    source: string;
}

const payload = JSON.parse(document.getElementById("margin-doc")!.textContent!) as Payload;
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
}

const store = new MemoryStore(payload.path, payload.source);
const seeds = planSeeds(store.snapshot().doc);
store.seed(seeds.threads, seeds.edits);
attachScriptedAgent(store, realClock);

let rawUrl: string | null = null;
mount(document.getElementById("app")!, store, {
    path: "/Users/you/projects/example/docs/sample.md",
    relativePath: "docs/sample.md",
    rawUrl: () => {
        if (rawUrl) {
            URL.revokeObjectURL(rawUrl);
        }
        const blob = new Blob([store.snapshot().doc.source], { type: "text/plain;charset=utf-8" });
        rawUrl = URL.createObjectURL(blob);
        return rawUrl;
    },
});
render(<DemoMenu store={store} />, document.getElementById("demo")!);
