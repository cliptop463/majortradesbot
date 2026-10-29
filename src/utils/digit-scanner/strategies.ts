import type { Direction, StrategyResult } from './types';

/**
 * These are descriptive heuristics over historical digits, not predictors with
 * established edge. Tick outcomes may be independent; a historical anomaly, streak,
 * gap, or apparent cycle does not imply the next digit will repeat or revert.
 *
 * Thresholds are intentionally more conservative than uncorrected per-digit z >= 2.
 * The 2.8 threshold is an approximate per-family guard for inspecting 10 digits;
 * it is not a formal guarantee of a calibrated false-positive rate, especially for
 * overlapping/weighted samples or the additional cycle search.
 */
export const STRATEGY_MIN_OBSERVATIONS = {
    frequency: 200,
    recency: 200,
    streak: 50,
    momentum: 200,
    skew: 200,
    transitions: 200,
    gaps: 100,
    cycles: 200,
} as const;

export const THRESHOLDS = {
    zMatch: 2.8,
    zDiff: -2.8,
    streakMin: 4,
    momentumZDiff: -2.8,
    skewChiSquare: 21.67,
    transitionsMinSuccessors: 30,
    gapMin: 29,
    cycleZMin: 3.8,
} as const;

export interface DecideFromZResult {
    direction: Direction;
    digit: number;
    strength: number;
    z: number;
}

/** Selects the strongest extreme only after thresholds are crossed. */
export function decideFromZ(
    countsOrZ: readonly number[],
    nOrOptions?: number | { zMatch?: number; zDiff?: number },
    maybeOptions?: { zMatch?: number; zDiff?: number }
): DecideFromZResult | null {
    let zScores: number[];
    let zMatch = THRESHOLDS.zMatch;
    let zDiff = THRESHOLDS.zDiff;

    if (typeof nOrOptions === 'number') {
        const n = nOrOptions;
        if (!Number.isFinite(n) || n <= 0) return null;
        if (maybeOptions?.zMatch !== undefined) zMatch = maybeOptions.zMatch;
        if (maybeOptions?.zDiff !== undefined) zDiff = maybeOptions.zDiff;
        const expected = n / 10;
        const sd = Math.sqrt(n * 0.1 * 0.9);
        if (sd <= 0) return null;
        zScores = Array.from({ length: 10 }, (_, d) => ((countsOrZ[d] ?? 0) - expected) / sd);
    } else {
        if (nOrOptions?.zMatch !== undefined) zMatch = nOrOptions.zMatch;
        if (nOrOptions?.zDiff !== undefined) zDiff = nOrOptions.zDiff;
        zScores = Array.from({ length: 10 }, (_, d) => countsOrZ[d] ?? 0);
    }

    if (zScores.some(z => !Number.isFinite(z))) return null;

    let hotDigit = 0;
    let coldDigit = 0;
    for (let d = 1; d < 10; d++) {
        if (zScores[d] > zScores[hotDigit]) hotDigit = d;
        if (zScores[d] < zScores[coldDigit]) coldDigit = d;
    }

    const hotZ = zScores[hotDigit];
    const coldZ = zScores[coldDigit];
    const hotOK = hotZ >= zMatch;
    const coldOK = coldZ <= zDiff;
    if (!hotOK && !coldOK) return null;

    // Normalized evidence strength is for display/ranking only, not a probability.
    const hotStrength = hotOK ? Math.min(1, hotZ / 5) : -1;
    const coldStrength = coldOK ? Math.min(1, Math.abs(coldZ) / 5) : -1;
    if (coldOK && (!hotOK || coldStrength >= hotStrength)) {
        return { direction: 'DIFFERS', digit: coldDigit, strength: coldStrength, z: coldZ };
    }
    return { direction: 'MATCHES', digit: hotDigit, strength: hotStrength, z: hotZ };
}

