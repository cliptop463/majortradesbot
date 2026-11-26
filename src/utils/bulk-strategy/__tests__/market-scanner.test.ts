import { describe, expect, it } from '@jest/globals';
import {
    bestQualifiedMarket, bestRankedMarket, calculateDirectionalMetrics, partitionWalkForwardSamples, rankMarkets, scoreMarket,
} from '../market-scanner';
import type { MarketTick } from '../types';

const walk = (moves: readonly number[], start = 1000) => moves.reduce<number[]>((prices, move) => [...prices, prices[prices.length - 1] + move], [start]);
const steady = (n: number, move = 1) => walk(Array(n - 1).fill(move));
const parityTicks = (values: readonly number[], pipSize: number | null = 1): MarketTick[] => values.map((value, sequence) => ({ quote: 100 + (value ? 0.1 : 0.2), pipSize, sequence }));
const irregular = (n: number) => walk(Array.from({ length: n - 1 }, (_, i) => i % 11 < 6 ? 1 : -0.5));

describe('ranking-first market selection', () => {
    it('selects a usable candidate with a composite score below 0.73', () => {
        const lowScore = { ...scoreMarket('R_10', 'tick-striker', irregular(1200)), score: 0.42, qualified: true };
        expect(bestRankedMarket([lowScore])).toBe(lowScore);
    });

    it('ranks the highest composite score first, independent of validation status', () => {
        const low = { ...scoreMarket('R_10', 'tick-striker', irregular(1200)), score: 0.31, qualified: true };
        const high = { ...scoreMarket('R_25', 'tick-striker', irregular(1200)), score: 0.68, qualified: true, validation: { ...low.validation, status: 'insufficient data' as const, lift: null } };
        expect(rankMarkets([low, high]).map(row => row.symbol)).toEqual(['R_25', 'R_10']);
        expect(bestQualifiedMarket([low, high])?.symbol).toBe('R_25');
    });

    it('still rejects invalid history and insufficient minimum ticks', () => {
        expect(scoreMarket('bad', 'tick-striker', [1, 2, NaN]).score).toBeNull();
        expect(scoreMarket('short', 'tick-striker', steady(119)).score).toBeNull();
        expect(scoreMarket('short', 'tick-striker', steady(119)).contract).toBeNull();
    });

    it('returns no candidate for empty or wholly unscorable results', () => {
        expect(bestRankedMarket([])).toBeNull();
        expect(bestQualifiedMarket([scoreMarket('short', 'nexus-rise-fall', steady(40))])).toBeNull();
    });

    it('uses deterministic symbol ordering to break exact score ties', () => {
        const a = { ...scoreMarket('R_50', 'tick-striker', irregular(1200)), score: 0.5, qualified: true };
        const b = { ...scoreMarket('R_10', 'tick-striker', irregular(1200)), score: 0.5, qualified: true };
        expect(rankMarkets([a, b]).map(row => row.symbol)).toEqual(['R_10', 'R_50']);
    });

    it('keeps actual OOS metrics null when evidence is inconclusive while allowing a neutral composite contribution', () => {
        const result = scoreMarket('R_100', 'tick-striker', irregular(120));
        expect(result.validation.status).toBe('insufficient data');
        expect(result.validation.outOfSampleRate).toBeNull();
        // 120 ticks are enough for valid structural evaluation; it may still be unscorable for this model's history.
        expect(result.qualified).toBe(false);
    });

    it('preserves Tick Striker and Even/Odd contracts while refusing invalid precision', () => {
        const striker = scoreMarket('R_100', 'tick-striker-v4', irregular(1200));
        expect(striker.contract).toEqual({ contract_type: 'TICKHIGH', duration: 5, duration_unit: 't', selected_tick: 5 });
        const parity = scoreMarket('R_50', 'nexus-even-odd', steady(1200), parityTicks(Array.from({ length: 1200 }, (_, i) => i % 2)));
        expect(parity.contract?.contract_type).toBe('DIGITEVEN');
        const missing = scoreMarket('R_50', 'nexus-even-odd', steady(1200), parityTicks(Array(1200).fill(0), null));
        expect(missing.score).toBeNull();
    });

    it('keeps original tick boundaries and embargo on every validation partition', () => {
        const samples = partitionWalkForwardSamples(1000, end => (end % 2) as 0 | 1, { featureLookback: 60, horizon: 5, embargo: 5, minTrain: 10, minValidation: 10, minOos: 10 });
        expect(samples.train.every(row => row.targetEnd < samples.trainTickEnd)).toBe(true);
        expect(samples.validation.every(row => row.featureEnd >= samples.trainTickEnd + 5 && row.targetEnd < samples.validationTickEnd)).toBe(true);
        expect(samples.outOfSample.every(row => row.featureEnd >= samples.validationTickEnd + 5 && row.targetEnd < 1000)).toBe(true);
    });
});
