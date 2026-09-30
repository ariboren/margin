/** localStorage can be blocked (private windows, some file:// contexts); callers fall back to memory. */
export function recall(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function remember(key: string, value: string | null): void {
    try {
        if (value === null) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, value);
        }
    } catch {
        // Nothing to do: the value lasts until reload.
    }
}
