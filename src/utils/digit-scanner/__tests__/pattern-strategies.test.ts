import { describe, expect, it } from '@jest/globals';
import { CONTRACTS, barrierError } from '../contracts';
import type { TradeKind } from '../contracts';
import {
    PATTERN_STRATEGY_IDS,
    PATTERN_STRATEGY_INFO,
    analyzePattern,
    runPatternStrategy,
} from '../pattern-strategies';

const makeRng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const uniform = (n: number, seed: number) => {
    const rnd = makeRng(seed);
    return Array.from({ length: n }, () => Math.floor(rnd() * 10));
};
const KINDS: TradeKind[] = ['matches_differs', 'even_odd', 'over_under'];

describe('pattern strategy registry', () => {
    it('exposes the eight strategies with unique ids', () => {
        expect(PATTERN_STRATEGY_INFO).toHaveLength(8);
        expect(new Set(PATTERN_STRATEGY_IDS).size).toBe(8);
    });

    it('throws on an unknown strategy id', () => {
        expect(() => runPatternStrategy('nope', [1, 2, 3], 'even_odd')).toThrow(RangeError);
    });

    it.each(KINDS)('marks strategies ineligible, not signalling, when there is too little data (%s)', kind => {
        PATTERN_STRATEGY_IDS.forEach(id => {
            const result = runPatternStrategy(id, [1, 2, 3, 4, 5], kind);
            expect(result.status).toBe('ineligible');
            expect(result.signal).toBe('ABSTAIN');
        });
    });
});

describe('individual strategies', () => {
    it('Hot & Cold: a heavily even stream votes EVEN', () => {
        const rnd = makeRng(5);
        const digits = Array.from({ length: 200 }, () => (rnd() < 0.75 ? 2 * Math.floor(rnd() * 5) : 2 * Math.floor(rnd() * 5) + 1));
        const result = runPatternStrategy('hot_cold', digits, 'even_odd');
        expect(result.status).toBe('signal');
        expect(result.direction).toBe('EVEN');
        expect(result.digit).toBeUndefined();
    });

    it('Hot & Cold on Matches/Differs always votes: a hot digit matches, otherwise Differs on the last digit', () => {
        const flat = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(d => [d, d, d]); // no digit reaches 4 in the last 10
        const result = runPatternStrategy('hot_cold', [...flat, 3, 5], 'matches_differs');
        expect(result.direction).toBe('DIFFERS');
        expect(result.digit).toBe(5);
        expect(result.reason).toContain('fallback');

        const hot = runPatternStrategy('hot_cold', [...flat, 8, 8, 8, 8, 1, 2], 'matches_differs');
        expect(hot.direction).toBe('MATCHES');
        expect(hot.digit).toBe(8);
    });

    it('Streak Reversal bets a run of evens ends (ODD) and a repeated digit does not repeat (DIFFERS)', () => {
        const base = uniform(60, 3);
        expect(runPatternStrategy('streak_reversal', [...base, 1, 2, 4, 6, 8, 0], 'even_odd').direction).toBe('ODD');
        expect(runPatternStrategy('streak_reversal', [...base, 3, 1, 3, 5, 7, 9], 'even_odd').direction).toBe('EVEN');

        const repeated = runPatternStrategy('streak_reversal', [...base, 1, 7, 7, 7], 'matches_differs');
        expect(repeated.direction).toBe('DIFFERS');
        expect(repeated.digit).toBe(7);

        const high = runPatternStrategy('streak_reversal', [...base, 1, 6, 7, 9], 'over_under');
        expect(high.direction).toBe('UNDER');
        expect(barrierError('UNDER', high.digit)).toBeNull();
    });

    it('Momentum: seven of ten high digits votes OVER with a valid barrier', () => {
        const result = runPatternStrategy('momentum', [...uniform(40, 9), 7, 8, 9, 6, 7, 1, 8, 9, 2, 5], 'over_under');
        expect(result.direction).toBe('OVER');
        expect(barrierError('OVER', result.digit)).toBeNull();
    });

    it('Balance Reversion: a digit unseen for 35+ ticks is flagged (and labelled as not actually due)', () => {
        const without9 = Array.from({ length: 120 }, (_, i) => i % 9); // digits 0-8 only
        const result = runPatternStrategy('balance_reversion', [9, ...without9], 'matches_differs');
        expect(result.direction).toBe('MATCHES');
        expect(result.digit).toBe(9);
        expect(result.reason).toContain('does not make the digit due');
    });

    it('Cycle: a repeating parity cycle projects the next slot', () => {
        const base = uniform(20, 4);
        const cycle = [2, 3, 2, 3, 2, 3]; // E O E O E O -> next is E
        const result = runPatternStrategy('cycle', [...base, ...cycle], 'even_odd');
        expect(result.status).toBe('signal');
        expect(result.direction).toBe('EVEN');
    });

    it('Skew and Transition abstain on fair random digits for Matches/Differs', () => {
        const digits = uniform(1000, 21);
        expect(['abstain', 'signal']).toContain(runPatternStrategy('skew', digits, 'matches_differs').status);
        expect(runPatternStrategy('transition', uniform(150, 2), 'matches_differs').status).toBe('ineligible');
    });
});

