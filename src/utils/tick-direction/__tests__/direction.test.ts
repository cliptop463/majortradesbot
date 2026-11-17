import { describe, expect, it, jest } from '@jest/globals';
import type { ActiveSymbol } from '@/utils/digit-scanner/types';
import {
    contractFor,
    detectDirection,
    ticksPerMinuteFor,
    windowsForMinutes,
} from '../direction';
import { scanDirections } from '../scan-directions';
import { evaluateDirection, settleDirection, tickDirection } from '@/utils/bulk-strategy/strategies/tick-direction';
import { DEFAULT_CONFIG } from '@/utils/bulk-strategy/config';
import { getStrategy } from '@/utils/bulk-strategy/strategies';
import * as tickStrikerV4 from '@/utils/bulk-strategy/strategies/tick-striker-v4';
import { evaluateV4Directional, tickStrikerV4Directional } from '@/utils/bulk-strategy/strategies/tick-striker-v4-directional';

function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function randomWalk(count: number, drift: number, seed: number, volatility = 0.0008): number[] {
    const random = seededRandom(seed);
    let price = 100;
    const prices = [price];
    for (let index = 1; index < count; index++) {
        const noise = (random() + random() + random() + random() - 2) * volatility;
        price *= Math.exp(drift + noise);
        prices.push(price);
    }
    return prices;
}

const market = (symbol: string): ActiveSymbol =>
    ({
        underlying_symbol: symbol,
        underlying_symbol_name: `${symbol} market`,
    }) as ActiveSymbol;

describe('tick direction gate', () => {
    it('maps statistically significant falling and rising prices to the correct contracts', () => {
        const falling = detectDirection(randomWalk(61, -0.0005, 1));
        const rising = detectDirection(randomWalk(61, 0.0005, 2));

        expect(falling.direction).toBe('DOWN');
        expect(contractFor(falling.direction!)).toBe('TICKHIGH');
        expect(rising.direction).toBe('UP');
        expect(contractFor(rising.direction!)).toBe('TICKLOW');
    });

    it('rejects driftless noise and a recent reversal after a sustained move', () => {
        expect(detectDirection(randomWalk(61, 0, 3)).direction).toBeNull();

        const prices = randomWalk(61, 0.0005, 4, 0);
        let price = prices[prices.length - 1];
        for (let index = 0; index < 5; index++) {
            price *= Math.exp(-0.0007);
            prices.push(price);
        }
        expect(detectDirection(prices).direction).toBeNull();
        expect(detectDirection(prices).code).toBe('recent_reversal');
    });

    it('reports insufficient and invalid tick data with their specific codes', () => {
        expect(detectDirection([100, 101]).code).toBe('insufficient_ticks');
        const invalid = randomWalk(61, 0.0005, 5);
        invalid[30] = Number.NaN;
        expect(detectDirection(invalid).code).toBe('invalid_tick_data');
    });

    it('uses the correct tick rates and minute windows', () => {
        expect(ticksPerMinuteFor('1HZ100V')).toBe(60);
        expect(ticksPerMinuteFor('R_100')).toBe(30);
        expect(windowsForMinutes(1, 60)).toEqual([20, 40, 60]);
    });

    it('fires on fewer than five percent of 400 seeded driftless walks', () => {
        let signals = 0;
        for (let seed = 1; seed <= 400; seed++) {
            if (detectDirection(randomWalk(61, 0, seed + 100)).direction) signals++;
        }
        expect(signals / 400).toBeLessThan(0.05);
    });
});

describe('direction scanner', () => {
    it('ranks signals first, maps falling prices to High Tick, and preserves fetch errors', async () => {
        const markets = [market('UP'), market('ERR'), market('DOWN')];
        const rows = await scanDirections(
            markets,
            async symbol => {
                if (symbol === 'ERR') throw new Error('history unavailable');
                return { prices: randomWalk(120, symbol === 'DOWN' ? -0.0005 : 0.0005, symbol === 'DOWN' ? 8 : 9) };
            },
            { minutes: 1 }
        );

        expect(rows[0].recommendation).toBe('HIGH');
        expect(rows.find(row => row.symbol === 'DOWN')?.direction).toBe('DOWN');
        expect(rows.find(row => row.symbol === 'ERR')?.reason).toBe('history unavailable');
        expect(rows.findIndex(row => row.recommendation === null)).toBeGreaterThan(0);
    });
});

describe('Tick Direction strategy', () => {
    it('settles only a strictly highest or lowest selected tick and supports a non-default tick', () => {
        expect(settleDirection([5, 4, 3, 2, 1], { contract_type: 'TICKHIGH', duration: 5, duration_unit: 't' })).toBe(true);
        expect(settleDirection([5, 5, 3, 2, 1], { contract_type: 'TICKHIGH', duration: 5, duration_unit: 't' })).toBe(false);
        expect(settleDirection([1, 2, 3, 4, 5], { contract_type: 'TICKLOW', duration: 5, duration_unit: 't' })).toBe(true);
        expect(settleDirection([1, 3, 5, 2, 4], { contract_type: 'TICKHIGH', duration: 5, duration_unit: 't', selected_tick: 3 })).toBe(true);
        expect(settleDirection([1, 2, 3, 4], { contract_type: 'TICKHIGH', duration: 5, duration_unit: 't' })).toBeUndefined();
    });

    it('returns a directional contract only when the direction gate passes', () => {
        expect(evaluateDirection(randomWalk(61, -0.0005, 10))).toMatchObject({
            trade: true,
            contract: { contract_type: 'TICKHIGH', duration: 5, selected_tick: 1 },
        });
        const rejected = evaluateDirection(randomWalk(61, 0, 11));
        expect(rejected.trade).toBe(false);
        expect(rejected.contract).toBeUndefined();
        expect(tickDirection.contract(DEFAULT_CONFIG)).toMatchObject({
            contract_type: 'TICKHIGH',
            duration: 5,
            selected_tick: 1,
        });
        expect(getStrategy('tick-direction')).toBe(tickDirection);
    });
});

describe('directional Tick Striker V4', () => {
    it('rejects a falling move before evaluating the model', () => {
        const evaluateSpy = jest.spyOn(tickStrikerV4, 'evaluateV4');
        const result = evaluateV4Directional(randomWalk(500, -0.0005, 12));
        expect(result.trade).toBe(false);
        expect(result.diagnostics).toBeUndefined();
        expect(result.reason).toContain('needs an UP move');
        expect(evaluateSpy).not.toHaveBeenCalled();
        expect(tickStrikerV4Directional.id).toBe('tick-striker-v4-directional');
        expect(getStrategy('tick-striker-v4-directional')).toBe(tickStrikerV4Directional);
        evaluateSpy.mockRestore();
    });
});
