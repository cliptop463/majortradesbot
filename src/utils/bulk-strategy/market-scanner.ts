import type { ContractSpec, MarketTick } from './types';
import { extractFinalDigit } from './strategies/last-ticks-matches';

/** Composite quality threshold; never a calibrated probability or guaranteed win rate. */
export const MIN_MARKET_SCORE = 0.73;
export const SCAN_HISTORY_SIZE = 1200;
export const WALK_FORWARD_EMBARGO = 5;
export const MIN_OOS_OBSERVATIONS = 30;
export const MIN_TRAIN_OBSERVATIONS = 30;
export const MIN_VALIDATION_OBSERVATIONS = 20;
export const DIRECTION_WINDOWS = [5, 20, 40, 60] as const;

export const REVERSAL_PENALTY_PER_MOVE = 0.04;
export const REVERSAL_DECAY_PER_TICK = 0.98;
export const VOLATILITY_LIMITS = {
    minNormalizedMove: 0.000001,
    maxNormalizedMove: 0.02,
    maxRecentToBaselineRatio: 2.5,
    minRecentToBaselineRatio: 0.2,
} as const;

export type ScanStrategyId = 'tick-striker' | 'tick-striker-v4' | 'nexus-rise-fall' | 'nexus-even-odd';
export type ScanDirection = 'UP' | 'DOWN';
export type ScanParity = 'EVEN' | 'ODD';
export type VolatilityRegime = 'low' | 'suitable' | 'excessive' | 'unavailable';
export type ValidationStatus = 'validated' | 'insufficient data' | 'no demonstrated out-of-sample edge';

export interface WalkForwardValidation {
    status: ValidationStatus;
    trainSamples: number;
    validationSamples: number;
    outOfSampleSamples: number;
    baselineRate: number | null;
    validationRate: number | null;
    outOfSampleRate: number | null;
    lift: number | null;
    embargo: number;
    trainTickEnd: number;
    validationTickEnd: number;
}

