import { describe, expect, it } from '@jest/globals';
import {
    MIN_MARKET_SCORE, REVERSAL_PENALTY_PER_MOVE, bestQualifiedMarket, calculateDirectionalMetrics,
    isFreshQualifiedSignal, partitionWalkForwardSamples, rankMarkets, scoreMarket,
} from '../market-scanner';
import type { MarketTick } from '../types';

const walk = (moves: readonly number[], start = 1000) => moves.reduce<number[]>((prices, move) => [...prices, prices[prices.length - 1] + move], [start]);
const steady = (n: number, move = 1) => walk(Array(n - 1).fill(move));
const ticksFromParity = (parities: readonly number[], pipSize: number | null = 1): MarketTick[] => parities.map((parity, sequence) => ({ quote: 100 + (parity ? 0.1 : 0.2), pipSize, sequence }));
const irregularWalk = (n: number) => walk(Array.from({ length: n - 1 }, (_, i) => i % 11 < 6 ? 1 : -0.5));

describe('original-index walk-forward validation', () => {
    it('partitions before target construction and keeps every target inside its own tick partition', () => {
        const n = 1000;
        const samples = partitionWalkForwardSamples(n, end => end % 2 as 0 | 1, { featureLookback: 60, horizon: 5, embargo: 5 });
        for (const row of samples.train) expect(row.targetEnd).toBeLessThan(samples.trainTickEnd);
        for (const row of samples.validation) {
            expect(row.featureEnd).toBeGreaterThanOrEqual(samples.trainTickEnd + 5);
            expect(row.targetEnd).toBeLessThan(samples.validationTickEnd);
        }
        for (const row of samples.outOfSample) {
            expect(row.featureEnd).toBeGreaterThanOrEqual(samples.validationTickEnd + 5);
            expect(row.targetEnd).toBeLessThan(n);
        }
    });

    it('does not bridge a boundary with any future target window', () => {
        const result = partitionWalkForwardSamples(400, () => 1, { featureLookback: 60, horizon: 5, embargo: 5 });
        expect(result.train.some(row => row.targetEnd >= result.trainTickEnd)).toBe(false);
        expect(result.validation.some(row => row.targetEnd >= result.validationTickEnd)).toBe(false);
    });
});

describe('reversal-sensitive directional metrics', () => {
    it('requires five strict upward or downward changes; flat and opposing moves reset streaks', () => {
        expect(calculateDirectionalMetrics(steady(70))?.currentUpStreak).toBe(69);
        expect(calculateDirectionalMetrics(steady(70, -1))?.currentDownStreak).toBe(69);
        const base = steady(70);
        base.push(base[base.length - 1], base[base.length - 1] - 1);
        expect(calculateDirectionalMetrics(base)?.currentUpStreak).toBe(0);
    });

    it('detects an immediate reversal and applies opposing-movement decay monotonically', () => {
        const up = steady(100);
        const oneOpposing = [...up, up[up.length - 1] - 1];
        const twoOpposing = [...oneOpposing, oneOpposing[oneOpposing.length - 1] - 1];
        const a = calculateDirectionalMetrics(up)!;
        const b = calculateDirectionalMetrics(oneOpposing)!;
        const c = calculateDirectionalMetrics(twoOpposing)!;
        expect(b.currentUpStreak).toBe(0);
        expect(c.currentDownStreak).toBe(2);
        expect(c.confirmedReversal).toBe(true);
        expect(c.upScore).toBeLessThanOrEqual(b.upScore);
        expect(b.upScore).toBeLessThanOrEqual(a.upScore);
        expect(REVERSAL_PENALTY_PER_MOVE).toBeGreaterThan(0);
    });

    it('gives choppy alternating paths poor efficiency and frequent reversals', () => {
        const metrics = calculateDirectionalMetrics(walk(Array.from({ length: 100 }, (_, i) => i % 2 ? -1 : 1)))!;
        expect(metrics.directionalEfficiency).toBeLessThan(0.1);
        expect(metrics.reversalCounts[20]).toBeGreaterThan(15);
        expect(metrics.currentUpStreak + metrics.currentDownStreak).toBeLessThan(2);
    });

    it('flags an isolated spike as unstable/excessive rather than stable suitable volatility', () => {
        const prices = steady(120);
        prices[100] = prices[99] * 1.05;
        prices[101] = prices[100] / 1.05;
        expect(calculateDirectionalMetrics(prices)?.volatilityRegime).toBe('excessive');
    });
});

describe('strategy-specific scoring and validation', () => {
    it('keeps V3 and V4 as strict selected-tick-five TICKHIGH contracts', () => {
        for (const strategy of ['tick-striker', 'tick-striker-v4'] as const) {
            const result = scoreMarket('R_100', strategy, irregularWalk(1200));
            expect(result.contract).toEqual({ contract_type: 'TICKHIGH', duration: 5, duration_unit: 't', selected_tick: 5 });
        }
    });

    it('locks parity from train only and evaluates that chosen parity on later validation and OOS ticks', () => {
        const parities = Array.from({ length: 1200 }, (_, i) => i < 720 ? 0 : 1);
        const prices = steady(parities.length);
        const result = scoreMarket('R_50', 'nexus-even-odd', prices, ticksFromParity(parities));
        expect(result.direction).toBe('EVEN');
        expect(result.contract?.contract_type).toBe('DIGITEVEN');
        expect(result.validation.outOfSampleRate).toBe(0);
        expect(result.qualified).toBe(false);
    });

    it('rejects invalid quote, missing or out-of-range precision and insufficient history', () => {
        const p = steady(120);
        expect(scoreMarket('bad', 'nexus-even-odd', p, ticksFromParity(Array(120).fill(0), null)).qualified).toBe(false);
        expect(scoreMarket('bad', 'nexus-even-odd', p, ticksFromParity(Array(120).fill(0)).map(t => ({ ...t, pipSize: 13 }))).qualified).toBe(false);
        expect(scoreMarket('bad', 'tick-striker', [1, NaN]).score).toBeNull();
    });

    it('requires a current uninterrupted five-move streak and rejects stale or invalidated signals', () => {
        const recentReversal = [...irregularWalk(1200), ...Array.from({ length: 8 }, (_, i) => 3000 - i)];
        const result = scoreMarket('R_25', 'nexus-rise-fall', recentReversal);
        expect(result.qualified).toBe(false);
        expect(result.direction).toBe('DOWN');
        expect(result.contract?.contract_type).toBe('PUT');
        expect(isFreshQualifiedSignal({ ...result, qualified: true, score: MIN_MARKET_SCORE, evaluatedAtTick: 100 }, 101)).toBe(true);
        expect(isFreshQualifiedSignal({ ...result, qualified: true, score: MIN_MARKET_SCORE, evaluatedAtTick: 100 }, 102)).toBe(false);
        expect(isFreshQualifiedSignal({ ...result, qualified: false, score: 1 }, 100)).toBe(false);
    });

    it('never promotes an unqualified fallback and deterministically breaks ties by symbol', () => {
        const a = scoreMarket('R_25', 'tick-striker', irregularWalk(500));
        const b = scoreMarket('R_10', 'tick-striker', irregularWalk(500));
        expect(bestQualifiedMarket([a, b])).toBeNull();
        expect(rankMarkets([a, b]).map(item => item.symbol)).toEqual(['R_10', 'R_25']);
        expect(MIN_MARKET_SCORE).toBe(0.73);
    });
});
