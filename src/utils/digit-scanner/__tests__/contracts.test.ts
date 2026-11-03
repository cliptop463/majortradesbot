import { describe, expect, it } from '@jest/globals';
import { CONTRACTS, barrierError, fairWinRate, formatPick, isWin } from '../contracts';

describe('contracts', () => {
    it('maps every direction to the Blockly trade type and contract type', () => {
        expect(CONTRACTS.MATCHES).toMatchObject({ tradeType: 'matchesdiffers', typeValue: 'DIGITMATCH', hasBarrier: true });
        expect(CONTRACTS.DIFFERS).toMatchObject({ tradeType: 'matchesdiffers', typeValue: 'DIGITDIFF' });
        expect(CONTRACTS.EVEN).toMatchObject({ tradeType: 'evenodd', typeValue: 'DIGITEVEN', hasBarrier: false });
        expect(CONTRACTS.ODD).toMatchObject({ tradeType: 'evenodd', typeValue: 'DIGITODD', hasBarrier: false });
        expect(CONTRACTS.OVER).toMatchObject({ tradeType: 'overunder', typeValue: 'DIGITOVER', hasBarrier: true });
        expect(CONTRACTS.UNDER).toMatchObject({ tradeType: 'overunder', typeValue: 'DIGITUNDER', hasBarrier: true });
    });

    it('scores wins the way each contract settles', () => {
        expect(isWin('MATCHES', 4, 4)).toBe(true);
        expect(isWin('MATCHES', 4, 5)).toBe(false);
        expect(isWin('DIFFERS', 4, 5)).toBe(true);
        expect(isWin('DIFFERS', 4, 4)).toBe(false);
        expect(isWin('EVEN', null, 0)).toBe(true);
        expect(isWin('ODD', null, 7)).toBe(true);
        expect(isWin('OVER', 3, 4)).toBe(true);
        expect(isWin('OVER', 3, 3)).toBe(false);
        expect(isWin('UNDER', 6, 5)).toBe(true);
        expect(isWin('UNDER', 6, 6)).toBe(false);
    });

    it('gives the fair-digit baseline win rate, which no past data changes', () => {
        expect(fairWinRate('MATCHES', 1)).toBeCloseTo(0.1);
        expect(fairWinRate('DIFFERS', 1)).toBeCloseTo(0.9);
        expect(fairWinRate('EVEN')).toBeCloseTo(0.5);
        expect(fairWinRate('OVER', 3)).toBeCloseTo(0.6);
        expect(fairWinRate('UNDER', 6)).toBeCloseTo(0.6);
    });

    it('validates barriers, including contracts that can never win', () => {
        expect(barrierError('MATCHES', 9)).toBeNull();
        expect(barrierError('MATCHES', 10)).toContain('0 to 9');
        expect(barrierError('MATCHES', null)).toContain('0 to 9');
        expect(barrierError('EVEN', null)).toBeNull();
        expect(barrierError('OVER', 8)).toBeNull();
        expect(barrierError('OVER', 9)).toContain('Over 9');
        expect(barrierError('UNDER', 1)).toBeNull();
        expect(barrierError('UNDER', 0)).toContain('Under 0');
    });

    it('formats picks', () => {
        expect(formatPick('MATCHES', 7)).toBe('Matches 7');
        expect(formatPick('EVEN', null)).toBe('Even');
        expect(formatPick('OVER', 3)).toBe('Over 3');
    });
});
