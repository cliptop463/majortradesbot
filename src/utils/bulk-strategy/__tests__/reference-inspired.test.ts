import { describe, expect, it } from '@jest/globals';
import { DEFAULT_CONFIG } from '../config';
import { BulkEngine } from '../engine';
import type { MarketTick } from '../types';
import {
    blueprintRecentPattern,
    proAnalyserFrequency,
    tacticsWeightedFrequency,
} from '../strategies/reference-inspired';
import { FakeApi, flush } from '../testing/fake-api';

const ticksFromDigits = (digits: readonly number[], pipSize: number | null = 1): MarketTick[] =>
    digits.map((digit, index) => ({
        quote: 100 + digit / 10,
        pipSize,
        sequence: index + 1,
    }));

describe('reference-inspired strategies', () => {
    it('uses the repeated latest digit for the Blueprint recent pattern', () => {
        const digits = [...Array.from({ length: 17 }, (_, index) => index % 10), 4, 7, 7];
        const result = blueprintRecentPattern.evaluateMarketTicks!(ticksFromDigits(digits), DEFAULT_CONFIG);

        expect(result.trade).toBe(true);
        expect(result.contract?.barrier).toBe('7');
        expect(result.reason).toContain('2/3');
    });

    it('only signals ProAnalyser frequency when a digit clears its historical threshold', () => {
        const uniform = Array.from({ length: 500 }, (_, index) => index % 10);
        const uniformResult = proAnalyserFrequency.evaluateMarketTicks!(ticksFromDigits(uniform), DEFAULT_CONFIG);
        expect(uniformResult.trade).toBe(false);

        const skewed = [...Array<number>(250).fill(6), ...Array.from({ length: 250 }, (_, index) => index % 10)];
        const skewedResult = proAnalyserFrequency.evaluateMarketTicks!(ticksFromDigits(skewed), DEFAULT_CONFIG);
        expect(skewedResult.trade).toBe(true);
        expect(skewedResult.contract?.barrier).toBe('6');
    });

    it('weights the most recent 60% in the Tactics-inspired frequency', () => {
        const digits = [
            ...Array.from({ length: 48 }, (_, index) => index % 10),
            ...Array<number>(72).fill(8),
        ];
        const result = tacticsWeightedFrequency.evaluateMarketTicks!(ticksFromDigits(digits), DEFAULT_CONFIG);

        expect(result.trade).toBe(true);
        expect(result.contract?.barrier).toBe('8');
        expect(result.reason).toContain('weighted share');
    });

    it('abstains rather than guessing when tick precision is unavailable', () => {
        const digits = [...Array<number>(20).fill(7)];
        const result = blueprintRecentPattern.evaluateMarketTicks!(ticksFromDigits(digits, null), DEFAULT_CONFIG);
        expect(result.trade).toBe(false);
        expect(result.reason).toContain('precision metadata');
    });

    it('uses precise tick digits for Paper proposals and settlement', async () => {
        const api = new FakeApi();
        const historyDigits = [...Array.from({ length: 17 }, (_, index) => index % 10), 4, 7, 7];
        api.responders.push(request => {
            if (request.ticks_history) {
                return {
                    history: { prices: historyDigits.map(digit => 100 + digit / 10), pip_size: 1 },
                    subscription: { id: 'tick-sub' },
                };
            }
            if (request.proposal) return { proposal: { payout: 3.5, ask_price: 1 } };
            return undefined;
        });
        const rounds: Array<{ won: number; lost: number }> = [];
        const engine = new BulkEngine(
            {
                ...DEFAULT_CONFIG,
                strategyId: 'blueprint-recent-pattern',
                bulkSize: 1,
                stake: 1,
                profitTarget: 100,
                maxLoss: 100,
                martingale: { enabled: false, multiplier: 2, maxSteps: 0 },
                maxRounds: 1,
            },
            api,
            { onRound: round => rounds.push({ won: round.won, lost: round.lost }) }
        );

        await engine.start();
        await flush();
        expect(api.sent.find(request => request.proposal)).toMatchObject({
            contract_type: 'DIGITMATCH',
            barrier: '7',
        });

        api.emit({
            msg_type: 'tick',
            tick: { symbol: 'R_100', quote: 100.7, pip_size: 1 },
            subscription: { id: 'tick-sub' },
        });
        await flush();

        expect(rounds).toEqual([{ won: 1, lost: 0 }]);
        expect(engine.getSummary().contractsInterrupted).toBe(0);
    });
});
