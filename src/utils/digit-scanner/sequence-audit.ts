export type AuditSide = 'even_odd' | 'over_under' | 'digit';

export interface SequenceAudit {
    sample: number;
    recentWindow: number;
    previousWindow: number;
    lastDigit: number | null;
    currentValue: string;
    currentStreak: number;
    recentLeader: string | null;
    recentLeaderShare: number | null;
    previousLeader: string | null;
    previousLeaderShare: number | null;
    transitionLeader: number | null;
    transitionCount: number;
    transitionSample: number;
    reversalSignal: boolean;
    reversalNote: string;
}

const label = (digit: number, side: AuditSide, threshold: number) => {
    if (side === 'digit') return String(digit);
    if (side === 'even_odd') return digit % 2 === 0 ? 'Even' : 'Odd';
    return digit > threshold ? 'Over' : 'Under';
};

const leader = (digits: readonly number[], side: AuditSide, threshold: number) => {
    if (!digits.length) return { value: null, share: null };
    const counts = new Map<string, number>();
    digits.forEach(digit => {
        const key = label(digit, side, threshold);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return { value, share: count / digits.length };
};

/** Describes recent sequence behaviour; it is evidence, not a probability forecast. */
export function auditSequence(
    input: readonly number[],
    options: { side?: AuditSide; threshold?: number; recentWindow?: number; previousWindow?: number } = {}
): SequenceAudit {
    const digits = input.filter(digit => Number.isInteger(digit) && digit >= 0 && digit <= 9);
    const side = options.side ?? 'digit';
    const threshold = Math.max(0, Math.min(8, Math.floor(options.threshold ?? 3)));
    const recentWindow = Math.max(5, Math.floor(options.recentWindow ?? 20));
    const previousWindow = Math.max(recentWindow, Math.floor(options.previousWindow ?? 100));
    const recent = digits.slice(-recentWindow);
    const previous = digits.slice(-(recentWindow + previousWindow), -recentWindow);
    const lastDigit = digits.length ? digits[digits.length - 1] : null;

    let currentStreak = 0;
    if (lastDigit !== null) {
        for (let i = digits.length - 1; i >= 0 && digits[i] === lastDigit; i--) currentStreak++;
    }

    const transitions = lastDigit === null ? [] : digits.slice(0, -1).flatMap((digit, index) =>
        digit === lastDigit ? [digits[index + 1]] : []
    );
    const transitionCounts = new Map<number, number>();
    transitions.forEach(digit => transitionCounts.set(digit, (transitionCounts.get(digit) ?? 0) + 1));
    const transitionEntry = [...transitionCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const recentLeader = leader(recent, side, threshold);
    const previousLeader = leader(previous, side, threshold);
    const reversalSignal = !!(
        recentLeader.value &&
        previousLeader.value &&
        recentLeader.value !== previousLeader.value &&
        (recentLeader.share ?? 0) >= 0.5 &&
        (previousLeader.share ?? 0) >= 0.5 &&
        recent.length >= 10 &&
        previous.length >= 20
    );

    return {
        sample: digits.length,
        recentWindow: recent.length,
        previousWindow: previous.length,
        lastDigit,
        currentValue: lastDigit === null ? '—' : label(lastDigit, side, threshold),
        currentStreak,
        recentLeader: recentLeader.value,
        recentLeaderShare: recentLeader.share,
        previousLeader: previousLeader.value,
        previousLeaderShare: previousLeader.share,
        transitionLeader: transitionEntry?.[0] ?? null,
        transitionCount: transitionEntry?.[1] ?? 0,
        transitionSample: transitions.length,
        reversalSignal,
        reversalNote: reversalSignal
            ? `Recent leader changed from ${previousLeader.value} to ${recentLeader.value}. Treat it as a reversal warning, not a confirmed edge.`
            : 'No sufficiently large recent shift was detected.',
    };
}