const invalidDigitSequence = (digits: readonly number[]) =>
    digits.some(d => !Number.isInteger(d) || d < 0 || d > 9);

const noSignal = (id: string, name: string, reason: string, status: 'abstain' | 'ineligible' = 'abstain'): StrategyResult =>
    ({ id, name, status, reason });

const countsOf = (digits: readonly number[]) => {
    const counts = new Array(10).fill(0);
    digits.forEach(d => { counts[d] += 1; });
    return counts;
};

function zReason(decision: DecideFromZResult, prefix: string, threshold: number): string {
    return `${prefix}; z=${decision.z.toFixed(2)} crossed ${threshold.toFixed(1)} threshold. Historical anomaly only; not a forecast guarantee.`;
}

export function frequencyStrategy(digits: readonly number[]): StrategyResult {
    const id = 'frequency', name = 'Frequency', min = STRATEGY_MIN_OBSERVATIONS.frequency;
    if (digits.length < min) return noSignal(id, name, `Needs ${min} valid observations (have ${digits.length}).`, 'ineligible');
    if (invalidDigitSequence(digits)) return noSignal(id, name, 'Invalid digit sequence.');
    const counts = countsOf(digits);
    const d = decideFromZ(counts, digits.length);
    if (!d) return noSignal(id, name, `No digit crossed the conservative z threshold in ${digits.length} ticks.`);
    return {
        id, name, status: 'signal', direction: d.direction, digit: d.digit, strength: d.strength,
        reason: zReason(d, `Digit ${d.digit} occurred ${counts[d.digit]}/${digits.length} times`, d.direction === 'MATCHES' ? THRESHOLDS.zMatch : Math.abs(THRESHOLDS.zDiff)),
    };
}

export function recencyStrategy(digits: readonly number[]): StrategyResult {
    const id = 'recency', name = 'Recency', min = STRATEGY_MIN_OBSERVATIONS.recency;
    if (digits.length < min) return noSignal(id, name, `Needs ${min} valid observations (have ${digits.length}).`, 'ineligible');
    if (invalidDigitSequence(digits)) return noSignal(id, name, 'Invalid digit sequence.');
    const weights = new Array(10).fill(0);
    let sumW = 0, sumW2 = 0;
    for (let i = 0; i < digits.length; i++) {
        const w = Math.pow(0.5, (digits.length - 1 - i) / 50);
        weights[digits[i]] += w; sumW += w; sumW2 += w * w;
    }
    const nEff = sumW * sumW / sumW2;
    const effectiveCounts = weights.map(w => w / sumW * nEff);
    const d = decideFromZ(effectiveCounts, nEff);
    if (!d) return noSignal(id, name, `Recency-weighted digit shares did not cross threshold (effective N=${nEff.toFixed(1)}).`);
    return {
        id, name, status: 'signal', direction: d.direction, digit: d.digit, strength: d.strength,
        reason: zReason(d, `Digit ${d.digit} has ${(100 * weights[d.digit] / sumW).toFixed(1)}% of exponentially weighted share (half-life 50 ticks)`, d.direction === 'MATCHES' ? THRESHOLDS.zMatch : Math.abs(THRESHOLDS.zDiff)),
    };
}

export function streakStrategy(digits: readonly number[]): StrategyResult {
    const id = 'streak', name = 'Streak', min = STRATEGY_MIN_OBSERVATIONS.streak;
    if (digits.length < min) return noSignal(id, name, `Needs ${min} valid observations (have ${digits.length}).`, 'ineligible');
    if (invalidDigitSequence(digits)) return noSignal(id, name, 'Invalid digit sequence.');
    const target = digits[digits.length - 1];
    let run = 1;
    for (let i = digits.length - 2; i >= 0 && digits[i] === target; i--) run++;
    if (run < THRESHOLDS.streakMin) return noSignal(id, name, `Current run is ${run}; threshold is ${THRESHOLDS.streakMin}.`);
    return {
        id, name, status: 'signal', direction: 'MATCHES', digit: target,
        strength: Math.min(1, run / 8),
        reason: `Digit ${target} repeated ${run} consecutive ticks. Run length is descriptive and does not imply continuation.`,
    };
}

