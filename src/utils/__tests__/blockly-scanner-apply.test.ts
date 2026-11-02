import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { applyScannerPick } from '../blockly-scanner-pick';

jest.setTimeout(30000);

const TRADE_TYPES: Record<string, Array<[string, string]>> = {
    matchesdiffers: [['Matches', 'DIGITMATCH'], ['Differs', 'DIGITDIFF']],
    evenodd: [['Even', 'DIGITEVEN'], ['Odd', 'DIGITODD']],
    overunder: [['Over', 'DIGITOVER'], ['Under', 'DIGITUNDER']],
    risefall: [['Rise', 'CALL'], ['Fall', 'PUT']],
};
const HAS_PREDICTION = new Set(['matchesdiffers', 'overunder']);

interface FakeOptions {
    startTradeType?: string;
    /** After the trade type is set to this value, put the old value back once after delayMs (a late Blockly refresh). */
    revert?: { once: boolean; delayMs: number };
    /** Pretend the contract dropdown never offers the new trade type's contracts. */
    brokenContractOptions?: boolean;
}

function buildFake(options: FakeOptions = {}) {
    const state = {
        symbol: 'R_100',
        category: 'digits',
        tradeType: options.startTradeType ?? 'matchesdiffers',
        type: 'both',
        prediction: 3,
    };
    let reverted = false;
    const typeOptions = () => [['Both', 'both'], ...(options.brokenContractOptions ? [] : TRADE_TYPES[state.tradeType] ?? [])];

    const field = (opts: () => Array<[string, string]>) => ({ getOptions: () => opts() });

    const predictionTarget = {
        getFieldValue: () => state.prediction,
        setFieldValue: (v: string) => {
            state.prediction = Number(v);
        },
    };

    const market = {
        type: 'trade_definition_market',
        getField: (n: string) => (n === 'SYMBOL_LIST' ? field(() => [['R_100', 'R_100'], ['R_50', 'R_50']]) : null),
        getFieldValue: (n: string) => (n === 'SYMBOL_LIST' ? state.symbol : null),
        setFieldValue: (v: string, n: string) => {
            if (n === 'SYMBOL_LIST') state.symbol = v;
        },
    };
    const tradeType = {
        type: 'trade_definition_tradetype',
        getField: (n: string) =>
            n === 'TRADETYPECAT_LIST'
                ? field(() => [['Digits', 'digits'], ['Up/Down', 'callput']])
                : n === 'TRADETYPE_LIST'
                  ? field(() => Object.keys(TRADE_TYPES).map(k => [k, k] as [string, string]))
                  : null,
        getFieldValue: (n: string) => (n === 'TRADETYPECAT_LIST' ? state.category : n === 'TRADETYPE_LIST' ? state.tradeType : null),
        setFieldValue: (v: string, n: string) => {
            if (n === 'TRADETYPECAT_LIST') state.category = v;
            if (n === 'TRADETYPE_LIST') {
                const previous = state.tradeType;
                state.tradeType = v;
                state.type = 'both'; // contract dropdown refreshes and resets to "both"
                if (options.revert && (!options.revert.once || !reverted)) {
                    reverted = true;
                    setTimeout(() => {
                        state.tradeType = previous;
                        state.type = 'both';
                    }, options.revert.delayMs);
                }
            }
        },
    };
    const contractType = {
        type: 'trade_definition_contracttype',
        getField: (n: string) => (n === 'TYPE_LIST' ? field(() => typeOptions() as Array<[string, string]>) : null),
        getFieldValue: (n: string) => (n === 'TYPE_LIST' ? state.type : null),
        setFieldValue: (v: string, n: string) => {
            if (n === 'TYPE_LIST' && typeOptions().some(o => o[1] === v)) state.type = v;
        },
    };
    const tradeOptions = {
        type: 'trade_definition_tradeoptions',
        getInput: (n: string) => (n === 'PREDICTION' && HAS_PREDICTION.has(state.tradeType) ? {} : null),
        getInputTargetBlock: (n: string) => (n === 'PREDICTION' && HAS_PREDICTION.has(state.tradeType) ? predictionTarget : null),
    };
    const blocks = [{ type: 'trade_definition' }, market, tradeType, contractType, tradeOptions];
    return { state, workspace: { getAllBlocks: () => blocks, render: () => undefined } };
}

beforeEach(() => {
    (window as any).Blockly = {
        Events: {
            setGroup: () => undefined,
            getGroup: () => null,
            fire: () => undefined,
            BlockChange: class {},
        },
    };
    (window as any).run_panel = { is_running: false };
});
afterEach(() => {
    delete (window as any).Blockly;
    delete (window as any).run_panel;
});

describe('applyScannerPick against a simulated Blockly', () => {
    it('applies Even from a Matches/Differs bot and leaves the prediction digit alone', async () => {
        const { state, workspace } = buildFake();
        const result: any = await applyScannerPick(workspace, { symbol: 'R_100', direction: 'EVEN' });
        expect(result.ok).toBe(true);
        expect(state).toMatchObject({ category: 'digits', tradeType: 'evenodd', type: 'DIGITEVEN', symbol: 'R_100' });
        expect(result.prediction).toBeNull();
    });

    it('applies Odd on another symbol', async () => {
        const { state, workspace } = buildFake();
        const result: any = await applyScannerPick(workspace, { symbol: 'R_50', direction: 'ODD' });
        expect(result.ok).toBe(true);
        expect(state).toMatchObject({ symbol: 'R_50', tradeType: 'evenodd', type: 'DIGITODD' });
    });

    it('still applies Over/Under with its barrier digit', async () => {
        const { state, workspace } = buildFake({ startTradeType: 'evenodd' });
        const result: any = await applyScannerPick(workspace, { symbol: 'R_100', direction: 'UNDER', digit: 6 });
        expect(result.ok).toBe(true);
        expect(state).toMatchObject({ tradeType: 'overunder', type: 'DIGITUNDER', prediction: 6 });
    });

    it('recovers when Blockly puts the old trade type back after a late refresh', async () => {
        const { state, workspace } = buildFake({ revert: { once: true, delayMs: 300 } });
        const result: any = await applyScannerPick(workspace, { symbol: 'R_100', direction: 'EVEN' });
        expect(result.ok).toBe(true);
        expect(state).toMatchObject({ tradeType: 'evenodd', type: 'DIGITEVEN' });
    });

    it('reports exactly what it found when Blockly keeps reverting', async () => {
        const { workspace } = buildFake({ revert: { once: false, delayMs: 100 } });
        const result: any = await applyScannerPick(workspace, { symbol: 'R_100', direction: 'EVEN' });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/did not keep the Even settings|unavailable/);
        expect(result.reason).toMatch(/matchesdiffers|Available/);
    });

    it('lists the available contract types when the one needed is missing', async () => {
        const { workspace } = buildFake({ brokenContractOptions: true });
        const result: any = await applyScannerPick(workspace, { symbol: 'R_100', direction: 'EVEN' });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Even contract type is unavailable');
        expect(result.reason).toContain('Available: both');
    });

    it('refuses to change anything while the bot is running', async () => {
        const { state, workspace } = buildFake();
        (window as any).run_panel = { is_running: true };
        const result: any = await applyScannerPick(workspace, { symbol: 'R_50', direction: 'EVEN' });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('bot is running');
        expect(state).toMatchObject({ symbol: 'R_100', tradeType: 'matchesdiffers' });
    });
});
