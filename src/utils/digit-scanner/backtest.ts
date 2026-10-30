import { fairWinRate, isWin } from './contracts';
import { analyzeDigits } from './ensemble';
import type { AnalyzeDigitsOptions } from './ensemble';
import type { Direction, EnsembleResult } from './types';

export interface BacktestOptions extends AnalyzeDigitsOptions {
    /** Ticks of history shown to the analyzer at each step (default 500). */
    window?: number;
    /** Ticks to advance between evaluations (default 25). */
    step?: number;
    /** Replaces the default ensemble, e.g. analyzePattern for Even/Odd or Over/Under. */
    analyze?: (digits: readonly number[]) => EnsembleResult;
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
    /** Per-direction tallies for every contract type that signalled. */
    sides: Partial<Record<Direction, BacktestSide>>;
    hitRate: number | null;
    /** Hit rate expected if digits were fair and independent (depends on the contract and barrier). */
    baselineHitRate: number | null;
    /** (hits - expected) / standard deviation. Overlapping windows are correlated, so treat as indicative only. */
    zScore: number | null;
    verdict: 'insufficient_data' | 'no_signals' | 'no_evidence_of_edge' | 'above_baseline' | 'below_baseline';
}

/**
 * Walk-forward check: at each step the analyzer sees only past ticks and its pick is scored against
 * the NEXT tick. The hit rate is compared with what fair random digits would give for that exact
 * contract (for example 10% for Matches, 50% for Even, 70% for Under 7). This measures this sample
 * only; it cannot prove future performance.
 */
export function backtestDigits(digits: readonly number[], options?: BacktestOptions): BacktestResult {
    const window = Math.max(50, Math.floor(options?.window ?? 500));
    const step = Math.max(1, Math.floor(options?.step ?? 25));
    const empty: BacktestResult = {
        windows: 0,
        signals: 0,
        matches: { signals: 0, hits: 0 },
        differs: { signals: 0, hits: 0 },
        sides: {},
        hitRate: null,
        baselineHitRate: null,
        zScore: null,
        verdict: 'insufficient_data',
    };
    if (digits.length <= window) return empty;

    const sides: Partial<Record<Direction, BacktestSide>> = {};
    let windows = 0;
    let signals = 0;
    let hits = 0;
    let expected = 0;
    let variance = 0;

    for (let t = window; t < digits.length; t += step) {
        windows++;
        const past = digits.slice(t - window, t);
        const { recommendation } = options?.analyze ? options.analyze(past) : analyzeDigits(past, options);
        if (!recommendation) continue;

        const p = fairWinRate(recommendation.direction, recommendation.digit);
        const won = isWin(recommendation.direction, recommendation.digit, digits[t]);
        const side = (sides[recommendation.direction] ??= { signals: 0, hits: 0 });
        side.signals++;
        if (won) {
            side.hits++;
            hits++;
        }
        signals++;
        expected += p;
        variance += p * (1 - p);
    }

    const matches = sides.MATCHES ?? { signals: 0, hits: 0 };
    const differs = sides.DIFFERS ?? { signals: 0, hits: 0 };
    if (signals === 0) return { ...empty, windows, verdict: 'no_signals' };

    const zScore = variance > 0 ? (hits - expected) / Math.sqrt(variance) : 0;
    const verdict = zScore >= 2 ? 'above_baseline' : zScore <= -2 ? 'below_baseline' : 'no_evidence_of_edge';

    return {
        windows,
        signals,
        matches,
        differs,
        sides,
        hitRate: hits / signals,
        baselineHitRate: expected / signals,
        zScore,
        verdict,
    };
}
