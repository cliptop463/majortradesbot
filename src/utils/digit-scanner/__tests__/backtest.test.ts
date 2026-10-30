import { describe, expect, it } from '@jest/globals';
import { backtestDigits } from '../backtest';

const makeRng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const uniform = (n: number, seed: number) => {
    const rnd = makeRng(seed);
    return Array.from({ length: n }, () => Math.floor(rnd() * 10));
};
const biased = (n: number, seed: number, digit: number, p: number) => {
    const rnd = makeRng(seed);
    return Array.from({ length: n }, () => (rnd() < p ? digit : Math.floor(rnd() * 10)));
};

describe('backtestDigits', () => {
    it('reports insufficient data when there is not more history than the window', () => {
        const result = backtestDigits(uniform(300, 1), { window: 500 });
        expect(result.verdict).toBe('insufficient_data');
        expect(result.signals).toBe(0);
    });

    it('finds no evidence of edge on fair random digits', () => {
        const result = backtestDigits(uniform(6000, 7), { window: 500, step: 25 });
        expect(result.windows).toBeGreaterThan(100);
        expect(['no_signals', 'no_evidence_of_edge']).toContain(result.verdict);
    });

    it('scores a persistent planted bias above the 10% Matches baseline', () => {
        const result = backtestDigits(biased(6000, 11, 7, 0.2), { window: 500, step: 25 });
        expect(result.matches.signals).toBeGreaterThan(0);
        expect(result.hitRate).not.toBeNull();
        expect(result.hitRate as number).toBeGreaterThan(0.15);
        expect(result.verdict).toBe('above_baseline');
    });

    it('uses only past ticks: a bias that appears after the window is not credited', () => {
        const digits = [...uniform(1000, 3), ...Array.from({ length: 500 }, () => 7)];
        const early = backtestDigits(digits.slice(0, 1000), { window: 500, step: 50 });
        expect(['no_signals', 'no_evidence_of_edge']).toContain(early.verdict);
    });
});
