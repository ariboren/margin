import {
    chmodSync,
    closeSync,
    fchmodSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the daemon keeps its state. Never `~/.margin`: that is a sidecar name beside a doc. */
export function stateDir(env: Record<string, string | undefined> = process.env): string {
    if (env.MARGIN_STATE_DIR) {
        return env.MARGIN_STATE_DIR;
    }
    if (env.XDG_RUNTIME_DIR) {
        return join(env.XDG_RUNTIME_DIR, "margin");
    }
    return join(homedir(), ".cache", "margin");
}

/** Creates the state dir as 0700 and refuses one that is a symlink or someone else's. */
export function ensureStateDir(dir: string): string {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) {
        throw new Error(`margin state dir is not a directory: ${dir}`);
    }
    if (process.getuid && stat.uid !== process.getuid()) {
        throw new Error(`margin state dir belongs to another user: ${dir}`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
        chmodSync(dir, 0o700);
    }
    return dir;
}

export interface StatePaths {
    dir: string;
    /** `DaemonInfo`; holds the token, so 0600. */
    info: string;
    /** flock taken while spawning, so concurrent opens start one daemon. */
    spawnLock: string;
    /** The detached daemon's stderr. */
    log: string;
}

export function statePaths(dir: string): StatePaths {
    return {
        dir,
        info: join(dir, "daemon.json"),
        spawnLock: join(dir, "spawn.lock"),
        log: join(dir, "daemon.log"),
    };
}

export interface DaemonInfo {
    pid: number;
    port: number;
    token: string;
    protocol: number;
    startedAt: string;
}

export function readDaemonInfo(path: string): DaemonInfo | null {
    try {
        const info = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonInfo>;
        if (
            typeof info.pid === "number" &&
            typeof info.port === "number" &&
            typeof info.token === "string" &&
            typeof info.protocol === "number"
        ) {
            return info as DaemonInfo;
        }
    } catch {
        // Missing or torn: no daemon we can talk to.
    }
    return null;
}

/** Written 0600 to a temp file and renamed, so readers never see half a token. */
export function writeDaemonInfo(path: string, info: DaemonInfo): void {
    const temp = `${path}.${process.pid}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
        fchmodSync(fd, 0o600);
        writeSync(fd, JSON.stringify(info));
    } finally {
        closeSync(fd);
    }
    renameSync(temp, path);
}

/** Removes the info file only while it still names `pid`, so a newer daemon's file survives. */
export function removeDaemonInfo(path: string, pid: number): void {
    if (readDaemonInfo(path)?.pid !== pid) {
        return;
    }
    try {
        unlinkSync(path);
    } catch {
        // Already gone.
    }
}

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}
