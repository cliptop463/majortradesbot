import { describe, expect, it } from '@jest/globals';
import { MIN_MARKET_SCORE, bestQualifiedMarket, calculateDirectionalMetrics, rankMarkets, scoreMarket } from '../market-scanner';
import type { MarketTick } from '../types';

const walk = (moves: readonly number[], start = 100) => moves.reduce<number[]>((prices, move) => [...prices, prices[prices.length - 1] + move], [start]);
const steady = (n: number, move = 1) => walk(Array(n - 1).fill(move));
const ticks = (digits: readonly number[], pipSize: number | null = 1): MarketTick[] => digits.map((digit, sequence) => ({ quote: 100 + digit / 10, pipSize, sequence }));

describe('five-movement scanner core', () => {
    it('tracks five consecutive upward and downward movements independently', () => {
        expect(calculateDirectionalMetrics(steady(70))?.currentUpStreak).toBe(69);
        expect(calculateDirectionalMetrics(steady(70, -1))?.currentDownStreak).toBe(69);
    });

    it('resets the streak immediately on an opposing movement and counts reversals', () => {
        const metrics = calculateDirectionalMetrics(steady(66).concat(165, 164));
        expect(metrics?.currentUpStreak).toBe(0);
        expect(metrics?.currentDownStreak).toBe(2);
        expect(metrics?.reversalCounts[5]).toBeGreaterThan(0);
    });

    it('classifies alternating paths as inefficient and counts successive reversals', () => {
        const prices = walk(Array.from({ length: 80 }, (_, i) => i % 2 ? -1 : 1), 1000);
        const metrics = calculateDirectionalMetrics(prices);
        expect(metrics?.directionalEfficiency).toBeLessThan(0.1);
        expect(metrics?.reversalCounts[20]).toBeGreaterThan(15);
    });

    it('rejects high-volatility inconsistent moves and insufficient or invalid data', () => {
        const noisy = walk(Array.from({ length: 80 }, (_, i) => i % 2 ? -5 : 5), 1000);
        const result = scoreMarket('R_10', 'nexus-rise-fall', noisy);
        expect(result.qualified).toBe(false);
        expect(calculateDirectionalMetrics([1, 2])).toBeNull();
        expect(scoreMarket('bad', 'nexus-rise-fall', [1, NaN]).score).toBeNull();
    });

    it('keeps Tick Striker contract semantics and gates on chronological TICKHIGH evidence', () => {
        for (const strategy of ['tick-striker', 'tick-striker-v4'] as const) {
            const result = scoreMarket('R_100', strategy, steady(500));
            expect(result.contract).toEqual({ contract_type: 'TICKHIGH', duration: 5, duration_unit: 't', selected_tick: 5 });
            expect(result.qualified).toBe(false); // monotonic rising prices do not establish this outcome's OOS edge
        }
    });

    it('selects Even/Odd contracts from exact pip precision and rejects missing precision', () => {
        const sequence = Array.from({ length: 200 }, (_, i) => i % 2 ? 1 : 2);
        const valid = scoreMarket('R_50', 'nexus-even-odd', steady(200), ticks(sequence));
        expect(valid.contract?.contract_type).toBe('DIGITEVEN');
        const invalid = scoreMarket('R_50', 'nexus-even-odd', steady(200), ticks(sequence, null));
        expect(invalid.qualified).toBe(false);
        expect(invalid.rejectionReason).toContain('pip_size');
    });

    it('does not claim qualification from a high score when validation fails', () => {
        const data = scoreMarket('R_25', 'nexus-rise-fall', steady(100));
        expect(data.qualified).toBe(false);
        expect(data.score === null || data.score < 1).toBe(true);
        expect(MIN_MARKET_SCORE).toBe(0.73);
    });
});

describe('ranking', () => {
    it('ranks deterministically and never returns an unqualified fallback', () => {
        const results = [
            scoreMarket('R_25', 'tick-striker', steady(120)),
            scoreMarket('R_10', 'tick-striker', steady(120)),
        ];
        expect(rankMarkets(results).map(result => result.symbol)).toEqual(['R_10', 'R_25']);
        expect(bestQualifiedMarket(results)).toBeNull();
    });
});
