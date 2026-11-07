import type { BulkConfig, BulkStrategy, ContractSpec, SignalResult } from '../types';

/** Tick Striker V3 scores the actual TICKHIGH selected-tick-5 outcome. */
export const MIN_TICKS = 300;
export const BUFFER_SIZE = 1200;
export const FEATURE_LOOKBACK = 24;
export const PREDICTION_HORIZON = 5;
export const TRAIN_SAMPLE_INTERVAL = 2;
export const MIN_POSITIVE_EXAMPLES = 8;
export const MIN_NEGATIVE_EXAMPLES = 30;
export const SELECTED_TICK = 5;
export const THRESHOLD = 0.5;

const TRAINING_EPOCHS = 350;
const LEARNING_RATE = 0.08;
const L2_PENALTY = 0.01;

type Features = [number, number, number, number, number, number];
type Example = { x: Features; y: 0 | 1 };
type LogisticModel = { weights: number[]; means: number[]; scales: number[] };

const contract = (_config: BulkConfig): ContractSpec => ({
    contract_type: 'TICKHIGH',
    duration: PREDICTION_HORIZON,
    duration_unit: 't',
    selected_tick: SELECTED_TICK,
});

const mean = (values: readonly number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const standardDeviation = (values: readonly number[]) => {
    const average = mean(values);
    return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
};

const sigmoid = (value: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

function isValidQuote(quote: number): boolean {
    return Number.isFinite(quote) && quote > 0;
}

function isSelectedTickStrictlyHighest(quotes: readonly number[], selectedTick: number): boolean {
    const selected = quotes[selectedTick - 1];
    return quotes.every((quote, index) => index === selectedTick - 1 || selected > quote);
}

function extractFeatures(prices: readonly number[]): Features | null {
    if (prices.length < FEATURE_LOOKBACK) return null;

    const window = prices.slice(-FEATURE_LOOKBACK);
    if (!window.every(isValidQuote)) return null;

    const returns = window.slice(1).map((price, index) => (price - window[index]) / window[index]);
    if (!returns.every(Number.isFinite)) return null;

    let reversals = 0;
    for (let index = returns.length - 11; index < returns.length; index++) {
        if (index > 0 && returns[index] * returns[index - 1] < 0) reversals++;
    }

    const low = Math.min(...window);
    const high = Math.max(...window);
    const result: Features = [
        window[23] / window[20] - 1,
        window[23] / window[11] - 1,
        standardDeviation(returns.slice(-5)) / Math.max(standardDeviation(returns.slice(-20)), 1e-12),
        reversals / 11,
        high > low ? (2 * (window[23] - low)) / (high - low) - 1 : 0,
        Math.sign(returns[returns.length - 1]),
    ];

    return result.every(Number.isFinite) ? result : null;
}

function createExamples(prices: readonly number[]): Example[] {
    const rows: Example[] = [];

    for (
        let end = FEATURE_LOOKBACK - 1;
        end + PREDICTION_HORIZON < prices.length;
        end += TRAIN_SAMPLE_INTERVAL
    ) {
        const features = extractFeatures(prices.slice(end - FEATURE_LOOKBACK + 1, end + 1));
        const future = prices.slice(end + 1, end + 1 + PREDICTION_HORIZON);

        if (!features || future.length !== PREDICTION_HORIZON || !future.every(isValidQuote)) continue;
        rows.push({ x: features, y: isSelectedTickStrictlyHighest(future, SELECTED_TICK) ? 1 : 0 });
    }

    return rows;
}

function fitLogisticRegression(rows: readonly Example[]): LogisticModel | null {
    const featureCount = rows[0]?.x.length ?? 0;
    if (featureCount === 0) return null;

    const means = Array.from({ length: featureCount }, (_, column) => mean(rows.map(row => row.x[column])));
    const scales = Array.from(
        { length: featureCount },
        (_, column) => Math.max(standardDeviation(rows.map(row => row.x[column])), 1e-9)
    );
    const normalized = rows.map(row => row.x.map((value, column) => (value - means[column]) / scales[column]));
    const positives = rows.reduce((count, row) => count + row.y, 0);
    const negatives = rows.length - positives;
    const weights = Array(featureCount + 1).fill(0) as number[];
    weights[0] = Math.log(positives / negatives);

    for (let epoch = 0; epoch < TRAINING_EPOCHS; epoch++) {
        const gradient = Array(featureCount + 1).fill(0) as number[];

        normalized.forEach((features, rowIndex) => {
            const prediction = sigmoid(
                weights[0] + features.reduce((sum, value, column) => sum + value * weights[column + 1], 0)
            );
            const error = prediction - rows[rowIndex].y;
            gradient[0] += error;
            features.forEach((value, column) => {
                gradient[column + 1] += error * value;
            });
        });

        weights[0] -= (LEARNING_RATE * gradient[0]) / rows.length;
        for (let column = 0; column < featureCount; column++) {
            weights[column + 1] -=
                LEARNING_RATE * (gradient[column + 1] / rows.length + L2_PENALTY * weights[column + 1]);
        }

        if (!weights.every(Number.isFinite)) return null;
    }

    return { weights, means, scales };
}

function unavailable(reason: string): SignalResult {
    return { trade: false, score: null, reason };
}

export function evaluate(ticks: readonly number[]): SignalResult {
    const window = ticks.slice(-BUFFER_SIZE);
    if (window.some(quote => !isValidQuote(quote))) {
        return unavailable('Invalid tick data: quotes must be finite positive numbers.');
    }
    if (window.length < MIN_TICKS) {
        return unavailable(`Need ${MIN_TICKS} ticks, have ${window.length}.`);
    }

    const currentFeatures = extractFeatures(window);
    const rows = createExamples(window);
    const positives = rows.reduce((count, row) => count + row.y, 0);
    const negatives = rows.length - positives;

    if (positives < MIN_POSITIVE_EXAMPLES || negatives < MIN_NEGATIVE_EXAMPLES) {
        return unavailable(
            `Insufficient TICKHIGH outcome classes: need ${MIN_POSITIVE_EXAMPLES} positive and ${MIN_NEGATIVE_EXAMPLES} negative examples; have ${positives} and ${negatives}.`
        );
    }

    const model = fitLogisticRegression(rows);
    if (!currentFeatures || !model) return unavailable('TICKHIGH model features or training are invalid.');

    const logit =
        model.weights[0] +
        currentFeatures.reduce(
            (sum, value, column) => sum + ((value - model.means[column]) / model.scales[column]) * model.weights[column + 1],
            0
        );
    const score = sigmoid(logit);

    if (!Number.isFinite(score)) return unavailable('TICKHIGH model produced a non-finite score.');

    const trade = score >= THRESHOLD;
    return {
        trade,
        score,
        reason: `Uncalibrated TICKHIGH model score ${score.toFixed(3)} from ${rows.length} historical outcomes (${positives} positive, ${negatives} negative); threshold ${THRESHOLD.toFixed(2)}.`,
    };
}

/** Paper settlement: the selected tick must be strictly higher than every other contract tick. */
export function settle(ticksAfterEntry: readonly number[], spec: ContractSpec): boolean | undefined {
    const selectedTick = spec.selected_tick ?? SELECTED_TICK;
    if (
        !Number.isInteger(spec.duration) ||
        spec.duration <= 0 ||
        !Number.isInteger(selectedTick) ||
        selectedTick < 1 ||
        selectedTick > spec.duration
    ) {
        return false;
    }
    if (ticksAfterEntry.length < spec.duration) return undefined;

    const contractTicks = ticksAfterEntry.slice(0, spec.duration);
    if (!contractTicks.every(isValidQuote)) return false;
    return isSelectedTickStrictlyHighest(contractTicks, selectedTick);
}

export const tickStriker: BulkStrategy = {
    id: 'tick-striker',
    label: 'Tick Striker V3',
    description:
        'TICKHIGH selected tick 5 over 5 ticks. A rolling logistic model produces an uncalibrated score, not a win probability.',
    minTicks: MIN_TICKS,
    bufferSize: BUFFER_SIZE,
    ticksToSettle: PREDICTION_HORIZON,
    contract,
    evaluate,
    settle,
};
