import { describe, expect, it } from '@jest/globals';
import {
    DEFAULT_CONFIG,
    MARKETS,
    RISK_PRESETS,
    STORAGE_KEY,
    applyRiskPreset,
    loadConfig,
    nextStake,
    saveConfig,
    validateConfig,
    worstCaseCost,
} from '../config';
import type { BulkConfig } from '../types';

const memoryStorage = (initial: Record<string, string> = {}) => {
    const data = { ...initial };
    return {
        data,
        getItem: (k: string) => (k in data ? data[k] : null),
        setItem: (k: string, v: string) => {
            data[k] = v;
        },
    };
};
const cfg = (patch: Partial<BulkConfig> = {}): BulkConfig => ({
    ...DEFAULT_CONFIG,
    martingale: { ...DEFAULT_CONFIG.martingale },
    ...patch,
});

describe('defaults', () => {
    it('start on Demo, Paper, with the optional trade-anyway timeout OFF', () => {
        expect(DEFAULT_CONFIG.account).toBe('demo');
        expect(DEFAULT_CONFIG.mode).toBe('paper');
        expect(DEFAULT_CONFIG.tradeAnywayAfterMs).toBeNull();
        expect(DEFAULT_CONFIG.strategyId).toBe('tick-striker');
    });

    it('offers the volatility indices', () => {
        expect(MARKETS).toContain('R_100');
        expect(MARKETS).toContain('1HZ100V');
        expect(MARKETS).toHaveLength(10);
    });

    it('High risk defaults to x2 with 3 steps', () => {
        expect(RISK_PRESETS.high.martingale).toEqual({ enabled: true, multiplier: 2, maxSteps: 3 });
        const high = applyRiskPreset(cfg(), 'high');
        expect(high.risk).toBe('high');
        expect(high.martingale).toEqual({ enabled: true, multiplier: 2, maxSteps: 3 });
        expect(high.stake).toBe(DEFAULT_CONFIG.stake); // presets never touch stake or limits
        expect(applyRiskPreset(cfg(), 'low').martingale.enabled).toBe(false);
    });
});

describe('stake progression', () => {
    const base = cfg({ stake: 1, martingale: { enabled: true, multiplier: 2, maxSteps: 3 } });

    it('is base * multiplier^min(lossStreak, maxSteps)', () => {
        expect([0, 1, 2, 3, 4, 9].map(n => nextStake(base, n))).toEqual([1, 2, 4, 8, 8, 8]);
    });

    it('is the base stake when martingale is off', () => {
        expect(nextStake(cfg({ stake: 0.35, martingale: { enabled: false, multiplier: 2, maxSteps: 3 } }), 5)).toBe(0.35);
    });

    it('rounds to cents', () => {
        expect(nextStake(cfg({ stake: 0.35, martingale: { enabled: true, multiplier: 1.5, maxSteps: 3 } }), 3)).toBe(1.18);
    });
});

describe('worst-case cost and the hard safety cap', () => {
    it('is bulk x stake x the sum of multiplier^k for k = 0..maxSteps', () => {
        const c = cfg({ bulkSize: 3, stake: 0.35, martingale: { enabled: true, multiplier: 2, maxSteps: 2 } });
        expect(worstCaseCost(c)).toBeCloseTo(3 * 0.35 * 7, 2);
        expect(worstCaseCost(cfg({ bulkSize: 5, stake: 1, martingale: { enabled: true, multiplier: 2, maxSteps: 3 } }))).toBe(75);
    });

    it('is one full round when martingale is off', () => {
        expect(worstCaseCost(cfg({ bulkSize: 4, stake: 2, martingale: { enabled: false, multiplier: 2, maxSteps: 3 } }))).toBe(8);
    });

    it('accepts the defaults', () => {
        expect(validateConfig(cfg())).toEqual([]);
    });

    it('refuses to start when the worst case exceeds the max loss', () => {
        const problems = validateConfig(cfg({ bulkSize: 5, stake: 1, maxLoss: 50, martingale: { enabled: true, multiplier: 2, maxSteps: 3 } }));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('Worst-case cost 75.00 exceeds your max loss 50.00');
        expect(validateConfig(cfg({ bulkSize: 5, stake: 1, maxLoss: 75, martingale: { enabled: true, multiplier: 2, maxSteps: 3 } }))).toEqual([]);
    });

    it('the High preset with default stake and limits is blocked until max loss is raised', () => {
        const high = applyRiskPreset(cfg(), 'high'); // 5 x 0.35 x 15 = 26.25 > 20
        expect(validateConfig(high)[0]).toContain('26.25');
        expect(validateConfig({ ...high, maxLoss: 30 })).toEqual([]);
    });
});

