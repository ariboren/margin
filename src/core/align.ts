import type { Unit } from "./model.ts";

/** Past this many DP cells a level's unmatched middle is left unpaired rather than aligned. */
const MAX_LCS_CELLS = 4_000_000;

/** Index pairs of a longest common subsequence of `a` and `b` under `same`. */
function lcsPairs<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): [number, number][] {
    let head = 0;
    while (head < a.length && head < b.length && same(a[head]!, b[head]!)) head++;
    let tail = 0;
    while (
        tail < a.length - head &&
        tail < b.length - head &&
        same(a[a.length - 1 - tail]!, b[b.length - 1 - tail]!)
    ) {
        tail++;
    }

    const pairs: [number, number][] = [];
    for (let i = 0; i < head; i++) pairs.push([i, i]);

    const n = a.length - head - tail;
    const m = b.length - head - tail;
    if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_LCS_CELLS) {
        const width = m + 1;
        const table = new Uint32Array((n + 1) * width);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                table[i * width + j] = same(a[head + i]!, b[head + j]!)
                    ? table[(i + 1) * width + j + 1]! + 1
                    : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (same(a[head + i]!, b[head + j]!)) {
                pairs.push([head + i, head + j]);
                i++;
                j++;
            } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
                i++;
            } else {
                j++;
            }
        }
    }

    for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k]);
    return pairs;
}

const sameText = (x: Unit, y: Unit) => x.kind === y.kind && x.hash === y.hash;
const sameKind = (x: Unit, y: Unit) => x.kind === y.kind;

/** Unchanged units pair by hash; units edited in between pair by kind in order. */
function alignLevel(prev: Unit[], next: Unit[], out: Map<Unit, Unit>): void {
    const exact = lcsPairs(prev, next, sameText);
    const pairs: [number, number][] = [];
    let prevFrom = 0;
    let nextFrom = 0;
    for (const [p, n] of [...exact, [prev.length, next.length] as [number, number]]) {
        const gap = lcsPairs(prev.slice(prevFrom, p), next.slice(nextFrom, n), sameKind);
        for (const [gp, gn] of gap) pairs.push([prevFrom + gp, nextFrom + gn]);
        if (p < prev.length) pairs.push([p, n]);
        prevFrom = p + 1;
        nextFrom = n + 1;
    }
    for (const [p, n] of pairs) {
        const before = prev[p]!;
        const after = next[n]!;
        out.set(after, before);
        alignLevel(before.children, after.children, out);
    }
}

/** Maps each unit of `next`, at every depth, to the `prev` unit it continues; new units are absent. */
export function alignUnits(prev: Unit[], next: Unit[]): Map<Unit, Unit> {
    const out = new Map<Unit, Unit>();
    alignLevel(prev, next, out);
    return out;
}

/** Carries UI keys across a reparse: aligned units keep their key, new units get `mint()`. */
export function carryKeys(
    prevKeys: Map<Unit, string>,
    prev: Unit[],
    next: Unit[],
    mint: () => string,
): Map<Unit, string> {
    const aligned = alignUnits(prev, next);
    const keys = new Map<Unit, string>();
    const visit = (units: Unit[]) => {
        for (const unit of units) {
            const before = aligned.get(unit);
            keys.set(unit, (before && prevKeys.get(before)) ?? mint());
            visit(unit.children);
        }
    };
    visit(next);
    return keys;
}