export function momentumStrategy(digits: readonly number[]): StrategyResult {
    const id = 'momentum', name = 'Momentum', min = STRATEGY_MIN_OBSERVATIONS.momentum;
    if (digits.length < min) return noSignal(id, name, `Needs ${min} valid observations (have ${digits.length}).`, 'ineligible');
    if (invalidDigitSequence(digits)) return noSignal(id, name, 'Invalid digit sequence.');
    const recent = digits.slice(-50), prior = digits.slice(-150, -50);
    const recentC = countsOf(recent), priorC = countsOf(prior);
    const zs = Array.from({ length: 10 }, (_, d) => {
        const p1 = recentC[d] / recent.length, p2 = priorC[d] / prior.length;
        const pooled = (recentC[d] + priorC[d]) / (recent.length + prior.length);
        const se = Math.sqrt(pooled * (1 - pooled) * (1 / recent.length + 1 / prior.length));
        return se > 0 ? (p1 - p2) / se : 0;
    });
    const d = decideFromZ(zs, { zMatch: THRESHOLDS.zMatch, zDiff: THRESHOLDS.momentumZDiff });
    if (!d) return noSignal(id, name, 'No digit share shift crossed the conservative two-window threshold.');
    return {
        id, name, status: 'signal', direction: d.direction, digit: d.digit, strength: d.strength,
        reason: zReason(d, `Digit ${d.digit}: ${(100 * recentC[d.digit] / 50).toFixed(1)}% in last 50 ticks vs ${(100 * priorC[d.digit] / 100).toFixed(1)}% in prior 100`, d.direction === 'MATCHES' ? THRESHOLDS.zMatch : Math.abs(THRESHOLDS.momentumZDiff)),
    };
}

export function skewStrategy(digits: readonly number[]): StrategyResult {
    const id = 'skew', name = 'Distribution skew', min = STRATEGY_MIN_OBSERVATIONS.skew;
    if (digits.length < min) return noSignal(id, name, `Needs ${min} valid observations (have ${digits.length}).`, 'ineligible');
    if (invalidDigitSequence(digits)) return noSignal(id, name, 'Invalid digit sequence.');
    const counts = countsOf(digits), expected = digits.length / 10;
    const chi = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    if (chi < THRESHOLDS.skewChiSquare) return noSignal(id, name, `Chi-square=${chi.toFixed(2)} below conservative threshold ${THRESHOLDS.skewChiSquare} (df=9).`);
    let hot = 0, cold = 0;
    for (let d = 1; d < 10; d++) {
        if (counts[d] > counts[hot]) hot = d;
        if (counts[d] < counts[cold]) cold = d;
    }
    const high = counts[hot] - expected >= expected - counts[cold];
    const digit = high ? hot : cold;
    return {
        id, name, status: 'signal', direction: high ? 'MATCHES' : 'DIFFERS', digit,
        strength: Math.min(1, chi / (THRESHOLDS.skewChiSquare * 2)),
        reason: `Chi-square=${chi.toFixed(2)} (df=9); digit ${digit} occurred ${counts[digit]} times vs ${expected.toFixed(1)} expected. Describes this sample only.`,
    };
}

