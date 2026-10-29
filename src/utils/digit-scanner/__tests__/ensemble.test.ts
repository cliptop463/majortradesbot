import { describe, expect, it } from '@jest/globals';
import { analyzeDigits, rankMarkets } from '../ensemble';
import type { MarketAnalysis, StrategyResult } from '../types';

const signal = (
    id: string,
    direction: 'MATCHES' | 'DIFFERS',
    digit: number,
    strength = 0.5
): (() => StrategyResult) => () => ({
    id, name: id, status: 'signal', direction, digit, strength, reason: `${id} reason`,
});

const abstain = (id: string): (() => StrategyResult) => () => ({
    id, name: id, status: 'abstain', reason: 'No threshold crossed',
});

const analysis = (
    symbol: string,
    score: number,
    agree: number,
    observations = 300,
    direction: 'MATCHES' | 'DIFFERS' = 'MATCHES'
): MarketAnalysis => ({
    symbol,
    displayName: symbol,
    market: 'synthetic_index',
    submarket: 'random_index',
    pipSize: 2,
    observations,
    dropped: 0,
    status: 'ok',
    strategies: [],
    recommendation: {
        direction, digit: 5, agree, disagree: 0, eligible: 5, heuristicScore: score,
    },
});

describe('analyzeDigits consensus', () => {
    it('requires two votes by default, including when a direction filter is set', () => {
        const result = analyzeDigits([1, 2, 3], {
            directionFilter: 'MATCHES',
            strategies: [signal('one', 'MATCHES', 7, 1), abstain('two')],
        });
        expect(result.recommendation).toBeNull();
        expect(result.reason).toContain('2 required');
    });

    it('prioritizes vote count over a lone high-strength signal', () => {
        const result = analyzeDigits([1, 2, 3], {
            minAgree: 2,
            strategies: [
                signal('lone', 'DIFFERS', 9, 1),
                signal('vote-a', 'MATCHES', 4, 0.4),
                signal('vote-b', 'MATCHES', 4, 0.4),
            ],
        });
        expect(result.recommendation).toMatchObject({
            direction: 'MATCHES', digit: 4, agree: 2, heuristicScore: 46,
        });
    });

    it('uses deterministic direction and digit tie-breaking', () => {
        const first = analyzeDigits([1, 2, 3], {
            minAgree: 1,
            strategies: [signal('m', 'MATCHES', 5, 0.7), signal('d', 'DIFFERS', 5, 0.7)],
        });
        const reversed = analyzeDigits([1, 2, 3], {
            minAgree: 1,
            strategies: [signal('d', 'DIFFERS', 5, 0.7), signal('m', 'MATCHES', 5, 0.7)],
        });
        expect(first.recommendation).toEqual(reversed.recommendation);
        expect(first.recommendation?.direction).toBe('DIFFERS');
    });

    it('ignores malformed signals and rejects invalid digit input', () => {
        const malformed = (): StrategyResult => ({
            id: 'bad', name: 'Bad', status: 'signal', direction: 'MATCHES', digit: 12, strength: 0.8, reason: 'bad',
        });
        const result = analyzeDigits([1, 2, 3], { strategies: [malformed] });
        expect(result.recommendation).toBeNull();
        expect(analyzeDigits([1, 12]).recommendation).toBeNull();
    });

    it('computes a clearly heuristic score from consensus share and mean strength', () => {
        const result = analyzeDigits([1, 2, 3], {
            minAgree: 2,
            strategies: [
                signal('a', 'MATCHES', 5, 0.6),
                signal('b', 'MATCHES', 5, 0.8),
                signal('c', 'DIFFERS', 2, 0.4),
                abstain('d'),
            ],
        });
        // eligible = 4; agreement share = 2/4; mean strength = .7
        expect(result.recommendation?.heuristicScore).toBe(56);
    });
});

describe('rankMarkets', () => {
    it('ranks by score, agreement, observations, then symbol without direction bias', () => {
        const lowerScoreMatches = analysis('R_10', 55, 4, 500, 'MATCHES');
        const higherScoreDiffers = analysis('R_25', 80, 2, 250, 'DIFFERS');
        const tiedA = analysis('R_50', 80, 3, 300, 'MATCHES');
        const tiedB = analysis('R_100', 80, 3, 300, 'DIFFERS');
        const result = rankMarkets([lowerScoreMatches, higherScoreDiffers, tiedA, tiedB]);
        expect(result.ranked.map(x => x.analysis.symbol)).toEqual(['R_100', 'R_50', 'R_25', 'R_10']);
        expect(result.selected?.analysis.symbol).toBe('R_100');
    });

    it('is input-order independent and excludes failed/insufficient/no-consensus analyses', () => {
        const a = analysis('R_10', 70, 3);
        const b = analysis('R_25', 80, 3);
        const bad = { ...analysis('R_50', 0, 0), status: 'error' as const, recommendation: null };
        const one = rankMarkets([a, b, bad]);
        const two = rankMarkets([bad, b, a]);
        expect(one.ranked.map(x => x.analysis.symbol)).toEqual(two.ranked.map(x => x.analysis.symbol));
        expect(one.excluded.map(x => x.symbol)).toEqual(['R_50']);
        expect(one.selected?.analysis.symbol).toBe('R_25');
    });
});
