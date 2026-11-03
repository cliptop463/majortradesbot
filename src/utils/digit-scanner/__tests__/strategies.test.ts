import { describe, expect, it } from '@jest/globals';
import { STRATEGIES, frequencyStrategy, streakStrategy } from '../strategies';

describe('strategy registry', () => {
    it('keeps the expected eight strategies in the default set', () => {
        expect(STRATEGIES).toHaveLength(8);
        expect(STRATEGIES.map(strategy => strategy.name)).toEqual([
            'frequencyStrategy',
            'recencyStrategy',
            'streakStrategy',
            'momentumStrategy',
            'skewStrategy',
            'transitionsStrategy',
            'gapsStrategy',
            'cyclesStrategy',
        ]);
    });

    it('every strategy returns a signal of MATCHES, DIFFERS or ABSTAIN with a reason', () => {
        const digits = Array.from({ length: 300 }, (_, i) => (i * 7) % 10);
        STRATEGIES.forEach(strategy => {
            const result = strategy(digits);
            expect(['MATCHES', 'DIFFERS', 'ABSTAIN']).toContain(result.signal);
            expect(typeof result.reason).toBe('string');
            expect(result.reason.length).toBeGreaterThan(0);
        });
    });

    it('frequencyStrategy is ineligible and abstains below 200 observations', () => {
        const result = frequencyStrategy(Array.from({ length: 99 }, () => 0));
        expect(result.status).toBe('ineligible');
        expect(result.signal).toBe('ABSTAIN');
        expect(result.reason).toContain('Needs 200 valid observations');
    });

    it('streakStrategy abstains below the run threshold and signals MATCHES at or above it', () => {
        const base = Array.from({ length: 60 }, (_, i) => i % 10);
        const short = streakStrategy([...base, 7, 7, 7]);
        expect(short.status).toBe('abstain');
        expect(short.signal).toBe('ABSTAIN');
        expect(short.direction).toBeUndefined();

        const long = streakStrategy([...base, 7, 7, 7, 7]);
        expect(long.status).toBe('signal');
        expect(long.signal).toBe('MATCHES');
        expect(long.digit).toBe(7);
    });
});
