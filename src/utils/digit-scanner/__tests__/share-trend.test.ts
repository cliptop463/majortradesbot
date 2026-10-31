import { describe, expect, it } from '@jest/globals';
import {
    classifyTrends,
    digitShareTrends,
    emptyStudy,
    mergeStudies,
    shareTrendStudy,
    studyVerdict,
    zForRate,
} from '../share-trend';

const makeRng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const uniform = (n: number, seed: number) => {
    const rnd = makeRng(seed);
    return Array.from({ length: n }, () => Math.floor(rnd() * 10));
};

describe('digitShareTrends', () => {
    it('returns null until there are window + shift ticks', () => {
        expect(digitShareTrends(uniform(349, 1))).toBeNull();
        expect(digitShareTrends(uniform(350, 1))).not.toBeNull();
    });

    it('computes now/prev shares and growth, and shares sum to 1', () => {
        const trends = digitShareTrends(uniform(600, 3)) as NonNullable<ReturnType<typeof digitShareTrends>>;
        expect(trends).toHaveLength(10);
        expect(trends.reduce((a, t) => a + t.now, 0)).toBeCloseTo(1);
        expect(trends.reduce((a, t) => a + t.prev, 0)).toBeCloseTo(1);
        trends.forEach(t => expect(t.growth).toBeCloseTo(t.now - t.prev));
    });

    it('measures growth between the two windows using only the intended ticks', () => {
        // First 50 ticks are all 9s, then 300 ticks of 0..4 cycling: digit 9 has share 0 now, 50/300 before.
        const digits = [...Array(50).fill(9), ...Array.from({ length: 300 }, (_, i) => i % 5)];
        const nine = (digitShareTrends(digits) as any[])[9];
        expect(nine.now).toBe(0);
        expect(nine.prev).toBeCloseTo(50 / 300);
        expect(nine.growth).toBeCloseTo(-50 / 300);
    });
});

describe('classifyTrends', () => {
    const trend = (digit: number, now: number, growth: number) => ({ digit, now, prev: now - growth, growth });

    it('rising = grew by >= 1 point and still under 11%; high = 11% or more', () => {
        const { rising, high } = classifyTrends([
            trend(0, 0.105, 0.011), // rising
            trend(1, 0.115, 0.02), // high (even though it grew)
            trend(2, 0.1, 0.004), // neither
            trend(3, 0.099, 0.015), // rising, bigger gain
            trend(4, 0.12, -0.01), // high
        ]);
        expect(rising.map(t => t.digit)).toEqual([3, 0]);
        expect(high.map(t => t.digit)).toEqual([4, 1]);
    });
});

describe('shareTrendStudy', () => {
    it('tallies outcomes against the next ticks only and reports fair baselines', () => {
        const study = shareTrendStudy(uniform(1000, 5), { horizon: 10 });
        expect(study.baselineAppear).toBeCloseTo(1 - Math.pow(0.9, 10));
        expect(study.baselineExact).toBe(0.1);
        expect(study.rising.n + study.high.n).toBeGreaterThan(0);
        expect(study.rising.appeared).toBeLessThanOrEqual(study.rising.n);
        expect(study.high.exact).toBeLessThanOrEqual(study.high.appeared);
    });

    it('finds no difference between rising and high digits on fair random data', () => {
        const studies = Array.from({ length: 60 }, (_, i) => shareTrendStudy(uniform(1000, 100 + i), { horizon: 10 }));
        const merged = mergeStudies(studies);
        expect(merged.rising.n).toBeGreaterThan(1000);
        const rate = (g: { appeared: number; n: number }) => g.appeared / g.n;
        expect(Math.abs(rate(merged.rising) - merged.baselineAppear)).toBeLessThan(0.03);
        expect(Math.abs(rate(merged.high) - merged.baselineAppear)).toBeLessThan(0.03);
        expect(studyVerdict(merged)).not.toBe('rising_above_baseline');
    });

    it('does detect a planted effect, so the test is capable of finding one', () => {
        // Plant: after each evaluation point, force the current top riser into the next 10 ticks.
        const studies = Array.from({ length: 30 }, (_, seed) => {
            const digits = uniform(350, 900 + seed);
            const rnd = makeRng(seed + 1);
            for (let t = 350; t < 1000; t += 10) {
                const rising = classifyTrends(digitShareTrends(digits) as any[]).rising;
                const block = Array.from({ length: 10 }, () => Math.floor(rnd() * 10));
                if (rising.length) block[Math.floor(rnd() * 9)] = rising[0].digit;
                digits.push(...block);
            }
            return shareTrendStudy(digits, { horizon: 10 });
        });
        const merged = mergeStudies(studies);
        expect(merged.rising.n).toBeGreaterThanOrEqual(200);
        expect(studyVerdict(merged)).toBe('rising_above_baseline');
    });

    it('reports insufficient data when there are too few events', () => {
        expect(studyVerdict(shareTrendStudy(uniform(400, 2)))).toBe('insufficient_data');
        expect(studyVerdict(emptyStudy())).toBe('insufficient_data');
    });

    it('merges studies by summing counts', () => {
        const a = shareTrendStudy(uniform(800, 8));
        const b = shareTrendStudy(uniform(800, 9));
        const m = mergeStudies([a, b]);
        expect(m.rising.n).toBe(a.rising.n + b.rising.n);
        expect(m.high.exact).toBe(a.high.exact + b.high.exact);
    });
});

describe('zForRate', () => {
    it('is 0 at the expected rate and signed otherwise', () => {
        expect(zForRate(100, 1000, 0.1)).toBeCloseTo(0);
        expect(zForRate(140, 1000, 0.1)).toBeGreaterThan(2);
        expect(zForRate(60, 1000, 0.1)).toBeLessThan(-2);
        expect(zForRate(0, 0, 0.1)).toBe(0);
    });
});
