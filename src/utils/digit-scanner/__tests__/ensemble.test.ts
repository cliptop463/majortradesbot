import { describe, expect, it } from '@jest/globals';
import { analyzeDigits, rankMarkets } from '../ensemble';
import { decideFromZ } from '../strategies';
import type { MarketAnalysis, StrategyResult } from '../types';

describe('analyzeDigits', () => {
    it('returns no recommendation when no strategies are eligible', () => {
        const stubIneligible = (): StrategyResult => ({
            id: 'stub',
            name: 'Stub',
            status: 'ineligible',
            reason: 'Too few ticks',
        });
        const result = analyzeDigits([1, 2, 3], { strategies: [stubIneligible] });
        expect(result.recommendation).toBeNull();
        expect(result.reason).toBe('No eligible strategies.');
    });

    it('returns no recommendation when no strategy produces a signal', () => {
        const stubAbstain = (): StrategyResult => ({
            id: 'stub',
            name: 'Stub',
            status: 'abstain',
            reason: 'No trigger',
        });
        const result = analyzeDigits([1, 2, 3], { strategies: [stubAbstain] });
        expect(result.recommendation).toBeNull();
        expect(result.reason).toBe('No strategy produced a signal.');
    });

    it('returns no consensus when winning vote is below minAgree', () => {
        const s1 = (): StrategyResult => ({
            id: 's1',
            name: 'S1',
            status: 'signal',
            direction: 'MATCHES',
            digit: 7,
            strength: 0.8,
            reason: 'r1',
        });
        const s2 = (): StrategyResult => ({
            id: 's2',
            name: 'S2',
            status: 'abstain',
            reason: 'r2',
        });

        const result = analyzeDigits([1, 2, 3], { minAgree: 2, strategies: [s1, s2] });
        expect(result.recommendation).toBeNull();
        expect(result.reason).toMatch(/Consensus not reached: winner has 1 vote\(s\), minimum required is 2/);
    });

    it('computes heuristic score correctly with stub strategies', () => {
        const s1 = (): StrategyResult => ({
            id: 's1',
            name: 'S1',
            status: 'signal',
            direction: 'MATCHES',
            digit: 5,
            strength: 0.6,
            reason: 'r1',
        });
        const s2 = (): StrategyResult => ({
            id: 's2',
            name: 'S2',
            status: 'signal',
            direction: 'MATCHES',
            digit: 5,
            strength: 0.8,
            reason: 'r2',
        });
        const s3 = (): StrategyResult => ({
            id: 's3',
            name: 'S3',
            status: 'signal',
            direction: 'DIFFERS',
            digit: 2,
            strength: 0.4,
            reason: 'r3',
        });
        const s4 = (): StrategyResult => ({
            id: 's4',
            name: 'S4',
            status: 'abstain',
            reason: 'r4',
        });

        const result = analyzeDigits([1, 2, 3], { minAgree: 2, strategies: [s1, s2, s3, s4] });
        expect(result.recommendation).not.toBeNull();
        expect(result.recommendation?.direction).toBe('MATCHES');
        expect(result.recommendation?.digit).toBe(5);
        expect(result.recommendation?.agree).toBe(2);
        expect(result.recommendation?.disagree).toBe(1);
        expect(result.recommendation?.eligible).toBe(4);
        expect(result.recommendation?.heuristicScore).toBe(35);
    });

    describe('tie-breaking order', () => {
        it('tie-break step 1: higher summed strength beats lower summed strength', () => {
            const s1 = (): StrategyResult => ({ id: '1', name: '1', status: 'signal', direction: 'MATCHES', digit: 3, strength: 0.9, reason: '' });
            const s2 = (): StrategyResult => ({ id: '2', name: '2', status: 'signal', direction: 'DIFFERS', digit: 4, strength: 0.4, reason: '' });
            const s3 = (): StrategyResult => ({ id: '3', name: '3', status: 'signal', direction: 'DIFFERS', digit: 4, strength: 0.4, reason: '' });

            const res = analyzeDigits([1, 2], { minAgree: 1, strategies: [s1, s2, s3] });
            expect(res.recommendation?.direction).toBe('MATCHES');
            expect(res.recommendation?.digit).toBe(3);
        });

        it('tie-break step 2: more votes beats fewer votes when strength is tied', () => {
            const sA1 = (): StrategyResult => ({ id: '1', name: '1', status: 'signal', direction: 'MATCHES', digit: 8, strength: 0.5, reason: '' });
            const sA2 = (): StrategyResult => ({ id: '2', name: '2', status: 'signal', direction: 'MATCHES', digit: 8, strength: 0.5, reason: '' });
            const sB1 = (): StrategyResult => ({ id: '3', name: '3', status: 'signal', direction: 'DIFFERS', digit: 2, strength: 1.0, reason: '' });

            const res = analyzeDigits([1, 2], { minAgree: 1, strategies: [sB1, sA1, sA2] });
            expect(res.recommendation?.direction).toBe('MATCHES');
            expect(res.recommendation?.digit).toBe(8);
            expect(res.recommendation?.agree).toBe(2);
        });

        it('tie-break step 3: MATCHES beats DIFFERS when strength and votes are tied', () => {
            const sM = (): StrategyResult => ({ id: '1', name: '1', status: 'signal', direction: 'MATCHES', digit: 5, strength: 0.7, reason: '' });
            const sD = (): StrategyResult => ({ id: '2', name: '2', status: 'signal', direction: 'DIFFERS', digit: 5, strength: 0.7, reason: '' });

            const res1 = analyzeDigits([1, 2], { minAgree: 1, strategies: [sM, sD] });
            expect(res1.recommendation?.direction).toBe('MATCHES');

            const res2 = analyzeDigits([1, 2], { minAgree: 1, strategies: [sD, sM] });
            expect(res2.recommendation?.direction).toBe('MATCHES');
        });

        it('tie-break step 4: lower digit wins when strength, votes, and direction are tied', () => {
            const s9 = (): StrategyResult => ({ id: '1', name: '1', status: 'signal', direction: 'DIFFERS', digit: 9, strength: 0.7, reason: '' });
            const s2 = (): StrategyResult => ({ id: '2', name: '2', status: 'signal', direction: 'DIFFERS', digit: 2, strength: 0.7, reason: '' });

            const res = analyzeDigits([1, 2], { minAgree: 1, strategies: [s9, s2] });
            expect(res.recommendation?.digit).toBe(2);
        });

        it('prefers MATCHES when a strategy has equally strong MATCHES and DIFFERS signals', () => {
            const zScores = new Array(10).fill(0);
            zScores[2] = 4;
            zScores[8] = -3;

            expect(decideFromZ(zScores)).toMatchObject({ direction: 'MATCHES', digit: 2 });
        });
    });
});