describe('validation', () => {
    it('rejects a bad bulk size', () => {
        expect(validateConfig(cfg({ bulkSize: 0 }))[0]).toContain('Bulk size');
        expect(validateConfig(cfg({ bulkSize: 11 }))[0]).toContain('Bulk size');
        expect(validateConfig(cfg({ bulkSize: 2.5 }))[0]).toContain('Bulk size');
        expect(validateConfig(cfg({ bulkSize: 10, stake: 0.35, maxLoss: 100 }))).toEqual([]);
    });

    it('rejects non-positive money fields and an unknown market or strategy', () => {
        expect(validateConfig(cfg({ stake: 0 }))).toContain('Stake must be greater than 0.');
        expect(validateConfig(cfg({ profitTarget: -1 }))).toContain('Profit target must be greater than 0.');
        expect(validateConfig(cfg({ maxLoss: 0 }))).toContain('Max loss must be greater than 0.');
        expect(validateConfig(cfg({ symbol: 'frxEURUSD' }))).toContain('Choose a volatility index.');
        expect(validateConfig(cfg({ strategyId: 'nope' }))).toContain('Choose a strategy.');
        expect(validateConfig(cfg({ stake: NaN }))).toContain('Stake must be greater than 0.');
    });

    it('rejects an out-of-range martingale only when it is enabled', () => {
        const bad = { enabled: true, multiplier: 50, maxSteps: 99 };
        expect(validateConfig(cfg({ martingale: bad })).join(' ')).toContain('multiplier');
        expect(validateConfig(cfg({ martingale: { ...bad, enabled: false } }))).toEqual([]);
    });
});

describe('saving and loading', () => {
    it('round-trips a config through storage', () => {
        const storage = memoryStorage();
        const custom = cfg({ symbol: '1HZ100V', stake: 1.25, bulkSize: 4, mode: 'live', tradeAnywayAfterMs: 5000 });
        expect(saveConfig(custom, storage)).toBe(true);
        expect(loadConfig(storage)).toEqual({ ...custom, account: 'demo' });
    });

    it('never restores Real: the account always comes back as Demo', () => {
        const storage = memoryStorage();
        saveConfig(cfg({ account: 'real', mode: 'live' }), storage);
        expect(loadConfig(storage).account).toBe('demo');
    });

    it('falls back to defaults for missing, corrupt or invalid data', () => {
        expect(loadConfig(memoryStorage())).toEqual(DEFAULT_CONFIG);
        expect(loadConfig(memoryStorage({ [STORAGE_KEY]: '{not json' }))).toEqual(DEFAULT_CONFIG);
        expect(loadConfig(memoryStorage({ [STORAGE_KEY]: '"hello"' }))).toEqual(DEFAULT_CONFIG);
        const messy = loadConfig(
            memoryStorage({
                [STORAGE_KEY]: JSON.stringify({ symbol: 'bogus', risk: 'wild', bulkSize: 'x', stake: 'abc', strategyId: 'zzz', mode: 'yolo', martingale: 5 }),
            })
        );
        expect(messy).toEqual(DEFAULT_CONFIG);
    });

    it('keeps a partial save and fills the rest with defaults', () => {
        const loaded = loadConfig(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ stake: 2, symbol: 'R_50' }) }));
        expect(loaded.stake).toBe(2);
        expect(loaded.symbol).toBe('R_50');
        expect(loaded.maxLoss).toBe(DEFAULT_CONFIG.maxLoss);
    });

    it('does not crash when storage is unavailable or throws', () => {
        expect(loadConfig(null)).toEqual(DEFAULT_CONFIG);
        expect(saveConfig(cfg(), null)).toBe(false);
        const throwing = {
            getItem: () => {
                throw new Error('denied');
            },
            setItem: () => {
                throw new Error('full');
            },
        };
        expect(loadConfig(throwing)).toEqual(DEFAULT_CONFIG);
        expect(saveConfig(cfg(), throwing)).toBe(false);
    });

    it('stores no secrets', () => {
        const storage = memoryStorage();
        saveConfig(cfg(), storage);
        expect(storage.data[STORAGE_KEY]).not.toMatch(/token|password|secret|authorize/i);
    });

    it('loading does not share the default martingale object', () => {
        const a = loadConfig(memoryStorage());
        a.martingale.multiplier = 99;
        expect(loadConfig(memoryStorage()).martingale.multiplier).toBe(DEFAULT_CONFIG.martingale.multiplier);
    });
});