export interface ScoreComponents {
    continuationEvidence: number | null;
    directionalEfficiency: number | null;
    reversalResistance: number | null;
    multiWindowAgreement: number | null;
    volatilitySuitability: number | null;
    sampleReliability: number | null;
    validationQuality: number | null;
    contributions: Partial<Record<keyof Omit<ScoreComponents, 'contributions'>, number>>;
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
    consecutiveOpposingMoves: number;
    confirmedReversal: boolean;
    continuationRate: number | null;
    reversalCounts: Record<5 | 10 | 20 | 40 | 60, number>;
    directionalEfficiency: number | null;
    volatility: VolatilityRegime;
    validation: WalkForwardValidation;
    scoreComponents: ScoreComponents;
    rejectionReason: string | null;
    evaluatedAtTick: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const validQuote = (value: number) => Number.isFinite(value) && value > 0;
const mean = (values: readonly number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const stddev = (values: readonly number[]) => {
    if (!values.length) return 0;
    const average = mean(values);
    return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
};
const EMPTY_COMPONENTS: ScoreComponents = {
    continuationEvidence: null, directionalEfficiency: null, reversalResistance: null,
    multiWindowAgreement: null, volatilitySuitability: null, sampleReliability: null,
    validationQuality: null, contributions: {},
};

export interface DirectionalMetrics {
    returns: number[];
    signs: number[];
    currentUpStreak: number;
    currentDownStreak: number;
    consecutiveOpposingMoves: number;
    confirmedReversal: boolean;
    reversalCounts: Record<5 | 10 | 20 | 40 | 60, number>;
    directionalEfficiency: number;
    shortAgreement: number;
    longAgreement: number;
    volatilityRatio: number;
    normalizedAbsoluteMove: number;
    rollingVolatilityBaseline: number;
    volatilityRegime: VolatilityRegime;
    recentReversalSeverity: number;
    fiveMoveContinuationRate: number | null;
    fiveMoveSamples: number;
    upScore: number;
    downScore: number;
    windowDirections: Record<5 | 20 | 40 | 60, ScanDirection | null>;
}

/** Strict, zero-change-breaking streaks and independent directional scores with documented monotonic reversal decay. */
export function calculateDirectionalMetrics(prices: readonly number[]): DirectionalMetrics | null {
    if (prices.length < 61 || !prices.every(validQuote)) return null;
    const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
    if (!returns.every(Number.isFinite)) return null;
    const signs = returns.map(value => Math.sign(value));
    const runLength = (sign: number) => {
        let count = 0;
        for (let i = signs.length - 1; i >= 0 && signs[i] === sign; i--) count++;
        return count;
    };
    const currentUpStreak = runLength(1);
    const currentDownStreak = runLength(-1);
    const tailSign = signs[signs.length - 1];
    let lastPriorSign: number = 0;
    for (let i = signs.length - 2; i >= 0; i--) if (signs[i] !== 0) { lastPriorSign = signs[i]; break; }
    const consecutiveOpposingMoves = tailSign && lastPriorSign && tailSign !== lastPriorSign ? runLength(tailSign) : 0;
    const confirmedReversal = consecutiveOpposingMoves >= 2;
    const reversalCounts = {} as Record<5 | 10 | 20 | 40 | 60, number>;
    for (const window of [5, 10, 20, 40, 60] as const) {
        const sample = signs.slice(-window);
        reversalCounts[window] = sample.slice(1).reduce((count, sign, i) =>
            count + (sign !== 0 && sample[i] !== 0 && sign !== sample[i] ? 1 : 0), 0);
    }
    const directionFor = (window: number): ScanDirection | null => {
        const sum = returns.slice(-window).reduce((a, b) => a + b, 0);
        return sum > 0 ? 'UP' : sum < 0 ? 'DOWN' : null;
    };
    const windowDirections = { 5: directionFor(5), 20: directionFor(20), 40: directionFor(40), 60: directionFor(60) };
    const last60 = returns.slice(-60);
    const net60 = last60.reduce((sum, value) => sum + value, 0);
    const gross60 = last60.reduce((sum, value) => sum + Math.abs(value), 0);
    const directionalEfficiency = gross60 ? Math.abs(net60) / gross60 : 0;
    const currentDirection = currentUpStreak ? 'UP' : currentDownStreak ? 'DOWN' : null;
    const agreement = (windows: readonly (5 | 20 | 40 | 60)[]) => currentDirection
        ? windows.filter(window => windowDirections[window] === currentDirection).length / windows.length
        : 0;
    const shortAgreement = agreement([5, 20]);
    const longAgreement = agreement([20, 40, 60]);
    const recentVol = stddev(returns.slice(-20));
    const rollingVolatilityBaseline = stddev(returns.slice(-60));
    const volatilityRatio = rollingVolatilityBaseline > 0 ? recentVol / rollingVolatilityBaseline : 0;
    const normalizedAbsoluteMove = mean(returns.slice(-20).map(Math.abs));
    const priorVol = stddev(returns.slice(-60, -20));
    const regimeUnstable = priorVol > 0 && recentVol / priorVol > VOLATILITY_LIMITS.maxRecentToBaselineRatio;
    let volatilityRegime: VolatilityRegime = 'suitable';
    if (!Number.isFinite(normalizedAbsoluteMove) || !Number.isFinite(volatilityRatio)) volatilityRegime = 'unavailable';
    else if (normalizedAbsoluteMove < VOLATILITY_LIMITS.minNormalizedMove || volatilityRatio < VOLATILITY_LIMITS.minRecentToBaselineRatio) volatilityRegime = 'low';
    else if (normalizedAbsoluteMove > VOLATILITY_LIMITS.maxNormalizedMove || volatilityRatio > VOLATILITY_LIMITS.maxRecentToBaselineRatio || regimeUnstable) volatilityRegime = 'excessive';
    const recent = signs.slice(-20);
    const recentReversalSeverity = recent.reduce((sum, sign, i) => i > 0 && sign && recent[i - 1] && sign !== recent[i - 1] ? sum + Math.abs(returns[returns.length - 20 + i]) : sum, 0);
    const continuationSamples: Array<{ direction: 1 | -1; outcome: boolean }> = [];
    // Candidate entry at tick i; targets i+1..i+5. These pairs retain original tick indexes.
    for (let i = 60; i + 5 < signs.length; i++) {
        const direction = signs[i];
        if (direction === 0) continue;
        continuationSamples.push({ direction: direction as 1 | -1, outcome: signs.slice(i + 1, i + 6).every(sign => sign === direction) });
    }
    const fiveMoveContinuationRate = continuationSamples.length
        ? continuationSamples.filter(row => row.outcome).length / continuationSamples.length : null;
    const oppositionPenalty = (opposingCount: number) => Math.pow(REVERSAL_DECAY_PER_TICK, opposingCount) * Math.max(0, 1 - REVERSAL_PENALTY_PER_MOVE * opposingCount);
    const baseUp = clamp01(0.35 * (currentUpStreak / 5) + 0.25 * directionalEfficiency + 0.20 * agreement([5, 20, 40, 60]) / 4 + 0.20 * (1 - reversalCounts[20] / 19));
    const baseDown = clamp01(0.35 * (currentDownStreak / 5) + 0.25 * directionalEfficiency + 0.20 * (windowDirections[5] === 'DOWN' && windowDirections[20] === 'DOWN' ? 1 : 0.5) + 0.20 * (1 - reversalCounts[20] / 19));
    const downAgreement = currentDownStreak ? agreement([5, 20, 40, 60]) : (windowDirections[5] === 'DOWN' && windowDirections[20] === 'DOWN' ? 0.5 : 0);
    const correctedDown = clamp01(0.35 * (currentDownStreak / 5) + 0.25 * directionalEfficiency + 0.20 * downAgreement + 0.20 * (1 - reversalCounts[20] / 19));
    const upScore = clamp01(baseUp * oppositionPenalty(currentUpStreak ? reversalCounts[20] : Math.max(1, currentDownStreak)));
    const downScore = clamp01(correctedDown * oppositionPenalty(currentDownStreak ? reversalCounts[20] : Math.max(1, currentUpStreak)));
    return {
        returns, signs, currentUpStreak, currentDownStreak, consecutiveOpposingMoves, confirmedReversal,
        reversalCounts, directionalEfficiency, shortAgreement, longAgreement, volatilityRatio,
        normalizedAbsoluteMove, rollingVolatilityBaseline, volatilityRegime, recentReversalSeverity,
        fiveMoveContinuationRate, fiveMoveSamples: continuationSamples.length, upScore, downScore, windowDirections,
    };
}

export interface IndexedOutcome { featureEnd: number; targetEnd: number; outcome: 0 | 1; }
export interface WalkForwardOptions { featureLookback: number; horizon: number; embargo?: number; minTrain?: number; minValidation?: number; minOos?: number; }
export interface PartitionedSamples { train: IndexedOutcome[]; validation: IndexedOutcome[]; outOfSample: IndexedOutcome[]; trainTickEnd: number; validationTickEnd: number; }

/**
 * Split tick indexes BEFORE generating samples. Feature end and target end must lie in the same partition.
 * Embargo is in original tick indexes: a later partition sample cannot begin within horizon+embargo of
 * the prior partition boundary. Thus no overlapping target is shared between train, validation and OOS.
 */
export function partitionWalkForwardSamples(
    tickCount: number,
    makeOutcome: (featureEnd: number) => 0 | 1 | null,
    options: WalkForwardOptions,
): PartitionedSamples {
    const { featureLookback, horizon } = options;
    const embargo = options.embargo ?? WALK_FORWARD_EMBARGO;
    const trainTickEnd = Math.floor(tickCount * 0.6);
    const validationTickEnd = Math.floor(tickCount * 0.8);
    const partitions = [
        { start: 0, end: trainTickEnd, key: 'train' as const },
        { start: trainTickEnd, end: validationTickEnd, key: 'validation' as const },
        { start: validationTickEnd, end: tickCount, key: 'outOfSample' as const },
    ];
    const result: PartitionedSamples = { train: [], validation: [], outOfSample: [], trainTickEnd, validationTickEnd };
    for (const partition of partitions) {
        for (let featureEnd = Math.max(partition.start + featureLookback - 1, 0); featureEnd + horizon < partition.end; featureEnd++) {
            if (partition.key !== 'train' && featureEnd < partition.start + embargo) continue;
            const outcome = makeOutcome(featureEnd);
            if (outcome === null) continue;
            result[partition.key].push({ featureEnd, targetEnd: featureEnd + horizon, outcome });
        }
    }
    return result;
}

export function validateChronologically(
    tickCount: number,
    makeOutcome: (featureEnd: number) => 0 | 1 | null,
    options: WalkForwardOptions,
): { validation: WalkForwardValidation; partitions: PartitionedSamples } {
    const partitions = partitionWalkForwardSamples(tickCount, makeOutcome, options);
    const train = partitions.train;
    const validation = partitions.validation;
    const oos = partitions.outOfSample;
    const embargo = options.embargo ?? WALK_FORWARD_EMBARGO;
    const empty = (status: ValidationStatus): WalkForwardValidation => ({
        status, trainSamples: train.length, validationSamples: validation.length, outOfSampleSamples: oos.length,
        baselineRate: null, validationRate: null, outOfSampleRate: null, lift: null, embargo,
        trainTickEnd: partitions.trainTickEnd, validationTickEnd: partitions.validationTickEnd,
    });
    if (train.length < (options.minTrain ?? MIN_TRAIN_OBSERVATIONS) || validation.length < (options.minValidation ?? MIN_VALIDATION_OBSERVATIONS) || oos.length < (options.minOos ?? MIN_OOS_OBSERVATIONS)) {
        return { validation: empty('insufficient data'), partitions };
    }
    const baselineRate = mean(train.map(row => row.outcome));
    const validationRate = mean(validation.map(row => row.outcome));
    const outOfSampleRate = mean(oos.map(row => row.outcome));
    const lift = outOfSampleRate - baselineRate;
    // Validation performance is a required stability check; OOS only reports the locked rule's final score.
    const status: ValidationStatus = validationRate > baselineRate && lift > 0
        ? 'validated' : 'no demonstrated out-of-sample edge';
    return {
        validation: { status, trainSamples: train.length, validationSamples: validation.length, outOfSampleSamples: oos.length,
            baselineRate, validationRate, outOfSampleRate, lift, embargo, trainTickEnd: partitions.trainTickEnd,
            validationTickEnd: partitions.validationTickEnd }, partitions,
    };
}

function emptyValidation(): WalkForwardValidation {
    return { status: 'insufficient data', trainSamples: 0, validationSamples: 0, outOfSampleSamples: 0,
        baselineRate: null, validationRate: null, outOfSampleRate: null, lift: null, embargo: WALK_FORWARD_EMBARGO,
        trainTickEnd: 0, validationTickEnd: 0 };
}
function emptyComponents(): ScoreComponents { return { ...EMPTY_COMPONENTS, contributions: {} }; }
function makeResult(symbol: string, strategy: ScanStrategyId, patch: Partial<MarketScanResult>): MarketScanResult {
    return { symbol, strategy, score: null, qualified: false, contract: null, direction: null, currentUpStreak: 0,
        currentDownStreak: 0, consecutiveOpposingMoves: 0, confirmedReversal: false, continuationRate: null,
        reversalCounts: { 5: 0, 10: 0, 20: 0, 40: 0, 60: 0 }, directionalEfficiency: null, volatility: 'unavailable',
        validation: emptyValidation(), scoreComponents: emptyComponents(), rejectionReason: null, evaluatedAtTick: 0, ...patch };
}

function parityOf(tick: MarketTick): 0 | 1 | null {
    if (!validQuote(tick.quote) || !Number.isInteger(tick.pipSize) || tick.pipSize === null || tick.pipSize < 0 || tick.pipSize > 12) return null;
    const digit = extractFinalDigit(tick);
    return digit === null ? null : (digit % 2) as 0 | 1;
}
function partitionParity(ticks: readonly MarketTick[], featureEnd: number): 0 | 1 | null {
    // The feature observed up to and including featureEnd; the target is precisely the following tick.
    return featureEnd + 1 < ticks.length ? parityOf(ticks[featureEnd + 1]) : null;
}

const TICKHIGH_CONTRACT: ContractSpec = { contract_type: 'TICKHIGH', duration: 5, duration_unit: 't', selected_tick: 5 };

function reliability(count: number, minimum = MIN_OOS_OBSERVATIONS): number | null {
    return count < minimum ? null : clamp01(count / (minimum * 3));
}
function validationQuality(validation: WalkForwardValidation): number | null {
    if (validation.status !== 'validated' || validation.lift === null || validation.validationRate === null) return null;
    // A positive locked OOS lift is required; scale conservatively and cap, never substitute for outcome rate.
    return clamp01(validation.lift / 0.2) * clamp01(validation.validationSamples / 60);
}
function weightedScore(components: ScoreComponents, weights: Record<keyof Omit<ScoreComponents, 'contributions'>, number>): number | null {
    const names = Object.keys(weights) as Array<keyof Omit<ScoreComponents, 'contributions'>>;
    if (names.some(name => components[name] === null || !Number.isFinite(components[name]))) return null;
    const contributions: ScoreComponents['contributions'] = {};
    for (const name of names) contributions[name] = components[name]! * weights[name];
    components.contributions = contributions;
    return clamp01(names.reduce((sum, name) => sum + contributions[name]!, 0));
}

export function scoreMarket(symbol: string, strategy: ScanStrategyId, prices: readonly number[], marketTicks?: readonly MarketTick[]): MarketScanResult {
    const history = prices.slice(-SCAN_HISTORY_SIZE);
    if (history.length < 120 || !history.every(validQuote)) return makeResult(symbol, strategy, {
        evaluatedAtTick: prices.length,
        rejectionReason: history.some(value => !validQuote(value)) ? 'Invalid quote in market history.' : 'Insufficient valid historical ticks (need 120).',
    });
    const metrics = calculateDirectionalMetrics(history);
    if (!metrics) return makeResult(symbol, strategy, { rejectionReason: 'Insufficient valid data for directional windows.' });
    const common = {
        evaluatedAtTick: prices.length,
        currentUpStreak: metrics.currentUpStreak,
        currentDownStreak: metrics.currentDownStreak,
        consecutiveOpposingMoves: metrics.consecutiveOpposingMoves,
        confirmedReversal: metrics.confirmedReversal,
        reversalCounts: metrics.reversalCounts,
        directionalEfficiency: metrics.directionalEfficiency,
        volatility: metrics.volatilityRegime,
        continuationRate: metrics.fiveMoveContinuationRate,
    };
    if (strategy === 'nexus-even-odd') {
        if (!marketTicks || marketTicks.length !== prices.length || marketTicks.length < 120 || marketTicks.some(tick => parityOf(tick) === null)) {
            return makeResult(symbol, strategy, { ...common, rejectionReason: 'Invalid/incomplete quotes or missing/invalid precision metadata.' });
        }
        const timeline = marketTicks.slice(-SCAN_HISTORY_SIZE);
        // Prediction choice is locked using training only; validation chooses whether the rule survives.
        const trainingEnd = Math.floor(timeline.length * 0.6);
        const validationEnd = Math.floor(timeline.length * 0.8);
        const trainCounts = [0, 0];
        for (let i = 0; i + 1 < trainingEnd; i++) {
            const p = parityOf(timeline[i]);
            if (p !== null) trainCounts[p]++;
        }
        const pick: 0 | 1 = trainCounts[0] >= trainCounts[1] ? 0 : 1;
        const generated = validateChronologically(timeline.length, end => partitionParity(timeline, end), { featureLookback: 1, horizon: 1 });
        const validation = generated.validation;
        const lockedValidationRate = generated.partitions.validation.length
            ? mean(generated.partitions.validation.map(row => Number(row.outcome === pick))) : null;
        const baseline = generated.partitions.train.length
            ? mean(generated.partitions.train.map(row => Number(row.outcome === pick))) : null;
        const oosRate = generated.partitions.outOfSample.length
            ? mean(generated.partitions.outOfSample.map(row => Number(row.outcome === pick))) : null;
        const lift = baseline !== null && oosRate !== null ? oosRate - baseline : null;
        const status: ValidationStatus = validation.status === 'insufficient data' ? 'insufficient data'
            : lockedValidationRate !== null && baseline !== null && lift !== null && lockedValidationRate > baseline && lift > 0
                ? 'validated' : 'no demonstrated out-of-sample edge';
        const parityValidation = { ...validation, status, baselineRate: baseline, validationRate: lockedValidationRate, outOfSampleRate: oosRate, lift };
        const sampleReliability = reliability(generated.partitions.outOfSample.length);
        const quality = validationQuality(parityValidation);
        const components: ScoreComponents = {
            continuationEvidence: oosRate, directionalEfficiency: null, reversalResistance: null, multiWindowAgreement: null,
            volatilitySuitability: null, sampleReliability, validationQuality: quality, contributions: {},
        };
        // Parity prediction quality is OOS correctness, not a directional/volatility score.
        const score = oosRate !== null && sampleReliability !== null && quality !== null
            ? clamp01(oosRate * 0.7 + sampleReliability * 0.15 + quality * 0.15) : null;
        const qualified = status === 'validated' && score !== null && score >= MIN_MARKET_SCORE && sampleReliability === 1;
        return makeResult(symbol, strategy, { ...common, score, qualified, direction: pick === 0 ? 'EVEN' : 'ODD',
            contract: { contract_type: pick === 0 ? 'DIGITEVEN' : 'DIGITODD', duration: 1, duration_unit: 't' },
            validation: parityValidation, scoreComponents: components,
            rejectionReason: qualified ? null : status !== 'validated' ? status : score === null ? 'Parity score unavailable.' : 'Parity score below 0.73 or sample reliability gate.',
        });
    }
    const generated = validateChronologically(history.length, featureEnd => {
        if (strategy === 'tick-striker' || strategy === 'tick-striker-v4') {
            if (featureEnd + 5 >= history.length) return null;
            const future = history.slice(featureEnd + 1, featureEnd + 6);
            return future[4] > Math.max(...future.slice(0, 4)) ? 1 : 0;
        }
        const prior = Math.sign(Math.log(history[featureEnd] / history[featureEnd - 1]));
        if (!prior) return null;
        return history[featureEnd + 5] > history[featureEnd + 4] && prior === 1 ? 1
            : history[featureEnd + 5] < history[featureEnd + 4] && prior === -1 ? 1 : 0;
    }, { featureLookback: 60, horizon: strategy === 'nexus-rise-fall' ? 5 : 5 });
    const validation = generated.validation;
    if (strategy === 'tick-striker' || strategy === 'tick-striker-v4') {
        const oosRate = validation.outOfSampleRate;
        const sampleReliability = reliability(validation.outOfSampleSamples);
        const quality = validationQuality(validation);
        // A direct TICKHIGH outcome rate is the target metric; OOS validation must also beat its train baseline.
        const components: ScoreComponents = { ...EMPTY_COMPONENTS, continuationEvidence: oosRate, sampleReliability, validationQuality: quality, contributions: {} };
        const score = oosRate !== null && sampleReliability !== null && quality !== null
            ? clamp01(oosRate * 0.7 + sampleReliability * 0.15 + quality * 0.15) : null;
        const qualified = validation.status === 'validated' && score !== null && score >= MIN_MARKET_SCORE && sampleReliability === 1;
        return makeResult(symbol, strategy, { ...common, contract: { ...TICKHIGH_CONTRACT }, score, qualified, validation, scoreComponents: components,
            rejectionReason: qualified ? null : validation.status !== 'validated' ? validation.status : 'TICKHIGH OOS quality/reliability did not pass the 0.73 gate.' });
    }

    // Direction for historical model selection is chosen by TRAIN partition only, locked before validation/OOS.
    const trainUp = generated.partitions.train.filter(row => {
        const sign = Math.sign(Math.log(history[row.featureEnd] / history[row.featureEnd - 1]));
        return sign === 1;
    });
    const trainDown = generated.partitions.train.filter(row => {
        const sign = Math.sign(Math.log(history[row.featureEnd] / history[row.featureEnd - 1]));
        return sign === -1;
    });
    const selectedDirection: ScanDirection | null = trainUp.length >= trainDown.length ? 'UP' : 'DOWN';
    const currentDirection: ScanDirection | null = metrics.currentUpStreak >= 5 ? 'UP' : metrics.currentDownStreak >= 5 ? 'DOWN' : null;
    const currentScore = currentDirection === 'UP' ? metrics.upScore : currentDirection === 'DOWN' ? metrics.downScore : null;
    const targetRows = (rows: IndexedOutcome[]) => rows.filter(row => {
        const sign = Math.sign(Math.log(history[row.featureEnd] / history[row.featureEnd - 1]));
        return sign === (selectedDirection === 'UP' ? 1 : -1);
    });
    const trainRows = targetRows(generated.partitions.train);
    const validationRows = targetRows(generated.partitions.validation);
    const oosRows = targetRows(generated.partitions.outOfSample);
    const baseline = trainRows.length ? mean(trainRows.map(row => row.outcome)) : null;
    const validationRate = validationRows.length ? mean(validationRows.map(row => row.outcome)) : null;
    const oosRate = oosRows.length ? mean(oosRows.map(row => row.outcome)) : null;
    const lift = baseline !== null && oosRate !== null ? oosRate - baseline : null;
    const status: ValidationStatus = trainRows.length < MIN_TRAIN_OBSERVATIONS || validationRows.length < MIN_VALIDATION_OBSERVATIONS || oosRows.length < MIN_OOS_OBSERVATIONS
        ? 'insufficient data' : validationRate! > baseline! && lift! > 0 ? 'validated' : 'no demonstrated out-of-sample edge';
    const directionValidation = { ...validation, status, baselineRate: baseline, validationRate, outOfSampleRate: oosRate, lift,
        trainSamples: trainRows.length, validationSamples: validationRows.length, outOfSampleSamples: oosRows.length };
    const opposingCount = selectedDirection === 'UP' ? metrics.currentDownStreak : metrics.currentUpStreak;
    const reversalResistance = clamp01(1 - metrics.reversalCounts[20] / 19) * Math.pow(REVERSAL_DECAY_PER_TICK, opposingCount);
    const sampleReliability = reliability(oosRows.length);
    const quality = validationQuality(directionValidation);
    const volatilitySuitability = metrics.volatilityRegime === 'suitable' ? 1 : metrics.volatilityRegime === 'low' ? 0 : metrics.volatilityRegime === 'excessive' ? 0 : null;
    const currentEfficiency = metrics.directionalEfficiency;
    const multiWindowAgreement = currentDirection
        ? [5, 20, 40, 60].filter(w => metrics.windowDirections[w as 5 | 20 | 40 | 60] === currentDirection).length / 4 : null;
    const components: ScoreComponents = {
        continuationEvidence: oosRate, directionalEfficiency: currentEfficiency, reversalResistance,
        multiWindowAgreement, volatilitySuitability, sampleReliability, validationQuality: quality, contributions: {},
    };
    // Weights sum to 1. OOS continuation dominates; missing mandatory evidence makes the score unavailable.
    const score = weightedScore(components, { continuationEvidence: 0.35, directionalEfficiency: 0.15,
        reversalResistance: 0.15, multiWindowAgreement: 0.10, volatilitySuitability: 0.10,
        sampleReliability: 0.075, validationQuality: 0.075 });
    const eligible = currentDirection !== null && selectedDirection === currentDirection && !metrics.confirmedReversal
        && metrics.volatilityRegime === 'suitable' && directionValidation.status === 'validated'
        && directionValidation.outOfSampleSamples >= MIN_OOS_OBSERVATIONS && score !== null && score >= MIN_MARKET_SCORE;
    return makeResult(symbol, strategy, { ...common, score, qualified: eligible, direction: currentDirection,
        contract: currentDirection ? { contract_type: currentDirection === 'UP' ? 'CALL' : 'PUT', duration: 1, duration_unit: 't' } : null,
        validation: directionValidation, scoreComponents: components,
        rejectionReason: eligible ? null : metrics.confirmedReversal ? 'Confirmed reversal: prior signal invalidated; wait for fresh streak.'
            : !currentDirection ? 'Need five fresh uninterrupted positive or negative movements.'
            : selectedDirection !== currentDirection ? 'Current direction differs from the training-locked direction.'
            : directionValidation.status !== 'validated' ? directionValidation.status
            : score === null ? 'Required score evidence is unavailable.' : 'Below 0.73 quality gate or volatility regime unsuitable.' });
}

/** Signal is usable only on its evaluation tick or next tick; callers must rescore on every new tick. */
export function isFreshQualifiedSignal(result: MarketScanResult, currentTickIndex: number, maximumAge = 1): boolean {
    return result.qualified && result.score !== null && result.score >= MIN_MARKET_SCORE
        && currentTickIndex >= result.evaluatedAtTick && currentTickIndex - result.evaluatedAtTick <= maximumAge;
}

/** Deterministic ranking order: eligibility, score, OOS lift, sample reliability, reversal resistance, volatility, symbol. */
export function rankMarkets(results: readonly MarketScanResult[]): MarketScanResult[] {
    return [...results].sort((a, b) => Number(b.qualified) - Number(a.qualified)
        || (b.score ?? -1) - (a.score ?? -1)
        || (b.validation.lift ?? -Infinity) - (a.validation.lift ?? -Infinity)
        || b.validation.outOfSampleSamples - a.validation.outOfSampleSamples
        || (b.scoreComponents.reversalResistance ?? -1) - (a.scoreComponents.reversalResistance ?? -1)
        || Number(b.volatility === 'suitable') - Number(a.volatility === 'suitable')
        || a.symbol.localeCompare(b.symbol));
}
export function bestQualifiedMarket(results: readonly MarketScanResult[]): MarketScanResult | null {
    return rankMarkets(results).find(result => result.qualified) ?? null;
}

/** Controlled asynchronous scanner; unavailable market failures are isolated. */
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
                const precisionValid = Number.isInteger(response.pipSize) && response.pipSize! >= 0 && response.pipSize! <= 12;
                const marketTicks = precisionValid ? prices.map((quote, sequence) => ({ quote, pipSize: response.pipSize!, sequence })) : undefined;
                results[index] = scoreMarket(symbol, strategy, prices, marketTicks);
            } catch (error) {
                results[index] = makeResult(symbol, strategy, { evaluatedAtTick: 0, rejectionReason: error instanceof Error ? error.message : String(error) });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(concurrency) || 1, symbols.length || 1)) }, worker));
    return rankMarkets(results);
}
