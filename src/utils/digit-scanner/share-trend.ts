/**
 * Share-trend analysis: how each digit's share of recent ticks is changing.
 *
 * Hypothesis under test (from the user's observation): digits whose share has been RISING
 * (for example 9.4% to 10.5%) are more likely to show up in the next ticks than digits that
 * already sit high (11% or more). On fair, independent digits both groups appear at the same rate,
 * so this module both builds a strategy from the idea and provides the test that checks it.
 */

export interface ShareTrendParams {
    /** Ticks in each share window (default 300). */
    window?: number;
    /** How many ticks earlier the comparison window ends (default 50). */
    shift?: number;
    /** Minimum share increase, as a fraction (0.01 = 1 percentage point). */
    minGrowth?: number;
    /** Share at or above which a digit counts as "high" (default 0.11). */
    highShare?: number;
}

export const SHARE_TREND_DEFAULTS = { window: 300, shift: 50, minGrowth: 0.01, highShare: 0.11 } as const;

export interface DigitTrend {
    digit: number;
    /** Share of the last `window` ticks. */
    now: number;
    /** Share of the `window` ticks ending `shift` ticks earlier. */
    prev: number;
    growth: number;
}

const resolve = (params?: ShareTrendParams) => ({ ...SHARE_TREND_DEFAULTS, ...params });

const sharesOf = (digits: readonly number[]) => {
    const counts = new Array(10).fill(0);
    digits.forEach(d => counts[d]++);
    return counts.map(c => (digits.length ? c / digits.length : 0));
};

/** Per-digit trend, or null when there are not enough ticks (needs window + shift). */
export function digitShareTrends(digits: readonly number[], params?: ShareTrendParams): DigitTrend[] | null {
    const { window, shift } = resolve(params);
    if (digits.length < window + shift) return null;
    const end = digits.length;
    const now = sharesOf(digits.slice(end - window, end));
    const prev = sharesOf(digits.slice(end - window - shift, end - shift));
    return now.map((share, digit) => ({ digit, now: share, prev: prev[digit], growth: share - prev[digit] }));
}

export interface ClassifiedTrends {
    /** Share grew by at least minGrowth and is still below highShare. Biggest growth first. */
    rising: DigitTrend[];
    /** Share is at or above highShare. Highest share first. */
    high: DigitTrend[];
}

export function classifyTrends(trends: readonly DigitTrend[], params?: ShareTrendParams): ClassifiedTrends {
    const { minGrowth, highShare } = resolve(params);
    const rising = trends
        .filter(t => t.growth >= minGrowth && t.now < highShare)
        .sort((a, b) => b.growth - a.growth || a.digit - b.digit);
    const high = trends.filter(t => t.now >= highShare).sort((a, b) => b.now - a.now || a.digit - b.digit);
    return { rising, high };
}

// ───────────────────────── the test of the claim ─────────────────────────

export interface GroupTally {
    /** Digit-events observed. */
    n: number;
    /** Times the digit appeared at least once in the next `horizon` ticks. */
    appeared: number;
    /** Times the digit was exactly the tick at `horizon` (what a Matches contract of that length pays on). */
    exact: number;
}

export interface ShareTrendStudy {
    horizon: number;
    rising: GroupTally;
    high: GroupTally;
    /** Fair-digit chance a given digit appears at least once in `horizon` ticks: 1 - 0.9^horizon. */
    baselineAppear: number;
    /** Fair-digit chance a given digit is the tick at `horizon`: 0.1. */
    baselineExact: number;
}

export interface ShareTrendStudyOptions extends ShareTrendParams {
    /** Ticks ahead to look (default 10). */
    horizon?: number;
    /** Ticks between evaluation points (default = horizon, so outcome windows do not overlap). */
    step?: number;
}

const emptyTally = (): GroupTally => ({ n: 0, appeared: 0, exact: 0 });

export const emptyStudy = (horizon = 10): ShareTrendStudy => ({
    horizon,
    rising: emptyTally(),
    high: emptyTally(),
    baselineAppear: 1 - Math.pow(0.9, horizon),
    baselineExact: 0.1,
});

/**
 * Walks through history. At each point it uses only PAST ticks to classify digits as rising or high,
 * then scores each digit against the NEXT `horizon` ticks. Digits of one point share the same future
 * ticks, so events are correlated; treat the z-scores as indicative only.
 */
export function shareTrendStudy(digits: readonly number[], options?: ShareTrendStudyOptions): ShareTrendStudy {
    const horizon = Math.max(1, Math.floor(options?.horizon ?? 10));
    const params = resolve(options);
    const step = Math.max(1, Math.floor(options?.step ?? horizon));
    const study = emptyStudy(horizon);
    const first = params.window + params.shift;

    for (let t = first; t + horizon <= digits.length; t += step) {
        const trends = digitShareTrends(digits.slice(0, t), params);
        if (!trends) continue;
        const { rising, high } = classifyTrends(trends, params);
        const future = digits.slice(t, t + horizon);
        const score = (group: DigitTrend[], tally: GroupTally) => {
            for (const trend of group) {
                tally.n++;
                if (future.includes(trend.digit)) tally.appeared++;
                if (future[horizon - 1] === trend.digit) tally.exact++;
            }
        };
        score(rising, study.rising);
        score(high, study.high);
    }
    return study;
}

export function mergeStudies(studies: readonly ShareTrendStudy[]): ShareTrendStudy {
    const merged = emptyStudy(studies[0]?.horizon ?? 10);
    for (const s of studies) {
        for (const group of ['rising', 'high'] as const) {
            merged[group].n += s[group].n;
            merged[group].appeared += s[group].appeared;
            merged[group].exact += s[group].exact;
        }
    }
    return merged;
}

/** z-score of an observed count against a fair-digit probability. */
export const zForRate = (hits: number, n: number, p: number) =>
    n > 0 ? (hits - n * p) / Math.sqrt(n * p * (1 - p)) : 0;

export type StudyVerdict = 'insufficient_data' | 'no_evidence' | 'rising_above_baseline' | 'rising_below_baseline';

export function studyVerdict(study: ShareTrendStudy): StudyVerdict {
    if (study.rising.n < 200) return 'insufficient_data';
    const z = zForRate(study.rising.appeared, study.rising.n, study.baselineAppear);
    if (z >= 2) return 'rising_above_baseline';
    if (z <= -2) return 'rising_below_baseline';
    return 'no_evidence';
}
