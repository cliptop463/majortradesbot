import { describe, expect, it, jest } from '@jest/globals';
import { MIN_MARKET_SCORE, bestRankedMarket, rankMarkets } from '../market-scanner';
import type { MarketScanResult } from '../market-scanner';
import { scannerStrategyForUi } from '../bulk-strategy-modal';

const result = (symbol: string, score: number, strategy = 'tick-striker' as const): MarketScanResult => ({
    symbol, strategy, score, qualified: true, contract: { contract_type: 'TICKHIGH', duration: 5, duration_unit: 't', selected_tick: 5 },
    direction: null, currentUpStreak: 0, currentDownStreak: 0, consecutiveOpposingMoves: 0, confirmedReversal: false,
    continuationRate: null, reversalCounts: { 5: 0, 10: 0, 20: 0, 40: 0, 60: 0 }, directionalEfficiency: null,
    volatility: 'suitable', validation: { status: 'insufficient data', trainSamples: 0, validationSamples: 0, outOfSampleSamples: 0,
        baselineRate: null, validationRate: null, outOfSampleRate: null, lift: null, embargo: 5, trainTickEnd: 0, validationTickEnd: 0 },
    scoreComponents: { continuationEvidence: null, directionalEfficiency: null, reversalResistance: null, multiWindowAgreement: null,
        volatilitySuitability: null, sampleReliability: null, validationQuality: null, contributions: {} }, rejectionReason: null, evaluatedAtTick: 120,
});

describe('Bulk Strategy scanner mapping and selection', () => {
    it.each(['tick-striker', 'tick-striker-v4', 'nexus-rise-fall', 'nexus-even-odd'])('maps supported strategy %s', id => {
        expect(scannerStrategyForUi(id)).toBe(id);
    });
    it('does not map unsupported strategies to a substitute model', () => expect(scannerStrategyForUi('nexus-over-under')).toBeNull());
    it('chooses the highest ranked low-score candidate; score is not a win probability threshold', () => {
        const best = bestRankedMarket([result('R_10', MIN_MARKET_SCORE - 0.2), result('R_25', 0.61)]);
        expect(best?.symbol).toBe('R_25');
        expect(best?.qualified).toBe(true);
    });
    it('uses stable ordering for score ties', () => expect(rankMarkets([result('R_50', 0.4), result('R_10', 0.4)]).map(row => row.symbol)).toEqual(['R_10', 'R_50']));
});
