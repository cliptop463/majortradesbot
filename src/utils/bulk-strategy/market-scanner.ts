import type { ContractSpec, MarketTick } from './types';
import { extractFinalDigit } from './strategies/last-ticks-matches';

/** Scanner quality gate, not a win-probability threshold. */
export const MIN_MARKET_SCORE = 0.73;
export const SCAN_HISTORY_SIZE = 1200;
export const WALK_FORWARD_EMBARGO = 5;
export const MIN_OOS_OBSERVATIONS = 30;
export const DIRECTION_WINDOWS = [5, 20, 40, 60] as const;

export type ScanStrategyId = 'tick-striker' | 'tick-striker-v4' | 'nexus-rise-fall' | 'nexus-even-odd';
export type ScanDirection = 'UP' | 'DOWN';
export type ScanParity = 'EVEN' | 'ODD';
export type ValidationStatus = 'validated' | 'insufficient data' | 'no demonstrated out-of-sample edge';

export interface WalkForwardValidation {
    status: ValidationStatus;
    trainSamples: number;
    validationSamples: number;
    outOfSampleSamples: number;
    baselineRate: number | null;
    outOfSampleRate: number | null;
    lift: number | null;
    embargo: number;
}

export interface MarketScanResult {
    symbol: string;
    strategy: ScanStrategyId;
    score: number | null;
    qualified: boolean;
    contract: ContractSpec | null;
    direction: ScanDirection | ScanParity | null;
    currentUpStreak: number;
    currentDownStreak: number;
    continuationRate: number | null;
    reversalCounts: Record<5 | 10 | 20 | 60, number>;
    directionalEfficiency: number | null;
    volatility: 'low' | 'suitable' | 'high' | 'unavailable';
    validation: WalkForwardValidation;
    rejectionReason: string | null;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const validQuote = (value: number) => Number.isFinite(value) && value > 0;
const mean = (values: readonly number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const stddev = (values: readonly number[]) => {
    const m = mean(values);
    return Math.sqrt(mean(values.map(value => (value - m) ** 2)));
};

export interface DirectionalMetrics {
    returns: number[];
    signs: number[];
    currentUpStreak: number;
    currentDownStreak: number;
    reversalCounts: Record<5 | 10 | 20 | 60, number>;
    directionalEfficiency: number;
    shortLongAgreement: number;
    volatilityRatio: number;
    fiveMoveContinuationRate: number | null;
    fiveMoveSamples: number;
}

/** Counts strict nonzero consecutive price changes. Flat prices break, rather than extend, a streak. */
export function calculateDirectionalMetrics(prices: readonly number[]): DirectionalMetrics | null {
    if (prices.length < 61 || !prices.every(validQuote)) return null;
    const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
    if (!returns.every(Number.isFinite)) return null;
    const signs = returns.map(value => Math.sign(value));
    let up = 0;
    let down = 0;
    for (let i = signs.length - 1; i >= 0; i--) {
        if (signs[i] === 1 && down === 0) up++;
        else if (signs[i] === -1 && up === 0) down++;
        else break;
    }
    const reversalCounts = {} as Record<5 | 10 | 20 | 60, number>;
    for (const window of [5, 10, 20, 60] as const) {
        const tail = signs.slice(-window);
        reversalCounts[window] = tail.slice(1).reduce((count, sign, index) =>
            count + (sign !== 0 && tail[index] !== 0 && sign !== tail[index] ? 1 : 0), 0);
    }
    const tail = returns.slice(-60);
    const total = tail.reduce((sum, value) => sum + value, 0);
    const movement = tail.reduce((sum, value) => sum + Math.abs(value), 0);
    const directionalEfficiency = movement ? Math.abs(total) / movement : 0;
    const short = returns.slice(-5).reduce((sum, value) => sum + value, 0);
    const long = returns.slice(-60).reduce((sum, value) => sum + value, 0);
    const shortLongAgreement = short === 0 || long === 0 ? 0 : Math.sign(short) === Math.sign(long) ? 1 : 0;
    const shortVol = stddev(returns.slice(-20));
    const longVol = stddev(returns.slice(-60));
    const volatilityRatio = longVol > 0 ? shortVol / longVol : shortVol === 0 ? 1 : Number.POSITIVE_INFINITY;
    const outcomes: boolean[] = [];
    // Each feature window is strictly before the next five price changes being tested.
    for (let end = 60; end + 5 < signs.length; end++) {
        const before = signs[end];
        if (before === 0) continue;
        const future = signs.slice(end + 1, end + 6);
        if (future.length === 5 && future.every(sign => sign === before)) outcomes.push(true);
        else outcomes.push(false);
    }
    return {
        returns, signs, currentUpStreak: up, currentDownStreak: down, reversalCounts,
        directionalEfficiency, shortLongAgreement, volatilityRatio,
        fiveMoveContinuationRate: outcomes.length ? outcomes.filter(Boolean).length / outcomes.length : null,
        fiveMoveSamples: outcomes.length,
    };
}

function validationForBinary(outcomes: readonly (0 | 1)[], embargo = WALK_FORWARD_EMBARGO): WalkForwardValidation {
    const trainEnd = Math.floor(outcomes.length * 0.6);
    const validationEnd = Math.floor(outcomes.length * 0.8);
    const train = outcomes.slice(0, Math.max(0, trainEnd - embargo));
    const validation = outcomes.slice(trainEnd + embargo, Math.max(trainEnd + embargo, validationEnd - embargo));
    const oos = outcomes.slice(validationEnd + embargo);
    if (train.length < MIN_OOS_OBSERVATIONS || validation.length < 10 || oos.length < MIN_OOS_OBSERVATIONS) {
        return { status: 'insufficient data', trainSamples: train.length, validationSamples: validation.length, outOfSampleSamples: oos.length, baselineRate: null, outOfSampleRate: null, lift: null, embargo };
    }
    const baseline = mean(train);
    const observed = mean(oos);
    const lift = observed - baseline;
    // Require a strictly positive chronological OOS lift. Scores never imply a probability of success.
    return { status: lift > 0 ? 'validated' : 'no demonstrated out-of-sample edge', trainSamples: train.length, validationSamples: validation.length, outOfSampleSamples: oos.length, baselineRate: baseline, outOfSampleRate: observed, lift, embargo };
}

function directionalOutcomes(prices: readonly number[], dir: 1 | -1): (0 | 1)[] {
    const signs = prices.slice(1).map((price, i) => Math.sign(Math.log(price / prices[i])));
    const rows: (0 | 1)[] = [];
    for (let i = 60; i + 5 < signs.length; i++) {
        // Sample only when the feature-time movement has a direction; forecast five future moves.
        if (signs[i] !== dir) continue;
        rows.push(signs.slice(i + 1, i + 6).every(sign => sign === dir) ? 1 : 0);
    }
    return rows;
}

function parityOf(tick: MarketTick): 0 | 1 | null {
    const digit = extractFinalDigit(tick);
    return digit === null ? null : (digit % 2) as 0 | 1;
}

function makeResult(symbol: string, strategy: ScanStrategyId, patch: Partial<MarketScanResult>): MarketScanResult {
    return {
        symbol, strategy, score: null, qualified: false, contract: null, direction: null,
        currentUpStreak: 0, currentDownStreak: 0, continuationRate: null,
        reversalCounts: { 5: 0, 10: 0, 20: 0, 60: 0 }, directionalEfficiency: null,
        volatility: 'unavailable',
        validation: { status: 'insufficient data', trainSamples: 0, validationSamples: 0, outOfSampleSamples: 0, baselineRate: null, outOfSampleRate: null, lift: null, embargo: WALK_FORWARD_EMBARGO },
        rejectionReason: null, ...patch,
    };
}

/**
 * Model score uses documented quality components, not a win-probability estimate.
 * Directional weighting: continuation 35%, efficiency 25%, reversal resistance 20%,
 * short/long agreement 10%, volatility suitability 10%. One opposing return lowers
 * reversal resistance by 1/window-length, and a fresh 5-move streak is required after
 * a direction change. Scores are clipped to [0,1] and are gated by chronological OOS checks.
 */
export function scoreMarket(symbol: string, strategy: ScanStrategyId, prices: readonly number[], marketTicks?: readonly MarketTick[]): MarketScanResult {
    const history = prices.slice(-SCAN_HISTORY_SIZE);
    if (history.length < 61 || !history.every(validQuote)) {
        return makeResult(symbol, strategy, { rejectionReason: history.some(value => !validQuote(value)) ? 'Invalid or incomplete quote history.' : 'Insufficient valid historical ticks.' });
    }
    const metrics = calculateDirectionalMetrics(history)!;
    const lowVol = metrics.volatilityRatio < 0.2;
    const highVol = metrics.volatilityRatio > 2.5;
    const volatility: MarketScanResult['volatility'] = lowVol ? 'low' : highVol ? 'high' : 'suitable';

    if (strategy === 'nexus-even-odd') {
        if (!marketTicks || marketTicks.length < 100 || marketTicks.some(tick => parityOf(tick) === null)) {
            return makeResult(symbol, strategy, { rejectionReason: 'Need at least 100 quotes with valid pip_size precision metadata.' });
        }
        const parity = marketTicks.slice(-SCAN_HISTORY_SIZE).map(tick => parityOf(tick) as 0 | 1);
        const labels = parity.slice(0, -1);
        const outcomes = parity.slice(1);
        const validation = validationForBinary(outcomes);
        const even = parity.filter(value => value === 0).length / parity.length;
        const odd = 1 - even;
        const pick: 0 | 1 = even >= odd ? 0 : 1;
        const oos = outcomes.slice(Math.floor(outcomes.length * 0.8) + WALK_FORWARD_EMBARGO);
        const correctness = oos.length ? oos.filter(value => value === pick).length / oos.length : null;
        const score = correctness === null ? null : clamp01(0.5 + (correctness - 0.5));
        const qualified = validation.status === 'validated' && validation.outOfSampleSamples >= MIN_OOS_OBSERVATIONS && score !== null && score >= MIN_MARKET_SCORE;
        return makeResult(symbol, strategy, {
            score, qualified, direction: pick === 0 ? 'EVEN' : 'ODD',
            contract: { contract_type: pick === 0 ? 'DIGITEVEN' : 'DIGITODD', duration: 1, duration_unit: 't' },
            volatility, validation,
            rejectionReason: qualified ? null : validation.status !== 'validated' ? validation.status : 'Parity evidence did not reach the 0.73 quality gate.',
        });
    }

    if (strategy === 'tick-striker' || strategy === 'tick-striker-v4') {
        // Exact TICKHIGH target: future tick five is strictly above future ticks one through four.
        const outcomes: (0 | 1)[] = [];
        for (let end = 60; end + 5 < history.length; end++) {
            const future = history.slice(end + 1, end + 6);
            outcomes.push(future[4] > Math.max(...future.slice(0, 4)) ? 1 : 0);
        }
        const validation = validationForBinary(outcomes);
        const score = validation.outOfSampleRate;
        const qualified = validation.status === 'validated' && score !== null && score >= MIN_MARKET_SCORE;
        return makeResult(symbol, strategy, {
            score, qualified,
            contract: { contract_type: 'TICKHIGH', duration: 5, duration_unit: 't', selected_tick: 5 },
            currentUpStreak: metrics.currentUpStreak, currentDownStreak: metrics.currentDownStreak,
            reversalCounts: metrics.reversalCounts, directionalEfficiency: metrics.directionalEfficiency,
            continuationRate: metrics.fiveMoveContinuationRate, volatility, validation,
            rejectionReason: qualified ? null : validation.status !== 'validated' ? validation.status : 'Chronological TICKHIGH quality score is below 0.73.',
        });
    }

    const direction: ScanDirection | null = metrics.currentUpStreak >= 5 ? 'UP' : metrics.currentDownStreak >= 5 ? 'DOWN' : null;
    const dir = direction === 'UP' ? 1 : -1;
    const outcomes = directionalOutcomes(history, dir);
    const validation = direction ? validationForBinary(outcomes) : validationForBinary([]);
    const continuation = validation.outOfSampleRate;
    const resistance = clamp01(1 - metrics.reversalCounts[20] / 19);
    const volatilityQuality = lowVol || highVol ? 0 : clamp01(1 - Math.abs(metrics.volatilityRatio - 1) / 1.5);
    const score = direction && continuation !== null
        ? clamp01(0.35 * continuation + 0.25 * metrics.directionalEfficiency + 0.20 * resistance + 0.10 * metrics.shortLongAgreement + 0.10 * volatilityQuality)
        : null;
    const contract: ContractSpec | null = direction ? { contract_type: direction === 'UP' ? 'CALL' : 'PUT', duration: 1, duration_unit: 't' } : null;
    const qualified = Boolean(direction && validation.status === 'validated' && validation.outOfSampleSamples >= MIN_OOS_OBSERVATIONS && !lowVol && !highVol && score !== null && score >= MIN_MARKET_SCORE);
    return makeResult(symbol, strategy, {
        score, qualified, contract, direction, currentUpStreak: metrics.currentUpStreak, currentDownStreak: metrics.currentDownStreak,
        continuationRate: metrics.fiveMoveContinuationRate, reversalCounts: metrics.reversalCounts,
        directionalEfficiency: metrics.directionalEfficiency, volatility, validation,
        rejectionReason: qualified ? null : !direction ? 'Need a fresh uninterrupted five-movement directional streak.' : validation.status !== 'validated' ? validation.status : 'Directional quality score is below 0.73 or volatility is unsuitable.',
    });
}

/** Stable deterministic sorting: qualified first, then score, OOS lift, reversal resistance, reliability, symbol. */
export function rankMarkets(results: readonly MarketScanResult[]): MarketScanResult[] {
    return [...results].sort((a, b) => Number(b.qualified) - Number(a.qualified)
        || (b.score ?? -1) - (a.score ?? -1)
        || (b.validation.lift ?? -Infinity) - (a.validation.lift ?? -Infinity)
        || (1 - b.reversalCounts[20] / 19) - (1 - a.reversalCounts[20] / 19)
        || b.validation.outOfSampleSamples - a.validation.outOfSampleSamples
        || a.symbol.localeCompare(b.symbol));
}

export function bestQualifiedMarket(results: readonly MarketScanResult[]): MarketScanResult | null {
    return rankMarkets(results).find(result => result.qualified) ?? null;
}

/** Bounded worker pool; one unavailable market never aborts the remaining scans. */
export async function scanMarkets(
    symbols: readonly string[], strategy: ScanStrategyId,
    fetchHistory: (symbol: string, count: number) => Promise<{ prices: unknown[]; pipSize?: number | null }>,
    concurrency = 3,
): Promise<MarketScanResult[]> {
    const results = new Array<MarketScanResult>(symbols.length);
    let cursor = 0;
    const worker = async () => {
        while (true) {
            const index = cursor++;
            if (index >= symbols.length) return;
            const symbol = symbols[index];
            try {
                const response = await fetchHistory(symbol, SCAN_HISTORY_SIZE);
                const prices = response.prices.map(value => typeof value === 'number' ? value : Number(value));
                const marketTicks = Number.isInteger(response.pipSize) && response.pipSize! >= 0 && response.pipSize! <= 12
                    ? prices.map((quote, sequence) => ({ quote, pipSize: response.pipSize!, sequence }))
                    : undefined;
                results[index] = scoreMarket(symbol, strategy, prices, marketTicks);
            } catch (error) {
                results[index] = makeResult(symbol, strategy, { rejectionReason: error instanceof Error ? error.message : String(error) });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(concurrency) || 1, symbols.length || 1)) }, worker));
    return rankMarkets(results);
}
