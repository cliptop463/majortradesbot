import { describe, expect, it } from '@jest/globals';
import { DEFAULT_CONFIG } from '../config';
import {
    BUFFER_SIZE_V4,
    MIN_TICKS_V4,
    evaluateV4,
    settleV4,
    tickStrikerV4,
} from '../strategies/tick-striker-v4';

const variedTicks = (count: number) =>
    Array.from({ length: count }, (_, index) => 100 + Math.sin(index * 1.7) * 2 + Math.sin(index * 0.31) * 3);

describe('Tick Striker V4', () => {
    it('keeps the same comparable TICKHIGH contract as V3', () => {
        expect(tickStrikerV4.contract(DEFAULT_CONFIG)).toEqual({
            contract_type: 'TICKHIGH',
            duration: 5,
            duration_unit: 't',
            selected_tick: 5,
        });
    });

    it('requires its larger warm-up window', () => {
        const result = evaluateV4(variedTicks(MIN_TICKS_V4 - 1));
        expect(result.trade).toBe(false);
        expect(result.diagnostics?.rejectionCode).toBe('insufficient_ticks');
    });

    it('rejects invalid quotes', () => {
        const ticks = variedTicks(BUFFER_SIZE_V4);
        ticks[20] = NaN;
        expect(evaluateV4(ticks).diagnostics?.rejectionCode).toBe('invalid_tick_data');
    });

    it('settles only when tick five is strictly highest', () => {
        expect(settleV4([100, 101, 102, 103, 104], tickStrikerV4.contract(DEFAULT_CONFIG))).toBe(true);
        expect(settleV4([100, 101, 102, 104, 104], tickStrikerV4.contract(DEFAULT_CONFIG))).toBe(false);
        expect(settleV4([100, 101, 102], tickStrikerV4.contract(DEFAULT_CONFIG))).toBeUndefined();
    });
});
