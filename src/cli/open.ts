// `margin <doc>`, `stop` and `status`: the only commands that talk to the daemon.
import {
    DaemonStartError,
    daemonStatus,
    DocNotFoundError,
    openDoc,
    stopDaemon,
} from "../server/api.ts";
import type { Io, ServerCommands } from "./main.ts";
import { recordDoc } from "./registry.ts";

export const serverCommands: ServerCommands = {
    async open(docPath, io) {
        try {
            // A person at a terminal asked for a tab; an agent's rerun is a check, not a request.
            const result = await openDoc(docPath, { env: io.env, reuseTab: !io.isTTY });
            await recordDoc(docPath, io.env);
            io.write(`${result.url}\n`);
            return 0;
        } catch (error) {
            if (error instanceof DocNotFoundError) {
                io.write(`err not-found; no such file: ${docPath}\n`);
                return 1;
            }
            if (error instanceof DaemonStartError) {
                io.write(`err daemon did not start; see ${error.logPath}\n`);
                return 1;
            }
            throw error;
        }
    },
    async stop(io: Io) {
        const result = await stopDaemon({ env: io.env });
        io.write(result.stopped ? "stopped\n" : "not running\n");
        return 0;
    },
    async status(io: Io) {
        const status = await daemonStatus({ env: io.env });
        if (!status) {
            io.write("not running\n");
            return 0;
        }
        const lines = [`pid ${status.pid} port ${status.port}`];
        for (const doc of status.docs) {
            lines.push(`${doc.path} tabs=${doc.clients}${doc.missing ? " missing" : ""}`);
        }
        io.write(`${lines.join("\n")}\n`);
        return 0;
    },
};
