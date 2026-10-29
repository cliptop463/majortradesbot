import { describe, expect, it } from '@jest/globals';
import { previewScannerPick } from '../blockly-scanner-pick';

const block = (type: string, fields: Record<string, string | number> = {}, extra: Record<string, unknown> = {}) => ({
    type,
    getField: (name: string) => (name in fields ? {} : null),
    getFieldValue: (name: string) => (name in fields ? fields[name] : null),
    ...extra,
});

const workspaceWith = (blocks: any[]) => ({ getAllBlocks: () => blocks });

const predictionTarget = { getFieldValue: () => 3 };

const fullBlocks = () => [
    block('trade_definition'),
    block('trade_definition_market', { SYMBOL_LIST: 'R_10' }),
    block('trade_definition_tradetype', { TRADETYPECAT_LIST: 'callput', TRADETYPE_LIST: 'risefall' }),
    block('trade_definition_contracttype', { TYPE_LIST: 'CALL' }),
    block('trade_definition_tradeoptions', {}, {
        getInput: () => ({}),
        getInputTargetBlock: () => predictionTarget,
    }),
];

describe('previewScannerPick', () => {
    it('lists every field that will change, including category and trade type', () => {
        const result: any = previewScannerPick(workspaceWith(fullBlocks()), {
            symbol: 'R_100',
            direction: 'DIFFERS',
            digit: 4,
        });
        expect(result.ok).toBe(true);
        expect(result.symbol).toEqual({ before: 'R_10', after: 'R_100' });
        expect(result.category).toEqual({ before: 'callput', after: 'digits' });
        expect(result.tradeType).toEqual({ before: 'risefall', after: 'matchesdiffers' });
        expect(result.type).toEqual({ before: 'CALL', after: 'DIGITDIFF' });
        expect(result.prediction.after).toBe(4);
    });

    it('is BLOCKED when the market block is missing', () => {
        const blocks = fullBlocks().filter(b => b.type !== 'trade_definition_market');
        const result: any = previewScannerPick(workspaceWith(blocks), { symbol: 'R_100', direction: 'MATCHES', digit: 1 });
        expect(result.ok).toBe(false);
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('BLOCKED');
    });

    it('is BLOCKED when the symbol field is missing from the market block', () => {
        const blocks = fullBlocks().map(b => (b.type === 'trade_definition_market' ? block(b.type, {}) : b));
        const result: any = previewScannerPick(workspaceWith(blocks), { symbol: 'R_100', direction: 'MATCHES', digit: 1 });
        expect(result.ok).toBe(false);
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('SYMBOL_LIST');
    });
});
