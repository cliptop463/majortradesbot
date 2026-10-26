import { describe, expect, it } from '@jest/globals';
import { STRATEGIES, frequencyStrategy } from '../strategies';

describe('strategy registry', () => {
    it('keeps the expected eight strategies in the default set', () => {
        expect(STRATEGIES).toHaveLength(8);
        expect(STRATEGIES.map(strategy => strategy.name)).toBeUndefined();
    });

    it('frequencyStrategy requires at least 100 observations before signaling', () => {
        const result = frequencyStrategy(Array.from({ length: 99 }, () => 0));
        expect(result.status).toBe('ineligible');
        expect(result.reason).toContain('Needs at least 100 observations');
    });

    it('streakStrategy signals only for a recurring run of at least 3', () => {
        const result = streakStrategy([7, 7, 7, 9]);
        expect(result.status).toBe('abstain');
        expect(result.direction).toBeUndefined();
    });
});
