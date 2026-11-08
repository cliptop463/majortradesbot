import { DEFAULT_STRATEGY_ID, getStrategy } from './strategies';
import { validateMatchesTickCount } from './strategies/last-ticks-matches';
import type { AccountKind, BulkConfig, Risk, RunMode } from './types';

export const STORAGE_KEY = 'bulk_strategy_config_v1';

export const MARKETS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'] as const;
export const MIN_BULK = 1;
export const MAX_BULK = 10;
export const MAX_MULTIPLIER = 10;
export const MAX_STEPS = 10;

/** Presets only fill bulk size and martingale. The user can change every field afterwards. */
export const RISK_PRESETS: Record<Risk, Pick<BulkConfig, 'bulkSize' | 'martingale'>> = {
    low: { bulkSize: 1, martingale: { enabled: false, multiplier: 2, maxSteps: 2 } },
    medium: { bulkSize: 3, martingale: { enabled: true, multiplier: 2, maxSteps: 2 } },
    high: { bulkSize: 5, martingale: { enabled: true, multiplier: 2, maxSteps: 3 } },
};

export const DEFAULT_CONFIG: BulkConfig = {
    strategyId: DEFAULT_STRATEGY_ID,
    symbol: 'R_100',
    risk: 'medium',
    bulkSize: RISK_PRESETS.medium.bulkSize,
    matchesTickCount: 5,
    stake: 0.35,
    profitTarget: 5,
    maxLoss: 20,
    martingale: { ...RISK_PRESETS.medium.martingale },
    account: 'demo', // always starts on Demo
    mode: 'paper', // always starts on Paper in a fresh install
    tradeAnywayAfterMs: null, // the optional 5 s "trade anyway" timeout is OFF by default
};

export const TRADE_ANYWAY_MS = 5000;

/** Rounds in the one-tap quick test. */
export const QUICK_ROUNDS = 5;

/**
 * The one-tap test: Paper only (no orders, no money), Demo, one contract per round, the 5 s timeout on so
 * something visibly happens, and it stops itself after a few rounds. It ignores the saved settings, so a bad
 * or half-edited setup can never block it. Always valid: worst case 1.00 against a 100.00 max loss.
 */
