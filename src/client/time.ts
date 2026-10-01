import { useEffect, useState } from "preact/hooks";

export function relativeTime(iso: string, now: number): string {
    const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (seconds < 45) {
        return "just now";
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    return `${Math.round(hours / 24)}d ago`;
}

/**
 * Current time, refreshed so relative times and "stalled" stay current. `wake` names a moment
 * the page changes on its own before the next refresh (given the time it last rendered with);
 * the clock also refreshes then.
 */
export function useNow(wake?: (now: number) => number | null): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 15_000);
        return () => clearInterval(timer);
    }, []);
    const deadline = wake?.(now) ?? null;
    useEffect(() => {
        if (deadline === null) {
            return;
        }
        // Never earlier than the deadline: a timer that fires a hair early would leave the page
        // as it was, with nothing left to wake it.
        const timer = setTimeout(
            () => setNow(Math.max(Date.now(), deadline)),
            Math.max(0, deadline - Date.now()),
        );
        return () => clearTimeout(timer);
    }, [deadline]);
    return now;
}
