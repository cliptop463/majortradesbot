import type { BulkConfig, BulkStrategy, ContractSpec, SignalDiagnostics, SignalResult } from '../types';

/**
 * Tick Striker V4 keeps the V3 contract unchanged so the two models can be compared fairly.
 * The model differs by using non-overlapping training examples and a conservative entry gate.
 */
export const MIN_TICKS_V4 = 400;
export const BUFFER_SIZE_V4 = 1200;
export const FEATURE_LOOKBACK_V4 = 24;
export const PREDICTION_HORIZON_V4 = 5;
export const MIN_POSITIVE_EXAMPLES_V4 = 8;
export const MIN_NEGATIVE_EXAMPLES_V4 = 30;
export const MIN_EDGE_V4 = 0.05;
export const MIN_THRESHOLD_V4 = 0.3;

type Features = [number, number, number, number, number, number];
type Example = { x: Features; y: 0 | 1; end: number };
type Model = { weights: number[]; means: number[]; scales: number[] };

const contract = (_config: BulkConfig): ContractSpec => ({
    contract_type: 'TICKHIGH',
    duration: PREDICTION_HORIZON_V4,
    duration_unit: 't',
    selected_tick: 5,
});

const valid = (value: number) => Number.isFinite(value) && value > 0;
const mean = (values: readonly number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
const deviation = (values: readonly number[]) => Math.sqrt(mean(values.map(value => (value - mean(values)) ** 2)));
const sigmoid = (value: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

const highestAtSelectedTick = (quotes: readonly number[]) => {
    const selected = quotes[PREDICTION_HORIZON_V4 - 1];
    return quotes.length === PREDICTION_HORIZON_V4 && quotes.every((quote, index) => index === PREDICTION_HORIZON_V4 - 1 || selected > quote);
};

function features(prices: readonly number[]): Features | null {
    if (prices.length < FEATURE_LOOKBACK_V4 || !prices.every(valid)) return null;
    const window = prices.slice(-FEATURE_LOOKBACK_V4);
    const returns = window.slice(1).map((price, index) => (price - window[index]) / window[index]);
    if (!returns.every(Number.isFinite)) return null;
    let reversals = 0;
    for (let index = returns.length - 11; index < returns.length; index++) {
        if (index > 0 && returns[index] * returns[index - 1] < 0) reversals++;
    }
    const low = Math.min(...window);
    const high = Math.max(...window);
    const values: Features = [
        window[23] / window[20] - 1,
        window[23] / window[11] - 1,
        deviation(returns.slice(-5)) / Math.max(deviation(returns.slice(-20)), 1e-12),
        reversals / 11,
        high > low ? (2 * (window[23] - low)) / (high - low) - 1 : 0,
        Math.sign(returns[returns.length - 1]),
    ];
    return values.every(Number.isFinite) ? values : null;
}

function examples(prices: readonly number[]): Example[] {
    const rows: Example[] = [];
    for (let end = FEATURE_LOOKBACK_V4 - 1; end + PREDICTION_HORIZON_V4 < prices.length; end += PREDICTION_HORIZON_V4) {
        const x = features(prices.slice(end - FEATURE_LOOKBACK_V4 + 1, end + 1));
        const future = prices.slice(end + 1, end + 1 + PREDICTION_HORIZON_V4);
        if (x && future.every(valid)) rows.push({ x, y: highestAtSelectedTick(future) ? 1 : 0, end });
    }
    return rows;
}

function fit(rows: readonly Example[]): Model | null {
    if (!rows.length) return null;
    const count = rows[0].x.length;
    const means = Array.from({ length: count }, (_, column) => mean(rows.map(row => row.x[column])));
    const scales = Array.from({ length: count }, (_, column) => Math.max(deviation(rows.map(row => row.x[column])), 1e-9));
    const normalized = rows.map(row => row.x.map((value, column) => (value - means[column]) / scales[column]));
    const positives = rows.reduce((total, row) => total + row.y, 0);
    const negatives = rows.length - positives;
    if (!positives || !negatives) return null;
    const weights = Array(count + 1).fill(0) as number[];
    weights[0] = Math.log(positives / negatives);
    for (let epoch = 0; epoch < 250; epoch++) {
        const gradient = Array(count + 1).fill(0) as number[];
        normalized.forEach((row, rowIndex) => {
            const prediction = sigmoid(weights[0] + row.reduce((sum, value, column) => sum + value * weights[column + 1], 0));
            const error = prediction - rows[rowIndex].y;
            gradient[0] += error;
            row.forEach((value, column) => (gradient[column + 1] += error * value));
        });
        weights[0] -= (0.08 * gradient[0]) / rows.length;
        for (let column = 0; column < count; column++) weights[column + 1] -= 0.08 * (gradient[column + 1] / rows.length + 0.01 * weights[column + 1]);
    }
    return weights.every(Number.isFinite) ? { weights, means, scales } : null;
}

function score(model: Model, x: Features) {
    return sigmoid(model.weights[0] + x.reduce((sum, value, column) => sum + ((value - model.means[column]) / model.scales[column]) * model.weights[column + 1], 0));
}

function diagnostics(ticks: number, rows: readonly Example[], currentModelScore: number | null, threshold: number, trained: boolean, rejectionCode: string | null, rejectionReason: string | null): SignalDiagnostics {
    const positiveExamples = rows.reduce((total, row) => total + row.y, 0);
    const negativeExamples = rows.length - positiveExamples;
    return {
        tickCount: ticks,
        trainingSampleCount: rows.length,
        positiveExamples,
        negativeExamples,
        positiveOutcomeRate: rows.length ? positiveExamples / rows.length : null,
        negativeOutcomeRate: rows.length ? negativeExamples / rows.length : null,
        currentModelScore,
        entryThreshold: threshold,
        modelTrained: trained,
        signalAvailable: rejectionCode === null,
        rejectionCode,
        rejectionReason,
    };
}

function reject(ticks: number, rows: readonly Example[], threshold: number, code: string, reason: string, trained = false, currentModelScore: number | null = null): SignalResult {
    return { trade: false, score: currentModelScore, reason, diagnostics: diagnostics(ticks, rows, currentModelScore, threshold, trained, code, reason) };
}

export function evaluateV4(ticks: readonly number[]): SignalResult {
    const window = ticks.slice(-BUFFER_SIZE_V4);
    if (window.some(quote => !valid(quote))) return reject(window.length, [], MIN_THRESHOLD_V4, 'invalid_tick_data', 'Invalid tick data: quotes must be finite positive numbers.');
    const rows = examples(window);
    const positiveExamples = rows.reduce((total, row) => total + row.y, 0);
    const negativeExamples = rows.length - positiveExamples;
    const baseline = rows.length ? positiveExamples / rows.length : MIN_THRESHOLD_V4;
    const threshold = Math.max(MIN_THRESHOLD_V4, baseline + MIN_EDGE_V4);
    if (window.length < MIN_TICKS_V4) return reject(window.length, rows, threshold, 'insufficient_ticks', `Need ${MIN_TICKS_V4} ticks, have ${window.length}.`);
    if (positiveExamples < MIN_POSITIVE_EXAMPLES_V4 || negativeExamples < MIN_NEGATIVE_EXAMPLES_V4) {
        return reject(window.length, rows, threshold, 'insufficient_outcomes', `Insufficient TICKHIGH outcome classes: need ${MIN_POSITIVE_EXAMPLES_V4} positive and ${MIN_NEGATIVE_EXAMPLES_V4} negative examples; have ${positiveExamples} and ${negativeExamples}.`);
    }
    const model = fit(rows);
    if (!model) return reject(window.length, rows, threshold, 'model_training_failed', 'TICKHIGH V4 model training failed.');
    const current = features(window);
    if (!current) return reject(window.length, rows, threshold, 'invalid_features', 'TICKHIGH V4 model features are invalid.', true);
    const currentModelScore = score(model, current);
    const trade = currentModelScore >= threshold;
    const reason = trade
        ? `V4 score ${currentModelScore.toFixed(3)} clears conservative threshold ${threshold.toFixed(3)} (${rows.length} non-overlapping samples).`
        : `V4 score ${currentModelScore.toFixed(3)} is below conservative threshold ${threshold.toFixed(3)}.`;
    return { trade, score: currentModelScore, reason, diagnostics: diagnostics(window.length, rows, currentModelScore, threshold, true, trade ? null : 'below_threshold', trade ? null : reason) };
}

export function settleV4(ticksAfterEntry: readonly number[], spec: ContractSpec): boolean | undefined {
    if (ticksAfterEntry.length < PREDICTION_HORIZON_V4) return undefined;
    const selectedTick = spec.selected_tick ?? 5;
    if (selectedTick !== 5 || !ticksAfterEntry.slice(0, PREDICTION_HORIZON_V4).every(valid)) return false;
    return highestAtSelectedTick(ticksAfterEntry.slice(0, PREDICTION_HORIZON_V4));
}

export const tickStrikerV4: BulkStrategy = {
    id: 'tick-striker-v4',
    label: 'Tick Striker V4',
    description: 'Conservative TICKHIGH model using non-overlapping five-tick training examples and a baseline-plus-edge entry gate. It trades less often than V3; validate expected value with real payouts before live use.',
    minTicks: MIN_TICKS_V4,
    bufferSize: BUFFER_SIZE_V4,
    ticksToSettle: PREDICTION_HORIZON_V4,
    contract,
    evaluate: evaluateV4,
    settle: settleV4,
};
