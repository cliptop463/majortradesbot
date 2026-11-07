import { describe, expect, it } from '@jest/globals';
import { DEFAULT_CONFIG } from '../config';
import { STRATEGIES, getStrategy, listStrategies } from '../strategies';
import {
    BUFFER_SIZE,
    MIN_NEGATIVE_EXAMPLES,
    MIN_POSITIVE_EXAMPLES,
    MIN_TICKS,
    evaluate,
    settle,
    tickStriker,
} from '../strategies/tick-striker';
import { falling, rising } from '../testing/fake-api';

const variedTicks = (count: number) =>
    Array.from({ length: count }, (_, index) => 100 + Math.sin(index * 1.7) * 2 + Math.sin(index * 0.31) * 3);

const trendingTicks = () => {
    let price = 1000;
    const ticks: number[] = [];
    for (let block = 0; block < 41; block++) {
        const direction = block % 2 === 0 ? 1 : -1;
        for (let index = 0; index < 30; index++) {
            price += direction;
            ticks.push(price);
        }
    }
    return ticks.slice(-BUFFER_SIZE);
};

describe('Tick Striker contract', () => {
    it('is High Tick, selected tick 5, 5 ticks', () => {
        expect(tickStriker.contract(DEFAULT_CONFIG)).toEqual({
            contract_type: 'TICKHIGH',
            duration: 5,
            duration_unit: 't',
            selected_tick: 5,
        });
        expect(tickStriker.minTicks).toBe(MIN_TICKS);
        expect(tickStriker.bufferSize).toBe(BUFFER_SIZE);
        expect(tickStriker.ticksToSettle).toBe(5);
    });

    it('is registered so more strategies can be added beside it', () => {
        expect(getStrategy('tick-striker')).toBe(tickStriker);
        expect(listStrategies()).toContain(tickStriker);
        expect(getStrategy('nope')).toBeUndefined();
        expect(Object.keys(STRATEGIES)).toEqual(['tick-striker']);
    });
});

describe('Tick Striker model score', () => {
    it('does not score before the minimum real-tick window is available', () => {
        const result = evaluate(rising(MIN_TICKS - 1));
        expect(result.trade).toBe(false);
        expect(result.score).toBeNull();
        expect(result.reason).toContain(`Need ${MIN_TICKS}`);
    });

    it('does not score unless enough positive and negative outcomes are observed', () => {
        const result = evaluate(rising(MIN_TICKS));
        expect(result.trade).toBe(false);
        expect(result.score).toBeNull();
        expect(result.reason).toContain(`${MIN_POSITIVE_EXAMPLES} positive`);
        expect(result.reason).toContain(`${MIN_NEGATIVE_EXAMPLES} negative`);
    });

    it('rejects invalid quotes instead of producing a score', () => {
        for (const invalid of [NaN, Infinity, -1, 0]) {
            const ticks = variedTicks(MIN_TICKS);
            ticks[150] = invalid;
            const result = evaluate(ticks);
            expect(result.trade).toBe(false);
            expect(result.score).toBeNull();
            expect(result.reason).toContain('Invalid tick data');
        }
    });

    it('trains a deterministic logistic score from both observed outcome classes', () => {
        const ticks = variedTicks(BUFFER_SIZE);
        const result = evaluate(ticks);

        expect(result.score).not.toBeNull();
        expect(Number.isFinite(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
        expect(result.reason).toContain('Uncalibrated TICKHIGH model score');
        expect(result.trade).toBe(result.score! >= 0.5);
        expect(evaluate(ticks)).toEqual(result);
    });

    it('can signal when the rolling training history supports a continuation score', () => {
        const result = evaluate(trendingTicks());
        expect(result.score).not.toBeNull();
        expect(result.trade).toBe(true);
    });

    it('uses only the most recent buffer of quotes', () => {
        const recent = variedTicks(BUFFER_SIZE);
        expect(evaluate([...falling(100), ...recent])).toEqual(evaluate(recent));
    });
});

describe('Tick Striker paper settlement', () => {
    const spec = tickStriker.contract(DEFAULT_CONFIG);

    it('waits until all five ticks have arrived', () => {
        expect(settle([1, 2, 3, 4], spec)).toBeUndefined();
    });

    it('wins only when the fifth tick is strictly higher than each of ticks one through four', () => {
        expect(settle([100, 101, 102, 103, 104], spec)).toBe(true);
        expect(settle([105, 99, 100, 101, 106], spec)).toBe(true);
        expect(settle([100, 101, 102, 110, 104], spec)).toBe(false);
        expect(settle([110, 101, 102, 103, 104], spec)).toBe(false);
    });

    it('treats a tie for highest or any invalid quote as a loss', () => {
        expect(settle([100, 101, 102, 104, 104], spec)).toBe(false);
        expect(settle([104, 100, 100, 100, 104], spec)).toBe(false);
        expect(settle([100, 101, NaN, 103, 104], spec)).toBe(false);
        expect(settle([100, 101, 0, 103, 104], spec)).toBe(false);
    });

    it('ignores ticks beyond the five-tick contract window', () => {
        expect(settle([100, 101, 102, 103, 104, 90, 200], spec)).toBe(true);
    });

    it('rejects an invalid selected tick rather than settling a different contract', () => {
        expect(settle([100, 101, 102, 103, 104], { ...spec, selected_tick: 6 })).toBe(false);
    });
});
