import { describe, expect, it } from '@jest/globals';
import { DEFAULT_CONFIG } from '../config';
import { STRATEGIES, getStrategy, listStrategies } from '../strategies';
import {
    BUFFER_SIZE,
    MIN_NEGATIVE_EXAMPLES,
    MIN_POSITIVE_EXAMPLES,
    MIN_TICKS,
    THRESHOLD,
    evaluate,
    settle,
    tickStriker,
    walkForwardThresholdTest,
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
        expect(result.diagnostics).toMatchObject({
            tickCount: MIN_TICKS - 1,
            modelTrained: false,
            signalAvailable: false,
            rejectionCode: 'insufficient_ticks',
        });
    });

    it('does not score unless enough positive and negative outcomes are observed', () => {
        const result = evaluate(rising(MIN_TICKS));
        expect(result.trade).toBe(false);
        expect(result.score).toBeNull();
        expect(result.reason).toContain(`${MIN_POSITIVE_EXAMPLES} positive`);
        expect(result.reason).toContain(`${MIN_NEGATIVE_EXAMPLES} negative`);
        expect(result.diagnostics?.rejectionCode).toBe('insufficient_outcomes');
    });

    it('rejects invalid quotes instead of producing a score', () => {
        for (const invalid of [NaN, Infinity, -1, 0]) {
            const ticks = variedTicks(MIN_TICKS);
            ticks[150] = invalid;
            const result = evaluate(ticks);
            expect(result.trade).toBe(false);
            expect(result.score).toBeNull();
            expect(result.reason).toContain('Invalid tick data');
            expect(result.diagnostics?.rejectionCode).toBe('invalid_tick_data');
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
        expect(result.diagnostics).toMatchObject({
            tickCount: BUFFER_SIZE,
            trainingSampleCount: expect.any(Number),
            modelTrained: true,
            entryThreshold: THRESHOLD,
        });
        expect(result.diagnostics?.positiveOutcomeRate).toBeCloseTo(
            result.diagnostics!.positiveExamples / result.diagnostics!.trainingSampleCount
        );
        expect(evaluate(ticks)).toEqual(result);
    });

    it('can signal when the rolling training history supports a continuation score', () => {
        const result = evaluate(trendingTicks());
        expect(result.score).not.toBeNull();
        expect(result.trade).toBe(true);
        expect(result.diagnostics?.signalAvailable).toBe(true);
    });

    it('triggers only at or above the specified entry threshold', () => {
        const ticks = trendingTicks();
        const scored = evaluate(ticks, 0);
        expect(scored.score).not.toBeNull();
        const score = scored.score!;
        expect(evaluate(ticks, score).trade).toBe(true);
        const below = evaluate(ticks, Math.min(1, score + 0.001));
        expect(below.trade).toBe(false);
        expect(below.diagnostics?.rejectionCode).toBe('below_threshold');
        expect(below.diagnostics?.rejectionReason).toContain('below entry threshold');
    });

    it('walks forward chronologically, selects on validation, and reports a separate payout-aware test window', () => {
        const ticks = trendingTicks();
        const quotes = ticks.map((_, tickIndex) => ({ tickIndex, askPrice: 1, payout: 3.5 }));
        const result = walkForwardThresholdTest(ticks, quotes);

        expect(result.reason).toBeNull();
        expect(result.embargoTicks).toBe(5);
        expect(result.trainingSamples).toBeGreaterThan(0);
        expect(result.validationSamples).toBeGreaterThan(0);
        expect(result.outOfSampleSamples).toBeGreaterThan(0);
        expect(result.candidateResults).toHaveLength(9);
        expect(result.selectedThreshold).not.toBeNull();
        expect(result.outOfSample).toMatchObject({
            threshold: result.selectedThreshold,
            trades: expect.any(Number),
            signalFrequency: expect.any(Number),
            maximumDrawdown: expect.any(Number),
        });
        expect(result.scoreDistribution?.min).toBeLessThanOrEqual(result.scoreDistribution!.median);
        expect(result.scoreDistribution?.median).toBeLessThanOrEqual(result.scoreDistribution!.max);
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