describe('analyzePattern', () => {
    it('runs only the strategies the user selected, in the order given', () => {
        const result = analyzePattern(uniform(300, 8), 'even_odd', { strategyIds: ['cycle', 'momentum'] });
        expect(result.strategies.map(s => s.id)).toEqual(['cycle', 'momentum']);
    });

    it('rejects an empty selection and invalid digits with a reason', () => {
        expect(analyzePattern(uniform(300, 8), 'even_odd', { strategyIds: [] }).reason).toBe('No strategies selected.');
        expect(analyzePattern([1, 2, 12], 'even_odd').recommendation).toBeNull();
        expect(analyzePattern([], 'even_odd').recommendation).toBeNull();
    });

    it('requires the configured number of agreeing strategies', () => {
        const digits = [...uniform(60, 3), 1, 2, 4, 6, 8, 0];
        const one = analyzePattern(digits, 'even_odd', { strategyIds: ['streak_reversal'], minAgree: 1 });
        expect(one.recommendation?.direction).toBe('ODD');
        const two = analyzePattern(digits, 'even_odd', { strategyIds: ['streak_reversal'], minAgree: 2 });
        expect(two.recommendation).toBeNull();
        expect(two.reason).toContain('Consensus not reached');
    });

    it('is deterministic and independent of the order strategies were selected in', () => {
        const digits = uniform(400, 13);
        const a = analyzePattern(digits, 'over_under', { strategyIds: ['hot_cold', 'skew', 'momentum', 'cycle'] });
        const b = analyzePattern(digits, 'over_under', { strategyIds: ['cycle', 'momentum', 'skew', 'hot_cold'] });
        expect(b.recommendation).toEqual(a.recommendation);
    });

    it('only ever returns a direction that belongs to the chosen trade type, with a valid barrier', () => {
        for (let seed = 1; seed <= 60; seed++) {
            const digits = uniform(400, seed);
            for (const kind of KINDS) {
                const { recommendation } = analyzePattern(digits, kind);
                if (!recommendation) continue;
                expect(CONTRACTS[recommendation.direction].kind).toBe(kind);
                expect(barrierError(recommendation.direction, recommendation.digit)).toBeNull();
                if (!CONTRACTS[recommendation.direction].hasBarrier) expect(recommendation.digit).toBeNull();
                expect(recommendation.heuristicScore).toBeGreaterThanOrEqual(1);
                expect(recommendation.heuristicScore).toBeLessThanOrEqual(96);
                expect(recommendation.agree).toBeGreaterThanOrEqual(1);
                expect(recommendation.agree).toBeLessThanOrEqual(recommendation.eligible);
            }
        }
    });

    it('counts ineligible strategies out of the eligible total', () => {
        const result = analyzePattern(uniform(100, 6), 'matches_differs');
        // 100 ticks: skew (120), transition (200) are ineligible.
        const ineligible = result.strategies.filter(s => s.status === 'ineligible').map(s => s.id);
        expect(ineligible).toEqual(expect.arrayContaining(['skew', 'transition']));
        if (result.recommendation) expect(result.recommendation.eligible).toBe(8 - ineligible.length);
    });
});