export function quickConfig(symbol: string = DEFAULT_CONFIG.symbol): BulkConfig {
    return {
        ...DEFAULT_CONFIG,
        symbol,
        risk: 'low',
        bulkSize: 1,
        stake: 1,
        profitTarget: 100,
        maxLoss: 100,
        martingale: { enabled: false, multiplier: 2, maxSteps: 2 },
        account: 'demo',
        mode: 'paper',
        tradeAnywayAfterMs: TRADE_ANYWAY_MS,
        maxRounds: QUICK_ROUNDS,
    };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function applyRiskPreset(config: BulkConfig, risk: Risk): BulkConfig {
    const preset = RISK_PRESETS[risk];
    return { ...config, risk, bulkSize: preset.bulkSize, martingale: { ...preset.martingale } };
}

/** Stake for the next round: base * multiplier^min(lossStreak, maxSteps), or the base stake. */
export function nextStake(config: BulkConfig, lossStreak: number): number {
    if (!config.martingale.enabled) return round2(config.stake);
    const steps = Math.min(Math.max(0, lossStreak), config.martingale.maxSteps);
    return round2(config.stake * Math.pow(config.martingale.multiplier, steps));
}

/**
 * Worst-case money at risk before the max-loss stop: with martingale on, every contract of every
 * round from step 0 to maxSteps loses (bulk x stake x sum of multiplier^k); with it off, one full round.
 */
export function worstCaseCost(config: BulkConfig): number {
    const perRound = effectiveBatchSize(config) * config.stake;
    if (!config.martingale.enabled) return round2(perRound);
    let total = 0;
    for (let k = 0; k <= config.martingale.maxSteps; k++) total += perRound * Math.pow(config.martingale.multiplier, k);
    return round2(total);
}

export function effectiveBatchSize(config: BulkConfig): number {
    return getStrategy(config.strategyId)?.batchSize?.(config) ?? config.bulkSize;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Returns every reason the config cannot be started. Empty array means it is valid. */
export function validateConfig(config: BulkConfig): string[] {
    const problems: string[] = [];
    if (!getStrategy(config.strategyId)) problems.push('Choose a strategy.');
    if (!(MARKETS as readonly string[]).includes(config.symbol)) problems.push('Choose a volatility index.');
    if (
        !getStrategy(config.strategyId)?.batchSize &&
        (!Number.isInteger(config.bulkSize) || config.bulkSize < MIN_BULK || config.bulkSize > MAX_BULK)
    ) {
        problems.push(`Bulk size must be a whole number from ${MIN_BULK} to ${MAX_BULK}.`);
    }
    if (config.strategyId === 'last-ticks-matches' && !validateMatchesTickCount(config.matchesTickCount)) {
        problems.push('Number of recent tick digits must be a whole number from 1 to 10.');
    }
    if (!isNum(config.stake) || config.stake <= 0) problems.push('Stake must be greater than 0.');
    if (!isNum(config.profitTarget) || config.profitTarget <= 0) problems.push('Profit target must be greater than 0.');
    if (!isNum(config.maxLoss) || config.maxLoss <= 0) problems.push('Max loss must be greater than 0.');
    if (config.martingale.enabled) {
        if (!isNum(config.martingale.multiplier) || config.martingale.multiplier < 1 || config.martingale.multiplier > MAX_MULTIPLIER) {
            problems.push(`Martingale multiplier must be from 1 to ${MAX_MULTIPLIER}.`);
        }
        if (!Number.isInteger(config.martingale.maxSteps) || config.martingale.maxSteps < 0 || config.martingale.maxSteps > MAX_STEPS) {
            problems.push(`Martingale max steps must be a whole number from 0 to ${MAX_STEPS}.`);
        }
    }
    if (config.tradeAnywayAfterMs !== null && (!isNum(config.tradeAnywayAfterMs) || config.tradeAnywayAfterMs <= 0)) {
        problems.push('The trade-anyway timeout is invalid.');
    }
    if (config.maxRounds !== undefined && config.maxRounds !== null) {
        if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1 || config.maxRounds > 1000) {
            problems.push('Rounds must be a whole number from 1 to 1000.');
        }
    }
    if (problems.length === 0) {
        const worst = worstCaseCost(config);
        if (worst > config.maxLoss) {
            problems.push(
                `Worst-case cost ${worst.toFixed(2)} exceeds your max loss ${config.maxLoss.toFixed(
                    2
                )}. Lower the stake, bulk size or martingale, or raise the max loss.`
            );
        }
    }
    return problems;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
const num = (value: unknown, fallback: number) => (isNum(value) ? value : fallback);

/**
 * Loads the saved config. Anything missing or invalid falls back to the default.
 * The account ALWAYS comes back as Demo: Real has to be confirmed again in every new session.
 */
export function loadConfig(storage: StorageLike | null = safeStorage()): BulkConfig {
    const defaults = DEFAULT_CONFIG;
    let raw: any = null;
    try {
        const text = storage?.getItem(STORAGE_KEY);
        raw = text ? JSON.parse(text) : null;
    } catch {
        raw = null;
    }
    if (!raw || typeof raw !== 'object') return { ...defaults, martingale: { ...defaults.martingale } };

    const martingale = raw.martingale && typeof raw.martingale === 'object' ? raw.martingale : {};
    return {
        strategyId: getStrategy(raw.strategyId) ? raw.strategyId : defaults.strategyId,
        symbol: pick(raw.symbol, MARKETS, defaults.symbol as (typeof MARKETS)[number]),
        risk: pick<Risk>(raw.risk, ['low', 'medium', 'high'], defaults.risk),
        bulkSize: Number.isInteger(raw.bulkSize) ? raw.bulkSize : defaults.bulkSize,
        matchesTickCount: validateMatchesTickCount(raw.matchesTickCount) ? raw.matchesTickCount : defaults.matchesTickCount,
        stake: num(raw.stake, defaults.stake),
        profitTarget: num(raw.profitTarget, defaults.profitTarget),
        maxLoss: num(raw.maxLoss, defaults.maxLoss),
        martingale: {
            enabled: typeof martingale.enabled === 'boolean' ? martingale.enabled : defaults.martingale.enabled,
            multiplier: num(martingale.multiplier, defaults.martingale.multiplier),
            maxSteps: Number.isInteger(martingale.maxSteps) ? martingale.maxSteps : defaults.martingale.maxSteps,
        },
        account: 'demo' as AccountKind,
        mode: pick<RunMode>(raw.mode, ['paper', 'live'], defaults.mode),
        tradeAnywayAfterMs: isNum(raw.tradeAnywayAfterMs) && raw.tradeAnywayAfterMs > 0 ? raw.tradeAnywayAfterMs : null,
    };
}

/** Saves the config. Never stores tokens: the config has no secrets. Returns false when storage is unavailable. */
export function saveConfig(config: BulkConfig, storage: StorageLike | null = safeStorage()): boolean {
    try {
        if (!storage) return false;
        const { maxRounds: _quickOnly, ...persistent } = config; // the round limit belongs to the quick test only
        storage.setItem(STORAGE_KEY, JSON.stringify(persistent));
        return true;
    } catch {
        return false;
    }
}

function safeStorage(): StorageLike | null {
    try {
        return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
    } catch {
        return null;
    }
}
