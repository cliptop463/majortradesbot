import { analyzeDigits } from './ensemble';
import type { AnalyzeDigitsOptions } from './ensemble';

export interface BacktestOptions extends AnalyzeDigitsOptions {
    /** Ticks of history shown to the ensemble at each step (default 500). */
    window?: number;
    /** Ticks to advance between evaluations (default 25). */
    step?: number;
}

export interface BacktestSide {
    signals: number;
    hits: number;
}

export interface BacktestResult {
    windows: number;
    signals: number;
    matches: BacktestSide;
    differs: BacktestSide;
    hitRate: number | null;
    /** Hit rate expected if the digits were fair and independent: 10% for Matches, 90% for Differs. */
    baselineHitRate: number | null;
    /** (hits - expected) / standard deviation. Overlapping windows are correlated, so treat as indicative only. */
    zScore: number | null;
    verdict: 'insufficient_data' | 'no_signals' | 'no_evidence_of_edge' | 'above_baseline' | 'below_baseline';
}

/**
 * Walk-forward check of the ensemble: at each step the ensemble sees only past ticks and its
 * MATCHES/DIFFERS pick is scored against the NEXT tick. Compares the hit rate with what a fair
 * random digit would give. This measures this sample only; it cannot prove future performance.
 */
export function backtestDigits(digits: readonly number[], options?: BacktestOptions): BacktestResult {
    const window = Math.max(50, Math.floor(options?.window ?? 500));
    const step = Math.max(1, Math.floor(options?.step ?? 25));
    const empty: BacktestResult = {
        windows: 0, signals: 0,
        matches: { signals: 0, hits: 0 }, differs: { signals: 0, hits: 0 },
        hitRate: null, baselineHitRate: null, zScore: null, verdict: 'insufficient_data',
    };
    if (digits.length <= window) return empty;

    const matches: BacktestSide = { signals: 0, hits: 0 };
    const differs: BacktestSide = { signals: 0, hits: 0 };
    let windows = 0;

    for (let t = window; t < digits.length; t += step) {
        windows++;
        const { recommendation } = analyzeDigits(digits.slice(t - window, t), options);
        if (!recommendation) continue;
        const next = digits[t];
        if (recommendation.direction === 'MATCHES') {
            matches.signals++;
            if (next === recommendation.digit) matches.hits++;
        } else {
            differs.signals++;
            if (next !== recommendation.digit) differs.hits++;
        }
    }

    const signals = matches.signals + differs.signals;
    if (signals === 0) return { ...empty, windows, verdict: 'no_signals' };

    const hits = matches.hits + differs.hits;
    const expected = matches.signals * 0.1 + differs.signals * 0.9;
    const sd = Math.sqrt(signals * 0.09);
    const zScore = (hits - expected) / sd;
    const verdict = zScore >= 2 ? 'above_baseline' : zScore <= -2 ? 'below_baseline' : 'no_evidence_of_edge';

    return {
        windows, signals, matches, differs,
        hitRate: hits / signals,
        baselineHitRate: expected / signals,
        zScore,
        verdict,
    };
}
