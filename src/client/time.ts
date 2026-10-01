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

/** Current time, refreshed so relative times and "stalled" stay current. */
export function useNow(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 15_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}