export function transitionsStrategy(digits: readonly number[]): StrategyResult {
    const id = 'transitions', name = 'Transitions', min = STRATEGY_MIN_OBSERVATIONS.transitions;
    if (digits.length < min) return noSignal(id, name, `Needs ${min} valid observations (have ${digits.length}).`, 'ineligible');
    if (invalidDigitSequence(digits)) return noSignal(id, name, 'Invalid digit sequence.');
    const current = digits[digits.length - 1], successors: number[] = [];
    for (let i = 0; i < digits.length - 1; i++) if (digits[i] === current) successors.push(digits[i + 1]);
    if (successors.length < THRESHOLDS.transitionsMinSuccessors) return noSignal(id, name, `Only ${successors.length} historical successors for digit ${current}; ${THRESHOLDS.transitionsMinSuccessors} required.`, 'ineligible');
    const counts = countsOf(successors), d = decideFromZ(counts, successors.length);
    if (!d) return noSignal(id, name, `Successor distribution after digit ${current} did not cross threshold.`);
    return {
        id, name, status: 'signal', direction: d.direction, digit: d.digit, strength: d.strength,
        reason: zReason(d, `Digit ${d.digit} followed current digit ${current} ${counts[d.digit]}/${successors.length} times`, d.direction === 'MATCHES' ? THRESHOLDS.zMatch : Math.abs(THRESHOLDS.zDiff)),
    };
}

export function gapsStrategy(digits: readonly number[]): StrategyResult {
    const id = 'gaps', name = 'Gaps', min = STRATEGY_MIN_OBSERVATIONS.gaps;
    if (digits.length < min) return noSignal(id, name, `Needs ${min} valid observations (have ${digits.length}).`, 'ineligible');
    if (invalidDigitSequence(digits)) return noSignal(id, name, 'Invalid digit sequence.');
    const lastSeen = new Array(10).fill(-1);
    digits.forEach((d, i) => { lastSeen[d] = i; });
    const gaps = lastSeen.map((i, d) => i < 0 ? digits.length : digits.length - 1 - i);
    const maxGap = Math.max(...gaps), digit = gaps.indexOf(maxGap);
    // Keep gap information visible, but never turn the gambler's fallacy into a vote.
    return noSignal(id, name, `Longest gap is ${maxGap} ticks for digit ${digit}. A gap alone is not evidence that a digit is due; abstaining.`);
}

export function cyclesStrategy(digits: readonly number[]): StrategyResult {
    const id = 'cycles', name = 'Cycles', min = STRATEGY_MIN_OBSERVATIONS.cycles;
    if (digits.length < min) return noSignal(id, name, `Needs ${min} valid observations (have ${digits.length}).`, 'ineligible');
    if (invalidDigitSequence(digits)) return noSignal(id, name, 'Invalid digit sequence.');
    let bestPeriod = 2, bestZ = -Infinity, bestMatches = 0, bestN = 0;
    for (let period = 2; period <= 12; period++) {
        const n = digits.length - period;
        let matches = 0;
        for (let i = period; i < digits.length; i++) if (digits[i] === digits[i - period]) matches++;
        const expected = n * 0.1, sd = Math.sqrt(n * 0.1 * 0.9);
        const z = sd > 0 ? (matches - expected) / sd : 0;
        if (z > bestZ) { bestZ = z; bestPeriod = period; bestMatches = matches; bestN = n; }
    }
    // Searching 11 periods inflates the maximum z; use a more conservative threshold.
    if (bestZ < THRESHOLDS.cycleZMin) return noSignal(id, name, `Best tested period=${bestPeriod}, z=${bestZ.toFixed(2)}; below ${THRESHOLDS.cycleZMin}.`);
    const digit = digits[digits.length - bestPeriod];
    return {
        id, name, status: 'signal', direction: 'MATCHES', digit,
        strength: Math.min(1, bestZ / 6),
        reason: `Period ${bestPeriod}: ${bestMatches}/${bestN} lagged digit matches, z=${bestZ.toFixed(2)}. Selected after searching 11 periods; multiple-testing risk remains.`,
    };
}

export const STRATEGIES: readonly ((digits: readonly number[]) => StrategyResult)[] = [
    frequencyStrategy,
    recencyStrategy,
    streakStrategy,
    momentumStrategy,
    skewStrategy,
    transitionsStrategy,
    gapsStrategy,
    cyclesStrategy,
];
