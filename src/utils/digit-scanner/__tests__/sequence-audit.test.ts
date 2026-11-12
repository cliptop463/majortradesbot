import { describe, expect, it } from '@jest/globals';
import { auditSequence } from '../sequence-audit';

describe('auditSequence', () => {
    it('reports the latest digit, streak, and successor history', () => {
        const result = auditSequence([7, 9, 7, 8, 7, 7, 7], { recentWindow: 5, previousWindow: 5 });
        expect(result.lastDigit).toBe(7);
        expect(result.currentStreak).toBe(3);
        expect(result.transitionLeader).toBe(7);
        expect(result.transitionSample).toBe(4);
    });

    it('flags a recent leader change only with enough evidence', () => {
        const previous = Array.from({ length: 40 }, () => 7);
        const recent = Array.from({ length: 20 }, () => 2);
        expect(auditSequence([...previous, ...recent]).reversalSignal).toBe(true);
        expect(auditSequence([7, 2, 7, 2]).reversalSignal).toBe(false);
    });
});
