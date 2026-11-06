import { describe, expect, it } from '@jest/globals';
import { DEFAULT_CONFIG } from '../config';
import { STRATEGIES, getStrategy, listStrategies } from '../strategies';
import { BUFFER_SIZE, MIN_TICKS, evaluate, settle, tickStriker } from '../strategies/tick-striker';
import { falling, rising } from '../testing/fake-api';

describe('Tick Striker contract', () => {
    it('is High Tick, selected tick 5, 5 ticks', () => {
        expect(tickStriker.contract(DEFAULT_CONFIG)).toEqual({
            contract_type: 'TICKHIGH',
            duration: 5,
            duration_unit: 't',
            selected_tick: 5,
        });
        expect(tickStriker.minTicks).toBe(18);
        expect(tickStriker.bufferSize).toBe(120);
    });

    it('is registered so more strategies can be added beside it', () => {
        expect(getStrategy('tick-striker')).toBe(tickStriker);
        expect(listStrategies()).toContain(tickStriker);
        expect(getStrategy('nope')).toBeUndefined();
        expect(Object.keys(STRATEGIES)).toEqual(['tick-striker']);
    });
});

describe('Tick Striker signal', () => {
    it('does not trade with fewer than 18 ticks', () => {
        const result = evaluate(rising(MIN_TICKS - 1));
        expect(result.trade).toBe(false);
        expect(result.confidence).toBe(0);
        expect(result.reason).toContain('Need 18');
    });

    it('trades on a rising series (conf 1)', () => {
        const result = evaluate(rising(30));
        expect(result.trade).toBe(true);
        expect(result.confidence).toBeCloseTo(1);
    });

    it('does not trade on a falling or flat series (conf 0)', () => {
        expect(evaluate(falling(30)).trade).toBe(false);
        expect(evaluate(falling(30)).confidence).toBeCloseTo(0);
        expect(evaluate(Array(30).fill(100)).confidence).toBeCloseTo(0); // equal ticks are "not up"
    });

    it('uses 0.5 for P(up | state) when the last state never occurred before', () => {
        // 17 falling ticks then one rise: series = 16 zeros then a single 1.
        const ticks = [...falling(17, 100), 150];
        const result = evaluate(ticks);
        const upRate = 1 / 17;
        expect(result.confidence).toBeCloseTo(0.65 * 0.5 + 0.35 * upRate, 6);
        expect(result.trade).toBe(false);
    });

    it('weights 0.65 conditional + 0.35 overall for an alternating series', () => {
        // up, down, up, down ... ends on "down" (0). After a 0 the next is always 1: P(up|0) = 1.
        const ticks = Array.from({ length: 31 }, (_, i) => (i % 2 === 0 ? 100 : 101)); // 100,101,100,...,100
        const result = evaluate(ticks);
        const series = ticks.slice(1).map((q, i) => (q > ticks[i] ? 1 : 0));
        const last = series[series.length - 1];
        let same = 0;
        let up = 0;
        for (let j = 0; j < series.length - 1; j++) {
            if (series[j] === last) {
                same++;
                if (series[j + 1] === 1) up++;
            }
        }
        const expected = 0.65 * (same ? up / same : 0.5) + 0.35 * (series.reduce((a, b) => a + b, 0) / series.length);
        expect(result.confidence).toBeCloseTo(expected, 10);
        expect(result.trade).toBe(expected >= 0.5);
    });

    it('only looks at the last 120 ticks', () => {
        const old = falling(80);
        const recent = rising(BUFFER_SIZE, 1000);
        expect(evaluate([...old, ...recent]).confidence).toBeCloseTo(evaluate(recent).confidence, 10);
    });
});

describe('Tick Striker paper settlement (real ticks only)', () => {
    const spec = tickStriker.contract(DEFAULT_CONFIG);

    it('waits until all five ticks have arrived', () => {
        expect(settle([1, 2, 3, 4], spec)).toBeUndefined();
    });

    it('wins when the 5th tick is the highest', () => {
        expect(settle([100, 101, 102, 103, 104], spec)).toBe(true);
        expect(settle([105, 99, 100, 101, 106], spec)).toBe(true);
    });

    it('loses when any earlier tick is higher', () => {
        expect(settle([100, 101, 102, 110, 104], spec)).toBe(false);
        expect(settle([110, 101, 102, 103, 104], spec)).toBe(false);
    });

    it('treats a tie for highest as a loss (conservative)', () => {
        expect(settle([100, 101, 102, 104, 104], spec)).toBe(false);
        expect(settle([104, 100, 100, 100, 104], spec)).toBe(false);
    });

    it('ignores ticks beyond the fifth', () => {
        expect(settle([100, 101, 102, 103, 104, 90, 200], spec)).toBe(true);
    });
});
