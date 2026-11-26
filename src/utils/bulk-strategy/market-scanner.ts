import type { ContractSpec, MarketTick } from './types';
import { extractFinalDigit } from './strategies/last-ticks-matches';

/** Composite rank score; explicitly not a calibrated win probability. */
export const MIN_MARKET_SCORE = 0.73; // retained as a legacy constant; it is no longer an eligibility gate.
export const SCAN_HISTORY_SIZE = 1200;
export const WALK_FORWARD_EMBARGO = 5;
export const MIN_TRAIN_OBSERVATIONS = 10;
export const MIN_VALIDATION_OBSERVATIONS = 10;
export const MIN_OOS_OBSERVATIONS = 10;
export const DIRECTION_WINDOWS = [5, 20, 40, 60] as const;
export const REVERSAL_PENALTY_PER_MOVE = 0.04;
export const REVERSAL_DECAY_PER_TICK = 0.98;
export const VOLATILITY_LIMITS = { minNormalizedMove: 0.000001, maxNormalizedMove: 0.02, maxRecentToBaselineRatio: 2.5, minRecentToBaselineRatio: 0.2 } as const;

export type ScanStrategyId = 'tick-striker' | 'tick-striker-v4' | 'nexus-rise-fall' | 'nexus-even-odd';
export type ScanDirection = 'UP' | 'DOWN';
export type ScanParity = 'EVEN' | 'ODD';
export type VolatilityRegime = 'low' | 'suitable' | 'excessive' | 'unavailable';
export type ValidationStatus = 'validated' | 'insufficient data' | 'no demonstrated out-of-sample edge';
export interface WalkForwardValidation {
    status: ValidationStatus; trainSamples: number; validationSamples: number; outOfSampleSamples: number;
    baselineRate: number | null; validationRate: number | null; outOfSampleRate: number | null; lift: number | null;
    embargo: number; trainTickEnd: number; validationTickEnd: number;
}
export interface ScoreComponents {
    continuationEvidence: number | null; directionalEfficiency: number | null; reversalResistance: number | null;
    multiWindowAgreement: number | null; volatilitySuitability: number | null; sampleReliability: number | null;
    validationQuality: number | null; contributions: Partial<Record<keyof Omit<ScoreComponents, 'contributions'>, number>>;
}
export interface MarketScanResult {
    symbol: string; strategy: ScanStrategyId; score: number | null; qualified: boolean; contract: ContractSpec | null;
    direction: ScanDirection | ScanParity | null; currentUpStreak: number; currentDownStreak: number;
    consecutiveOpposingMoves: number; confirmedReversal: boolean; continuationRate: number | null;
    reversalCounts: Record<5 | 10 | 20 | 40 | 60, number>; directionalEfficiency: number | null;
    volatility: VolatilityRegime; validation: WalkForwardValidation; scoreComponents: ScoreComponents;
    rejectionReason: string | null; evaluatedAtTick: number;
}
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const validQuote = (value: number) => Number.isFinite(value) && value > 0;
const mean = (values: readonly number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const stddev = (values: readonly number[]) => {
    if (!values.length) return 0;
    const average = mean(values);
    return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
};
const EMPTY_COMPONENTS: ScoreComponents = { continuationEvidence: null, directionalEfficiency: null, reversalResistance: null, multiWindowAgreement: null, volatilitySuitability: null, sampleReliability: null, validationQuality: null, contributions: {} };

export interface DirectionalMetrics {
    returns: number[]; signs: number[]; currentUpStreak: number; currentDownStreak: number;
    consecutiveOpposingMoves: number; confirmedReversal: boolean; reversalCounts: Record<5 | 10 | 20 | 40 | 60, number>;
    directionalEfficiency: number; shortAgreement: number; longAgreement: number; volatilityRatio: number;
    normalizedAbsoluteMove: number; rollingVolatilityBaseline: number; volatilityRegime: VolatilityRegime;
    recentReversalSeverity: number; fiveMoveContinuationRate: number | null; fiveMoveSamples: number;
    upScore: number; downScore: number; windowDirections: Record<5 | 20 | 40 | 60, ScanDirection | null>;
}

/** Existing rolling direction model: exact nonzero streaks, four nested windows and monotonic opposing-tick decay. */
export function calculateDirectionalMetrics(prices: readonly number[]): DirectionalMetrics | null {
    if (prices.length < 61 || !prices.every(validQuote)) return null;
    const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
    if (!returns.every(Number.isFinite)) return null;
    const signs = returns.map(Math.sign);
    const runLength = (sign: number) => { let n = 0; for (let i = signs.length - 1; i >= 0 && signs[i] === sign; i--) n++; return n; };
    const currentUpStreak = runLength(1), currentDownStreak = runLength(-1), tail = signs[signs.length - 1];
    let prior = 0;
    for (let i = signs.length - 2; i >= 0; i--) if (signs[i] !== 0) { prior = signs[i]; break; }
    const consecutiveOpposingMoves = tail && prior && tail !== prior ? runLength(tail) : 0;
    const reversalCounts = {} as Record<5 | 10 | 20 | 40 | 60, number>;
    for (const window of [5, 10, 20, 40, 60] as const) {
        const sample = signs.slice(-window);
        reversalCounts[window] = sample.slice(1).reduce((n, sign, i) => n + (sign !== 0 && sample[i] !== 0 && sign !== sample[i] ? 1 : 0), 0);
    }
    const directionFor = (window: number): ScanDirection | null => {
        const total = returns.slice(-window).reduce((a, b) => a + b, 0);
        return total > 0 ? 'UP' : total < 0 ? 'DOWN' : null;
    };
    const windowDirections = { 5: directionFor(5), 20: directionFor(20), 40: directionFor(40), 60: directionFor(60) };
    const last60 = returns.slice(-60), net60 = last60.reduce((a, b) => a + b, 0), gross60 = last60.reduce((a, b) => a + Math.abs(b), 0);
    const directionalEfficiency = gross60 ? Math.abs(net60) / gross60 : 0;
    const direction = currentUpStreak ? 'UP' : currentDownStreak ? 'DOWN' : null;
    const agreement = (windows: readonly (5 | 20 | 40 | 60)[]) => direction ? windows.filter(w => windowDirections[w] === direction).length / windows.length : 0;
    const recentVol = stddev(returns.slice(-20)), rollingVolatilityBaseline = stddev(returns.slice(-60));
    const volatilityRatio = rollingVolatilityBaseline > 0 ? recentVol / rollingVolatilityBaseline : 0;
    const normalizedAbsoluteMove = mean(returns.slice(-20).map(Math.abs));
    const priorVol = stddev(returns.slice(-60, -20));
    const unstable = priorVol > 0 && recentVol / priorVol > VOLATILITY_LIMITS.maxRecentToBaselineRatio;
    let volatilityRegime: VolatilityRegime = 'suitable';
    if (!Number.isFinite(normalizedAbsoluteMove) || !Number.isFinite(volatilityRatio)) volatilityRegime = 'unavailable';
    else if (normalizedAbsoluteMove < VOLATILITY_LIMITS.minNormalizedMove || volatilityRatio < VOLATILITY_LIMITS.minRecentToBaselineRatio) volatilityRegime = 'low';
    else if (normalizedAbsoluteMove > VOLATILITY_LIMITS.maxNormalizedMove || volatilityRatio > VOLATILITY_LIMITS.maxRecentToBaselineRatio || unstable) volatilityRegime = 'excessive';
    const recent = signs.slice(-20);
    const recentReversalSeverity = recent.reduce((sum, sign, i) => i > 0 && sign && recent[i - 1] && sign !== recent[i - 1] ? sum + Math.abs(returns[returns.length - 20 + i]) : sum, 0);
    const continuation: boolean[] = [];
    for (let i = 60; i + 5 < signs.length; i++) if (signs[i] !== 0) continuation.push(signs.slice(i + 1, i + 6).every(sign => sign === signs[i]));
    const oppositionPenalty = (n: number) => Math.pow(REVERSAL_DECAY_PER_TICK, n) * Math.max(0, 1 - REVERSAL_PENALTY_PER_MOVE * n);
    const reversalResistance = (1 - reversalCounts[20] / 19);
    const upBase = clamp01(0.35 * currentUpStreak / 5 + 0.25 * directionalEfficiency + 0.20 * agreement([5, 20, 40, 60]) + 0.20 * reversalResistance);
    const downAgreement = currentDownStreak ? agreement([5, 20, 40, 60]) : windowDirections[5] === 'DOWN' && windowDirections[20] === 'DOWN' ? 0.5 : 0;
    const downBase = clamp01(0.35 * currentDownStreak / 5 + 0.25 * directionalEfficiency + 0.20 * downAgreement + 0.20 * reversalResistance);
    return {
        returns, signs, currentUpStreak, currentDownStreak, consecutiveOpposingMoves, confirmedReversal: consecutiveOpposingMoves >= 2,
        reversalCounts, directionalEfficiency, shortAgreement: agreement([5, 20]), longAgreement: agreement([20, 40, 60]),
        volatilityRatio, normalizedAbsoluteMove, rollingVolatilityBaseline, volatilityRegime, recentReversalSeverity,
        fiveMoveContinuationRate: continuation.length ? continuation.filter(Boolean).length / continuation.length : null,
        fiveMoveSamples: continuation.length,
        upScore: clamp01(upBase * oppositionPenalty(currentUpStreak ? reversalCounts[20] : Math.max(1, currentDownStreak))),
        downScore: clamp01(downBase * oppositionPenalty(currentDownStreak ? reversalCounts[20] : Math.max(1, currentUpStreak))),
        windowDirections,
    };
}

export interface IndexedOutcome { featureEnd: number; targetEnd: number; outcome: 0 | 1; }
export interface WalkForwardOptions { featureLookback: number; horizon: number; embargo?: number; minTrain?: number; minValidation?: number; minOos?: number; }
export interface PartitionedSamples { train: IndexedOutcome[]; validation: IndexedOutcome[]; outOfSample: IndexedOutcome[]; trainTickEnd: number; validationTickEnd: number; }
/** Partitions original tick indices before samples; target windows cannot cross partitions. */
export function partitionWalkForwardSamples(tickCount: number, makeOutcome: (featureEnd: number) => 0 | 1 | null, options: WalkForwardOptions): PartitionedSamples {
    const { featureLookback, horizon } = options, embargo = options.embargo ?? WALK_FORWARD_EMBARGO;
    const trainTickEnd = Math.floor(tickCount * 0.6), validationTickEnd = Math.floor(tickCount * 0.8);
    const partitions = [{ start: 0, end: trainTickEnd, key: 'train' as const }, { start: trainTickEnd, end: validationTickEnd, key: 'validation' as const }, { start: validationTickEnd, end: tickCount, key: 'outOfSample' as const }];
    const result: PartitionedSamples = { train: [], validation: [], outOfSample: [], trainTickEnd, validationTickEnd };
    for (const part of partitions) for (let featureEnd = Math.max(part.start + featureLookback - 1, 0); featureEnd + horizon < part.end; featureEnd++) {
        if (part.key !== 'train' && featureEnd < part.start + embargo) continue;
        const outcome = makeOutcome(featureEnd);
        if (outcome !== null) result[part.key].push({ featureEnd, targetEnd: featureEnd + horizon, outcome });
    }
    return result;
}
export function validateChronologically(tickCount: number, makeOutcome: (featureEnd: number) => 0 | 1 | null, options: WalkForwardOptions): { validation: WalkForwardValidation; partitions: PartitionedSamples } {
    const partitions = partitionWalkForwardSamples(tickCount, makeOutcome, options);
    const { train, validation, outOfSample: oos } = partitions, embargo = options.embargo ?? WALK_FORWARD_EMBARGO;
    const result = (status: ValidationStatus, baselineRate: number | null = null, validationRate: number | null = null, outOfSampleRate: number | null = null, lift: number | null = null): WalkForwardValidation => ({
        status, trainSamples: train.length, validationSamples: validation.length, outOfSampleSamples: oos.length,
        baselineRate, validationRate, outOfSampleRate, lift, embargo, trainTickEnd: partitions.trainTickEnd, validationTickEnd: partitions.validationTickEnd,
    });
    if (train.length < (options.minTrain ?? MIN_TRAIN_OBSERVATIONS) || validation.length < (options.minValidation ?? MIN_VALIDATION_OBSERVATIONS) || oos.length < (options.minOos ?? MIN_OOS_OBSERVATIONS)) return { validation: result('insufficient data'), partitions };
    const baseline = mean(train.map(row => row.outcome)), validationRate = mean(validation.map(row => row.outcome)), oosRate = mean(oos.map(row => row.outcome)), lift = oosRate - baseline;
    return { validation: result(validationRate > baseline && lift > 0 ? 'validated' : 'no demonstrated out-of-sample edge', baseline, validationRate, oosRate, lift), partitions };
}
function emptyValidation(): WalkForwardValidation {
    return { status: 'insufficient data', trainSamples: 0, validationSamples: 0, outOfSampleSamples: 0, baselineRate: null, validationRate: null, outOfSampleRate: null, lift: null, embargo: WALK_FORWARD_EMBARGO, trainTickEnd: 0, validationTickEnd: 0 };
}
function emptyComponents(): ScoreComponents { return { ...EMPTY_COMPONENTS, contributions: {} }; }
function makeResult(symbol: string, strategy: ScanStrategyId, patch: Partial<MarketScanResult>): MarketScanResult {
    return { symbol, strategy, score: null, qualified: false, contract: null, direction: null, currentUpStreak: 0, currentDownStreak: 0,
        consecutiveOpposingMoves: 0, confirmedReversal: false, continuationRate: null, reversalCounts: { 5: 0, 10: 0, 20: 0, 40: 0, 60: 0 },
        directionalEfficiency: null, volatility: 'unavailable', validation: emptyValidation(), scoreComponents: emptyComponents(), rejectionReason: null, evaluatedAtTick: 0, ...patch };
}
function parityOf(tick: MarketTick): 0 | 1 | null {
    if (!validQuote(tick.quote) || !Number.isInteger(tick.pipSize) || tick.pipSize === null || tick.pipSize < 0 || tick.pipSize > 12) return null;
    const digit = extractFinalDigit(tick); return digit === null ? null : (digit % 2) as 0 | 1;
}
function reliability(count: number): number | null { return count > 0 ? clamp01(count / 30) : null; }
/** Missing evidence contributes a documented neutral 0.5 to the composite only; raw validation fields remain null. */
function evidence(value: number | null): number { return value === null || !Number.isFinite(value) ? 0.5 : clamp01(value); }
function combine(components: ScoreComponents, weights: Record<keyof Omit<ScoreComponents, 'contributions'>, number>): number | null {
    if (Object.entries(weights).some(([key]) => components[key as keyof Omit<ScoreComponents, 'contributions'>] === null && key !== 'continuationEvidence' && key !== 'sampleReliability' && key !== 'validationQuality')) return null;
    const contributions: ScoreComponents['contributions'] = {};
    for (const key of Object.keys(weights) as Array<keyof Omit<ScoreComponents, 'contributions'>>) {
        const raw = components[key];
        const value = raw === null && (key === 'continuationEvidence' || key === 'sampleReliability' || key === 'validationQuality') ? 0.5 : raw;
        if (value === null || !Number.isFinite(value)) return null;
        contributions[key] = value * weights[key];
    }
    components.contributions = contributions;
    return clamp01(Object.values(contributions).reduce((sum, value) => sum + (value ?? 0), 0));
}
const TICKHIGH_CONTRACT: ContractSpec = { contract_type: 'TICKHIGH', duration: 5, duration_unit: 't', selected_tick: 5 };

export function scoreMarket(symbol: string, strategy: ScanStrategyId, prices: readonly number[], marketTicks?: readonly MarketTick[]): MarketScanResult {
    const history = prices.slice(-SCAN_HISTORY_SIZE);
    if (history.length < 120 || !history.every(validQuote)) return makeResult(symbol, strategy, { evaluatedAtTick: prices.length,
        rejectionReason: history.some(value => !validQuote(value)) ? 'Invalid quote in market history.' : 'Insufficient valid historical ticks (need 120).' });
    const metrics = calculateDirectionalMetrics(history);
    if (!metrics) return makeResult(symbol, strategy, { rejectionReason: 'Insufficient valid data for directional windows.' });
    const common = { evaluatedAtTick: prices.length, currentUpStreak: metrics.currentUpStreak, currentDownStreak: metrics.currentDownStreak,
        consecutiveOpposingMoves: metrics.consecutiveOpposingMoves, confirmedReversal: metrics.confirmedReversal, reversalCounts: metrics.reversalCounts,
        directionalEfficiency: metrics.directionalEfficiency, volatility: metrics.volatilityRegime, continuationRate: metrics.fiveMoveContinuationRate };

    if (strategy === 'nexus-even-odd') {
        if (!marketTicks || marketTicks.length !== prices.length || marketTicks.length < 120 || marketTicks.some(tick => parityOf(tick) === null))
            return makeResult(symbol, strategy, { ...common, rejectionReason: 'Invalid/incomplete quotes or missing/invalid precision metadata.' });
        const timeline = marketTicks.slice(-SCAN_HISTORY_SIZE), trainEnd = Math.floor(timeline.length * 0.6);
        const counts = [0, 0];
        for (let i = 0; i + 1 < trainEnd; i++) { const parity = parityOf(timeline[i]); if (parity !== null) counts[parity]++; }
        const pick: 0 | 1 = counts[0] >= counts[1] ? 0 : 1;
        const generated = validateChronologically(timeline.length, end => end + 1 < timeline.length ? parityOf(timeline[end + 1]) : null, { featureLookback: 1, horizon: 1 });
        const raw = generated.validation;
        const validationRate = generated.partitions.validation.length ? mean(generated.partitions.validation.map(row => Number(row.outcome === pick))) : null;
        const baseline = generated.partitions.train.length ? mean(generated.partitions.train.map(row => Number(row.outcome === pick))) : null;
        const oosRate = generated.partitions.outOfSample.length ? mean(generated.partitions.outOfSample.map(row => Number(row.outcome === pick))) : null;
        const lift = baseline !== null && oosRate !== null ? oosRate - baseline : null;
        const validation: WalkForwardValidation = { ...raw, baselineRate: baseline, validationRate, outOfSampleRate: oosRate, lift };
        const components: ScoreComponents = { continuationEvidence: oosRate, directionalEfficiency: null, reversalResistance: null, multiWindowAgreement: null, volatilitySuitability: null, sampleReliability: reliability(generated.partitions.outOfSample.length), validationQuality: validation.status === 'validated' ? 1 : null, contributions: {} };
        const score = combine(components, { continuationEvidence: 0.7, directionalEfficiency: 0, reversalResistance: 0, multiWindowAgreement: 0, volatilitySuitability: 0, sampleReliability: 0.15, validationQuality: 0.15 });
        const contract = { contract_type: pick === 0 ? 'DIGITEVEN' : 'DIGITODD', duration: 1, duration_unit: 't' as const };
        const candidate = score !== null && Boolean(contract.contract_type);
        return makeResult(symbol, strategy, { ...common, score, qualified: candidate, direction: pick === 0 ? 'EVEN' : 'ODD', contract, validation, scoreComponents: components,
            rejectionReason: candidate ? validation.status === 'validated' ? null : `Rankable; validation ${validation.status}.` : 'No usable parity candidate.' });
    }

    const isTickHigh = strategy === 'tick-striker' || strategy === 'tick-striker-v4';
    const generated = validateChronologically(history.length, end => {
        if (isTickHigh) { const future = history.slice(end + 1, end + 6); return future.length === 5 ? (future[4] > Math.max(...future.slice(0, 4)) ? 1 : 0) : null; }
        const previousSign = Math.sign(Math.log(history[end] / history[end - 1]));
        if (!previousSign || end + 5 >= history.length) return null;
        const future = history.slice(end + 1, end + 6).map((price, index, array) => Math.sign(Math.log(price / (index === 0 ? history[end] : array[index - 1]))));
        return future.every(sign => sign === previousSign) ? 1 : 0;
    }, { featureLookback: 60, horizon: 5 });
    const validation = generated.validation;
    if (isTickHigh) {
        const components: ScoreComponents = { ...EMPTY_COMPONENTS, continuationEvidence: validation.outOfSampleRate,
            sampleReliability: reliability(validation.outOfSampleSamples), validationQuality: validation.status === 'validated' ? 1 : null, contributions: {} };
        const score = combine(components, { continuationEvidence: 0.7, directionalEfficiency: 0, reversalResistance: 0, multiWindowAgreement: 0, volatilitySuitability: 0, sampleReliability: 0.15, validationQuality: 0.15 });
        const candidate = score !== null;
        return makeResult(symbol, strategy, { ...common, contract: { ...TICKHIGH_CONTRACT }, score, qualified: candidate, validation, scoreComponents: components,
            rejectionReason: candidate ? validation.status === 'validated' ? null : `Rankable; validation ${validation.status}.` : 'No usable TICKHIGH score.' });
    }

    const trainUp = generated.partitions.train.filter(row => Math.sign(Math.log(history[row.featureEnd] / history[row.featureEnd - 1])) === 1).length;
    const trainDown = generated.partitions.train.filter(row => Math.sign(Math.log(history[row.featureEnd] / history[row.featureEnd - 1])) === -1).length;
    const direction: ScanDirection | null = metrics.currentUpStreak >= 5 ? 'UP' : metrics.currentDownStreak >= 5 ? 'DOWN' : null;
    const trainDirection: ScanDirection = trainUp >= trainDown ? 'UP' : 'DOWN';
    const rowsForDirection = (rows: IndexedOutcome[]) => rows.filter(row => Math.sign(Math.log(history[row.featureEnd] / history[row.featureEnd - 1])) === (trainDirection === 'UP' ? 1 : -1));
    const trainRows = rowsForDirection(generated.partitions.train), validationRows = rowsForDirection(generated.partitions.validation), oosRows = rowsForDirection(generated.partitions.outOfSample);
    const baseline = trainRows.length ? mean(trainRows.map(row => row.outcome)) : null;
    const validationRate = validationRows.length ? mean(validationRows.map(row => row.outcome)) : null;
    const oosRate = oosRows.length ? mean(oosRows.map(row => row.outcome)) : null;
    const lift = baseline !== null && oosRate !== null ? oosRate - baseline : null;
    const validationStatus: ValidationStatus = trainRows.length < MIN_TRAIN_OBSERVATIONS || validationRows.length < MIN_VALIDATION_OBSERVATIONS || oosRows.length < MIN_OOS_OBSERVATIONS ? 'insufficient data' : validationRate! > baseline! && lift! > 0 ? 'validated' : 'no demonstrated out-of-sample edge';
    const directionalValidation = { ...validation, status: validationStatus, baselineRate: baseline, validationRate, outOfSampleRate: oosRate, lift,
        trainSamples: trainRows.length, validationSamples: validationRows.length, outOfSampleSamples: oosRows.length };
    const opposing = trainDirection === 'UP' ? metrics.currentDownStreak : metrics.currentUpStreak;
    const components: ScoreComponents = {
        continuationEvidence: oosRate,
        directionalEfficiency: metrics.directionalEfficiency,
        reversalResistance: clamp01(1 - metrics.reversalCounts[20] / 19) * Math.pow(REVERSAL_DECAY_PER_TICK, opposing),
        multiWindowAgreement: direction ? [5, 20, 40, 60].filter(w => metrics.windowDirections[w as 5 | 20 | 40 | 60] === direction).length / 4 : null,
        volatilitySuitability: metrics.volatilityRegime === 'unavailable' ? null : metrics.volatilityRegime === 'suitable' ? 1 : 0,
        sampleReliability: reliability(oosRows.length), validationQuality: validationStatus === 'validated' ? 1 : null, contributions: {},
    };
    const score = combine(components, { continuationEvidence: 0.35, directionalEfficiency: 0.15, reversalResistance: 0.15, multiWindowAgreement: 0.10, volatilitySuitability: 0.10, sampleReliability: 0.075, validationQuality: 0.075 });
    const contract = direction ? { contract_type: direction === 'UP' ? 'CALL' : 'PUT', duration: 1, duration_unit: 't' as const } : null;
    const candidate = score !== null && contract !== null && !metrics.confirmedReversal;
    return makeResult(symbol, strategy, { ...common, score, qualified: candidate, contract, direction, validation: directionalValidation, scoreComponents: components,
        rejectionReason: candidate ? validationStatus === 'validated' ? null : `Rankable; validation ${validationStatus}.` : metrics.confirmedReversal ? 'Confirmed reversal; wait for fresh confirmation.' : !direction ? 'Need five uninterrupted directional moves to select a Rise/Fall contract.' : 'Required score evidence is unavailable.' });
}

/** Freshness helper is independent of the historical rank score; caller re-evaluates for each live tick. */
export function isFreshRankedCandidate(result: MarketScanResult, currentTickIndex: number, maximumAge = 1): boolean {
    return result.qualified && result.score !== null && Number.isFinite(result.score)
        && result.contract !== null && currentTickIndex >= result.evaluatedAtTick && currentTickIndex - result.evaluatedAtTick <= maximumAge;
}

/** Descending composite-score ordering with stable evidence and symbol tie-breakers. */
export function rankMarkets(results: readonly MarketScanResult[]): MarketScanResult[] {
    return [...results].filter(row => row.score !== null && Number.isFinite(row.score) && row.contract !== null)
        .sort((a, b) => (b.score! - a.score!)
            || (b.validation.lift ?? -Infinity) - (a.validation.lift ?? -Infinity)
            || b.validation.outOfSampleSamples - a.validation.outOfSampleSamples
            || (b.scoreComponents.reversalResistance ?? -1) - (a.scoreComponents.reversalResistance ?? -1)
            || Number(b.volatility === 'suitable') - Number(a.volatility === 'suitable')
            || a.symbol.localeCompare(b.symbol));
}
/** Compatibility name: returns the highest-ranked usable candidate, without a probability threshold. */
export function bestQualifiedMarket(results: readonly MarketScanResult[]): MarketScanResult | null {
    return rankMarkets(results)[0] ?? null;
}
export const bestRankedMarket = bestQualifiedMarket;

export async function scanMarkets(symbols: readonly string[], strategy: ScanStrategyId,
    fetchHistory: (symbol: string, count: number) => Promise<{ prices: unknown[]; pipSize?: number | null }>, concurrency = 3): Promise<MarketScanResult[]> {
    const results = new Array<MarketScanResult>(symbols.length); let cursor = 0;
    const worker = async () => {
        while (true) {
            const index = cursor++;
            if (index >= symbols.length) return;
            const symbol = symbols[index];
            try {
                const response = await fetchHistory(symbol, SCAN_HISTORY_SIZE);
                const prices = response.prices.map(value => typeof value === 'number' ? value : Number(value));
                const precisionValid = Number.isInteger(response.pipSize) && response.pipSize! >= 0 && response.pipSize! <= 12;
                const marketTicks = precisionValid ? prices.map((quote, sequence) => ({ quote, pipSize: response.pipSize!, sequence })) : undefined;
                results[index] = scoreMarket(symbol, strategy, prices, marketTicks);
            } catch (error) {
                results[index] = makeResult(symbol, strategy, { rejectionReason: error instanceof Error ? error.message : String(error) });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(concurrency) || 1, symbols.length || 1)) }, worker));
    return rankMarkets(results);
}
