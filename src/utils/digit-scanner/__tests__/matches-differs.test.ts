import { describe, expect, it } from '@jest/globals';
import {
    DEFAULT_SAMPLE,
    analyze,
    expectedDeviation,
    expectedNoiseScore,
    isVolatilitySymbol,
    lastDigit,
    scoreFromDeviation,
    significanceOf,
    volatilityName,
} from '../matches-differs';

const makeRng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const withCounts = (counts: number[]) => counts.flatMap((count, digit) => Array(count).fill(digit));

describe('lastDigit', () => {
    it('keeps trailing zeros by formatting to the pip size', () => {
        expect(lastDigit(1583.2, 2)).toBe(0);
        expect(lastDigit(1583.25, 2)).toBe(5);
        expect(lastDigit(1583, 0)).toBe(3);
        expect(lastDigit(13413.601, 3)).toBe(1);
    });

    it('returns NaN for unusable input instead of a wrong digit', () => {
        expect(lastDigit(NaN, 2)).toBeNaN();
        expect(lastDigit(Infinity, 2)).toBeNaN();
        expect(lastDigit(1.5, -1)).toBeNaN();
        expect(lastDigit(1.5, 2.5)).toBeNaN();
        expect(lastDigit('1.5' as unknown as number, 2)).toBeNaN();
    });
});

describe('analyze', () => {
    it('a perfectly even sample has no deviation and is not significant', () => {
        const result = analyze(withCounts(Array(10).fill(100)));
        expect(result.sample).toBe(1000);
        expect(result.deviation).toBeCloseTo(0);
        expect(result.chi2).toBeCloseTo(0);
        expect(result.significant).toBe(false);
        expect(result.significance).toBe('none');
        expect(result.score).toBeCloseTo(52);
    });

    it('1000 sevens: highest 7, deviation 180, chi2 9000, significant', () => {
        const result = analyze(Array(1000).fill(7));
        expect(result.highest).toBe(7);
        expect(result.lowest).toBe(0); // all other digits tie at zero: lowest index wins
        expect(result.deviation).toBeCloseTo(180);
        expect(result.chi2).toBeCloseTo(9000);
        expect(result.significant).toBe(true);
        expect(result.significance).toBe('p<0.001');
        expect(result.score).toBe(96); // clamped
        expect(result.matchPercent).toBeCloseTo(100);
        expect(result.differPercent).toBeCloseTo(100);
    });

    it('a tie returns the lowest digit index for both extremes', () => {
        const result = analyze(withCounts(Array(10).fill(100)));
        expect(result.highest).toBe(0);
        expect(result.lowest).toBe(0);

        const counts = Array(10).fill(100);
        counts[3] = 120;
        counts[6] = 120;
        counts[2] = 80;
        counts[9] = 80;
        const tied = analyze(withCounts(counts));
        expect(tied.highest).toBe(3);
        expect(tied.lowest).toBe(2);
    });

    it('reports match and differ percentages from the right digits', () => {
        const counts = Array(10).fill(100);
        counts[3] = 200;
        counts[8] = 0;
        const result = analyze(withCounts(counts));
        expect(result.highest).toBe(3);
        expect(result.lowest).toBe(8);
        expect(result.matchPercent).toBeCloseTo(20);
        expect(result.differPercent).toBeCloseTo(100);
    });

    it('empty or invalid input does not throw and returns a neutral result', () => {
        const empty = analyze([]);
        expect(empty.sample).toBe(0);
        expect(empty.chi2).toBe(0);
        expect(empty.deviation).toBe(0);
        expect(empty.significant).toBe(false);
        expect(empty.stats).toHaveLength(10);

        const junk = analyze([NaN, -1, 10, 3.5, '4' as unknown as number]);
        expect(junk.sample).toBe(0);
        expect(() => analyze(undefined as unknown as number[])).not.toThrow();
    });

    it('ignores invalid values but still analyses the valid ones', () => {
        const result = analyze([...withCounts(Array(10).fill(50)), NaN, 99, -3]);
        expect(result.sample).toBe(500);
    });

    it('flags an extreme digit only when it clears the Bonferroni threshold', () => {
        const fair = analyze(withCounts(Array(10).fill(100)));
        expect(fair.highestExtreme).toBe(false);
        expect(fair.lowestExtreme).toBe(false);

        const counts = Array(10).fill(offset(100, 0));
        counts[7] = 160; // z about 6.3
        counts[1] = 40;
        const skewed = analyze(withCounts(counts));
        expect(skewed.highest).toBe(7);
        expect(skewed.highestExtreme).toBe(true);
        expect(skewed.lowestExtreme).toBe(true);
        expect(skewed.stats[7].z).toBeGreaterThan(6);

        function offset(value: number, by: number) {
            return value + by;
        }
    });

    it('uses a default sample of 1000', () => {
        expect(DEFAULT_SAMPLE).toBe(1000);
    });
});

describe('score and significance', () => {
    it('clamps the score between 50 and 96', () => {
        expect(scoreFromDeviation(0)).toBeCloseTo(52);
        expect(scoreFromDeviation(10)).toBeCloseTo(66);
        expect(scoreFromDeviation(-100)).toBe(50);
        expect(scoreFromDeviation(180)).toBe(96);
    });

    it('labels chi-square against the critical values for 9 degrees of freedom', () => {
        expect(significanceOf(16.9)).toBe('none');
        expect(significanceOf(16.93)).toBe('p<0.05');
        expect(significanceOf(21.7)).toBe('p<0.01');
        expect(significanceOf(27.9)).toBe('p<0.001');
    });

    it('shows what fair random digits typically score, so a middling score is not mistaken for a signal', () => {
        const noise = expectedNoiseScore(1000);
        expect(noise).toBeGreaterThan(61);
        expect(noise).toBeLessThan(64);

        // Monte Carlo agreement with the exact expectation.
        const rnd = makeRng(2024);
        let total = 0;
        const trials = 300;
        for (let t = 0; t < trials; t++) {
            total += analyze(Array.from({ length: 1000 }, () => Math.floor(rnd() * 10))).deviation;
        }
        expect(Math.abs(total / trials - expectedDeviation(1000))).toBeLessThan(0.4);
    });

    it('fair random digits are rarely flagged significant (about 5% at p<0.05)', () => {
        const rnd = makeRng(99);
        let flagged = 0;
        const trials = 600;
        for (let t = 0; t < trials; t++) {
            if (analyze(Array.from({ length: 1000 }, () => Math.floor(rnd() * 10))).significant) flagged++;
        }
        expect(flagged / trials).toBeGreaterThan(0.02);
        expect(flagged / trials).toBeLessThan(0.09);
    });
});

describe('market names', () => {
    it('names the volatility indices and recognises them', () => {
        expect(volatilityName('R_100')).toBe('Volatility 100 Index');
        expect(volatilityName('1HZ25V')).toBe('Volatility 25 (1s) Index');
        expect(volatilityName('frxEURUSD')).toBe('frxEURUSD');
        expect(isVolatilitySymbol('R_75')).toBe(true);
        expect(isVolatilitySymbol('1HZ10V')).toBe(true);
        expect(isVolatilitySymbol('frxEURUSD')).toBe(false);
        expect(isVolatilitySymbol(null)).toBe(false);
    });
});