describe('rankMarkets', () => {
    function makeAnalysis(
        symbol: string,
        score: number,
        agree: number,
        eligible: number,
        status: 'ok' | 'no_consensus' | 'insufficient_data' | 'error' = 'ok'
    ): MarketAnalysis {
        return {
            symbol,
            displayName: symbol,
            market: 'synthetic_index',
            submarket: 'random_index',
            pipSize: 2,
            observations: 300,
            dropped: 0,
            status,
            strategies: [],
            recommendation:
                status === 'ok'
                    ? {
                          direction: 'MATCHES',
                          digit: 5,
                          agree,
                          disagree: 0,
                          eligible,
                          heuristicScore: score,
                      }
                    : null,
        };
    }

    it('ranks by score desc, agree desc, eligible desc, and plain string symbol ascending', () => {
        const m1 = makeAnalysis('R_100', 80, 4, 8);
        const m2 = makeAnalysis('R_50', 80, 4, 8);
        const m3 = makeAnalysis('1HZ10V', 80, 4, 8);
        const m4 = makeAnalysis('1HZ100V', 80, 4, 8);
        const mLowerScore = makeAnalysis('R_25', 60, 5, 8);

        const ranking = rankMarkets([mLowerScore, m2, m1, m3, m4]);

        expect(ranking.ranked.map((r) => r.analysis.symbol)).toEqual([
            '1HZ100V',
            '1HZ10V',
            'R_100',
            'R_50',
            'R_25',
        ]);

        expect(ranking.selected?.analysis.symbol).toBe('1HZ100V');
        expect(ranking.selected?.rank).toBe(1);
        expect(ranking.excluded).toEqual([]);
    });

    it('is deterministic under input permutation', () => {
        const a = makeAnalysis('R_10', 50, 2, 8);
        const b = makeAnalysis('R_25', 70, 3, 8);
        const c = makeAnalysis('R_50', 90, 4, 8);

        const rank1 = rankMarkets([a, b, c]);
        const rank2 = rankMarkets([c, a, b]);

        expect(rank1.ranked.map((r) => r.analysis.symbol)).toEqual(
            rank2.ranked.map((r) => r.analysis.symbol)
        );
    });

    it('keeps excluded markets in their original input order and sets selected to null when none qualify', () => {
        const err = makeAnalysis('R_10', 0, 0, 0, 'error');
        const insuff = makeAnalysis('R_25', 0, 0, 0, 'insufficient_data');
        const noCons = makeAnalysis('R_50', 0, 0, 0, 'no_consensus');

        const result = rankMarkets([err, insuff, noCons]);
        expect(result.ranked).toEqual([]);
        expect(result.selected).toBeNull();
        expect(result.excluded.map((e) => e.symbol)).toEqual(['R_10', 'R_25', 'R_50']);
    });

    it('prioritizes MATCHES recommendations over DIFFERS recommendations', () => {
        const diffMarket = makeAnalysis('R_100', 95, 5, 8);
        diffMarket.recommendation = {
            direction: 'DIFFERS',
            digit: 3,
            agree: 5,
            disagree: 0,
            eligible: 8,
            heuristicScore: 95,
        };

        const matchMarket = makeAnalysis('R_50', 60, 2, 8);
        matchMarket.recommendation = {
            direction: 'MATCHES',
            digit: 7,
            agree: 2,
            disagree: 1,
            eligible: 8,
            heuristicScore: 60,
        };

        const result = rankMarkets([diffMarket, matchMarket]);
        expect(result.ranked[0].recommendation.direction).toBe('MATCHES');
        expect(result.ranked[0].analysis.symbol).toBe('R_50');
        expect(result.ranked[1].recommendation.direction).toBe('DIFFERS');
        expect(result.ranked[1].analysis.symbol).toBe('R_100');
    });
});
