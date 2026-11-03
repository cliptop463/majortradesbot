/**
 * Matches / Differs frequency analysis for one market.
 *
 * Counts how often each last digit appeared in a recent window of ticks, then reports the most and
 * least frequent digit, how far the distribution is from uniform (deviation, chi-square) and a
 * heuristic "score". Everything here describes PAST ticks. On Deriv synthetic indices digits are
 * random, so a skew in the past does not predict the next tick, and the score is not a probability.
 */

/** Default number of ticks analysed. */
export const DEFAULT_SAMPLE = 1000;

/** Chi-square critical values for 9 degrees of freedom (10 digits, uniform null). */
export const CHI2_CRITICAL = { p05: 16.92, p01: 21.67, p001: 27.88 } as const;

/** Per-digit z threshold after allowing for picking the max/min of 10 digits (Bonferroni, about 2.8). */
export const Z_BONFERRONI = 2.8;

/** Payout (as a multiple of stake, stake included) needed to break even if digits are uniform. */
export const MATCH_BREAKEVEN_PAYOUT = 10;
export const DIFFER_BREAKEVEN_PAYOUT = 1 / 0.9; // about 1.11

export type Significance = 'p<0.001' | 'p<0.01' | 'p<0.05' | 'none';

export interface DigitStat {
    digit: number;
    count: number;
    percent: number;
    /** (count - expected) / sqrt(n * 0.1 * 0.9) */
    z: number;
}

export interface MatchesDiffersAnalysis {
    /** Number of valid digits analysed. */
    sample: number;
    stats: DigitStat[];
    /** Most frequent digit: the Matches candidate. Ties go to the lowest digit. */
    highest: number;
    /** Least frequent digit: the Differs candidate. Ties go to the lowest digit. */
    lowest: number;
    /** Sum over digits of |percent - 10|, range 0 to 180. */
    deviation: number;
    /** Heuristic 50 to 96. NOT a probability. */
    score: number;
    /** What the score typically is on fair random digits at this sample size. */
    expectedNoiseScore: number;
    chi2: number;
    /** chi2 > 16.92, i.e. p < 0.05 against uniform. */
    significant: boolean;
    significance: Significance;
    matchPercent: number;
    differPercent: number;
    /** Whether the highest/lowest digit clears the Bonferroni threshold on its own. */
    highestExtreme: boolean;
    lowestExtreme: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Last displayed digit of a price. Uses toFixed(pipSize) so trailing zeros count:
 * lastDigit(1583.2, 2) is 0 (the price is 1583.20), lastDigit(1583.25, 2) is 5.
 * Returns NaN for a non-finite price or an unusable pipSize.
 */
export function lastDigit(price: number, pipSize: number): number {
    if (typeof price !== 'number' || !Number.isFinite(price)) return NaN;
    if (!Number.isInteger(pipSize) || pipSize < 0 || pipSize > 100) return NaN;
    return Number(price.toFixed(pipSize).slice(-1));
}

/** Score = clamp(52 + 1.4 * deviation, 50, 96). */
export const scoreFromDeviation = (deviation: number) => clamp(52 + 1.4 * deviation, 50, 96);

/**
 * Expected deviation of a fair random sample of n digits (exact binomial expectation).
 * Used to show what "no skew at all" looks like on the score scale.
 */
export function expectedDeviation(n: number): number {
    if (!Number.isInteger(n) || n <= 0) return 0;
    const mean = n * 0.1;
    let pmf = Math.pow(0.9, n);
    let sum = 0;
    for (let k = 0; k <= n; k++) {
        sum += pmf * Math.abs(k - mean);
        pmf *= ((n - k) / (k + 1)) * (0.1 / 0.9);
    }
    return 10 * sum * (100 / n);
}

export const expectedNoiseScore = (n: number) => scoreFromDeviation(expectedDeviation(n));

export function significanceOf(chi2: number): Significance {
    if (chi2 > CHI2_CRITICAL.p001) return 'p<0.001';
    if (chi2 > CHI2_CRITICAL.p01) return 'p<0.01';
    if (chi2 > CHI2_CRITICAL.p05) return 'p<0.05';
    return 'none';
}

/**
 * Analyses a window of last digits. Values that are not integers from 0 to 9 are ignored.
 * An empty (or all-invalid) input returns a neutral result and does not throw.
 */
export function analyze(digits: readonly number[]): MatchesDiffersAnalysis {
    const valid = (Array.isArray(digits) ? digits : []).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    const sample = valid.length;
    const counts: number[] = new Array(10).fill(0);
    valid.forEach(d => counts[d]++);

    const n = sample || 1;
    const expected = n / 10;
    const sd = Math.sqrt(n * 0.1 * 0.9);

    const stats: DigitStat[] = counts.map((count, digit) => ({
        digit,
        count,
        percent: sample ? (count / n) * 100 : 0,
        z: sample ? (count - expected) / sd : 0,
    }));

    // First index wins ties, for both extremes.
    let highest = 0;
    let lowest = 0;
    for (let d = 1; d < 10; d++) {
        if (stats[d].count > stats[highest].count) highest = d;
        if (stats[d].count < stats[lowest].count) lowest = d;
    }

    const deviation = sample ? stats.reduce((sum, s) => sum + Math.abs(s.percent - 10), 0) : 0;
    const chi2 = sample ? counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0) : 0;

    return {
        sample,
        stats,
        highest,
        lowest,
        deviation,
        score: sample ? scoreFromDeviation(deviation) : 50,
        expectedNoiseScore: sample ? expectedNoiseScore(sample) : 50,
        chi2,
        significant: chi2 > CHI2_CRITICAL.p05,
        significance: significanceOf(chi2),
        matchPercent: stats[highest].percent,
        differPercent: 100 - stats[lowest].percent,
        highestExtreme: stats[highest].z > Z_BONFERRONI,
        lowestExtreme: stats[lowest].z < -Z_BONFERRONI,
    };
}

const VOLATILITY_PATTERN = /^(?:R_(\d+)|1HZ(\d+)V)$/;

/** True for the Deriv volatility indices (R_10 ... R_100, 1HZ10V ... 1HZ100V). */
export const isVolatilitySymbol = (symbol: string | null | undefined): boolean =>
    typeof symbol === 'string' && VOLATILITY_PATTERN.test(symbol);

/** "R_100" -> "Volatility 100 Index", "1HZ100V" -> "Volatility 100 (1s) Index"; other symbols are returned as given. */
export function volatilityName(symbol: string): string {
    const match = VOLATILITY_PATTERN.exec(symbol);
    if (!match) return symbol;
    return match[1] ? `Volatility ${match[1]} Index` : `Volatility ${match[2]} (1s) Index`;
}
