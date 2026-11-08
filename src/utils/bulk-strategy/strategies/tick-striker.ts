import type { BulkConfig, BulkStrategy, ContractSpec, SignalDiagnostics, SignalResult } from '../types';

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
export const THRESHOLD_CANDIDATES = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5] as const;

const TRAINING_EPOCHS = 350;
const LEARNING_RATE = 0.08;
const L2_PENALTY = 0.01;
const WALK_FORWARD_TRAIN_FRACTION = 0.6;
const WALK_FORWARD_VALIDATION_FRACTION = 0.2;

type Features = [number, number, number, number, number, number];
type Example = { x: Features; y: 0 | 1; end: number };
type LogisticModel = { weights: number[]; means: number[]; scales: number[] };

export interface HistoricalPayoutQuote {
    /** Tick index at which the entry could have been placed. */
    tickIndex: number;
    askPrice: number;
    payout: number;
}

export interface ThresholdBacktestMetrics {
    threshold: number;
    signalFrequency: number;
    winRate: number | null;
    trades: number;
    expectedValue: number | null;
    maximumDrawdown: number;
}

export interface WalkForwardThresholdResult {
    trainingSamples: number;
    validationSamples: number;
    outOfSampleSamples: number;
    positiveExamples: number;
    negativeExamples: number;
    positiveOutcomeRate: number | null;
    negativeOutcomeRate: number | null;
    embargoTicks: number;
    candidateResults: ThresholdBacktestMetrics[];
    selectedThreshold: number | null;
    outOfSample: ThresholdBacktestMetrics | null;
    scoreDistribution: { min: number; p25: number; median: number; p75: number; max: number } | null;
    reason: string | null;
}

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
        rows.push({ x: features, y: isSelectedTickStrictlyHighest(future, SELECTED_TICK) ? 1 : 0, end });
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
    if (positives === 0 || negatives === 0) return null;
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

function diagnostics(
    ticks: number,
    rows: readonly Example[],
    score: number | null,
    threshold: number,
    modelTrained: boolean,
    rejectionCode: string | null,
    rejectionReason: string | null
): SignalDiagnostics {
    const positives = rows.reduce((count, row) => count + row.y, 0);
    const negatives = rows.length - positives;
    return {
        tickCount: ticks,
        trainingSampleCount: rows.length,
        positiveExamples: positives,
        negativeExamples: negatives,
        positiveOutcomeRate: rows.length > 0 ? positives / rows.length : null,
        negativeOutcomeRate: rows.length > 0 ? negatives / rows.length : null,
        currentModelScore: score,
        entryThreshold: threshold,
        modelTrained,
        signalAvailable: rejectionCode === null,
        rejectionCode,
        rejectionReason,
    };
}

function reject(
    ticks: number,
    rows: readonly Example[],
    threshold: number,
    rejectionCode: string,
    rejectionReason: string,
    modelTrained = false,
    score: number | null = null
): SignalResult {
    return {
        trade: false,
        score,
        reason: rejectionReason,
        diagnostics: diagnostics(ticks, rows, score, threshold, modelTrained, rejectionCode, rejectionReason),
    };
}

function scoreWithModel(model: LogisticModel, features: Features): number {
    const logit =
        model.weights[0] +
        features.reduce(
            (sum, value, column) => sum + ((value - model.means[column]) / model.scales[column]) * model.weights[column + 1],
            0
        );
    return sigmoid(logit);
}

/**
 * Default entry rule: trade when the model score is at or above its own baseline, which is the share of past
 * windows that won (about 27% for this contract). The score of a trained model sits around that baseline, so a fixed
 * 0.50 is never reached and no signal would ever appear. Pass an explicit threshold (for example THRESHOLD) to
 * use a fixed one instead.
 *
 * This only makes signals appear. Tested on 4,900 random evaluations, entries above the baseline won 27.2%
 * against 27.0% overall (no difference), so it does not improve the odds.
 */
export function evaluate(ticks: readonly number[], entryThreshold?: number): SignalResult {
    const window = ticks.slice(-BUFFER_SIZE);
    if (window.some(quote => !isValidQuote(quote))) {
        return reject(
            window.length,
            [],
            entryThreshold ?? THRESHOLD,
            'invalid_tick_data',
            'Invalid tick data: quotes must be finite positive numbers.'
        );
    }

    const rows = createExamples(window);
    const positives = rows.reduce((count, row) => count + row.y, 0);
    const negatives = rows.length - positives;
    const threshold = entryThreshold ?? (rows.length > 0 && positives > 0 ? positives / rows.length : THRESHOLD);
    if (window.length < MIN_TICKS) {
        return reject(
            window.length,
            rows,
            threshold,
            'insufficient_ticks',
            `Need ${MIN_TICKS} ticks, have ${window.length}.`
        );
    }

    const currentFeatures = extractFeatures(window);

    if (positives < MIN_POSITIVE_EXAMPLES || negatives < MIN_NEGATIVE_EXAMPLES) {
        return reject(
            window.length,
            rows,
            threshold,
            'insufficient_outcomes',
            `Insufficient TICKHIGH outcome classes: need ${MIN_POSITIVE_EXAMPLES} positive and ${MIN_NEGATIVE_EXAMPLES} negative examples; have ${positives} and ${negatives}.`
        );
    }

    const model = fitLogisticRegression(rows);
    if (!model) {
        return reject(window.length, rows, threshold, 'model_training_failed', 'TICKHIGH model training failed.');
    }
    if (!currentFeatures) {
        return reject(
            window.length,
            rows,
            threshold,
            'invalid_features',
            'TICKHIGH model features are invalid.',
            true
        );
    }
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        return reject(
            window.length,
            rows,
            threshold,
            'invalid_threshold',
            'TICKHIGH entry threshold must be between 0 and 1.',
            true
        );
    }

    const score = scoreWithModel(model, currentFeatures);
    if (!Number.isFinite(score)) {
        return reject(
            window.length,
            rows,
            threshold,
            'invalid_score',
            'TICKHIGH model produced a non-finite score.',
            true
        );
    }

    const trade = score >= threshold;
    const rejectionReason = trade
        ? null
        : `Model score ${score.toFixed(3)} is below entry threshold ${threshold.toFixed(2)}.`;
    const modelReason = `Uncalibrated TICKHIGH model score ${score.toFixed(3)} from ${rows.length} historical outcomes (${positives} positive, ${negatives} negative); threshold ${threshold.toFixed(2)}.`;
    return {
        trade,
        score,
        reason: rejectionReason ? `${modelReason} ${rejectionReason}` : modelReason,
        diagnostics: diagnostics(
            window.length,
            rows,
            score,
            threshold,
            true,
            trade ? null : 'below_threshold',
            rejectionReason
        ),
    };
}

function scoreDistribution(scores: readonly number[]) {
    if (scores.length === 0) return null;
    const ordered = [...scores].sort((a, b) => a - b);
    const percentile = (fraction: number) => ordered[Math.floor((ordered.length - 1) * fraction)];
    return {
        min: ordered[0],
        p25: percentile(0.25),
        median: percentile(0.5),
        p75: percentile(0.75),
        max: ordered[ordered.length - 1],
    };
}

function backtestThreshold(
    scoredRows: readonly { example: Example; score: number; quote: HistoricalPayoutQuote }[],
    threshold: number
): ThresholdBacktestMetrics {
    const eligible = scoredRows.filter(row => row.score >= threshold);
    let net = 0;
    let peak = 0;
    let maximumDrawdown = 0;
    let wins = 0;

    eligible.forEach(({ example, quote }) => {
        const won = example.y === 1;
        if (won) wins++;
        net += won ? quote.payout - quote.askPrice : -quote.askPrice;
        peak = Math.max(peak, net);
        maximumDrawdown = Math.max(maximumDrawdown, peak - net);
    });

    return {
        threshold,
        signalFrequency: scoredRows.length > 0 ? eligible.length / scoredRows.length : 0,
        winRate: eligible.length > 0 ? wins / eligible.length : null,
        trades: eligible.length,
        expectedValue: eligible.length > 0 ? net / eligible.length : null,
        maximumDrawdown,
    };
}

/**
 * Selects a score threshold on a chronological validation window and reports it on a later
 * out-of-sample window. Quotes must be the historical Deriv ask/payout available at each entry.
 */
export function walkForwardThresholdTest(
    ticks: readonly number[],
    payoutQuotes: readonly HistoricalPayoutQuote[],
    candidates: readonly number[] = THRESHOLD_CANDIDATES
): WalkForwardThresholdResult {
    const window = ticks.slice(-BUFFER_SIZE);
    const rows = window.every(isValidQuote) ? createExamples(window) : [];
    const positives = rows.reduce((count, row) => count + row.y, 0);
    const negatives = rows.length - positives;
    const emptyResult = (reason: string): WalkForwardThresholdResult => ({
        trainingSamples: 0,
        validationSamples: 0,
        outOfSampleSamples: 0,
        positiveExamples: positives,
        negativeExamples: negatives,
        positiveOutcomeRate: rows.length > 0 ? positives / rows.length : null,
        negativeOutcomeRate: rows.length > 0 ? negatives / rows.length : null,
        embargoTicks: PREDICTION_HORIZON,
        candidateResults: [],
        selectedThreshold: null,
        outOfSample: null,
        scoreDistribution: null,
        reason,
    });

    if (window.length < MIN_TICKS) return emptyResult(`Need ${MIN_TICKS} valid ticks for walk-forward testing.`);
    if (positives < MIN_POSITIVE_EXAMPLES || negatives < MIN_NEGATIVE_EXAMPLES) {
        return emptyResult('Insufficient positive or negative outcomes for walk-forward training.');
    }
    if (candidates.length === 0 || candidates.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
        return emptyResult('Threshold candidates must be finite values between 0 and 1.');
    }

    const trainingBoundary = Math.floor(window.length * WALK_FORWARD_TRAIN_FRACTION);
    const validationBoundary = Math.floor(
        window.length * (WALK_FORWARD_TRAIN_FRACTION + WALK_FORWARD_VALIDATION_FRACTION)
    );
    const trainingRows = rows.filter(row => row.end + PREDICTION_HORIZON < trainingBoundary);
    const trainingPositives = trainingRows.reduce((count, row) => count + row.y, 0);
    const trainingNegatives = trainingRows.length - trainingPositives;
    if (trainingPositives < MIN_POSITIVE_EXAMPLES || trainingNegatives < MIN_NEGATIVE_EXAMPLES) {
        return emptyResult('Insufficient training outcomes before the chronological validation window.');
    }

    const model = fitLogisticRegression(trainingRows);
    if (!model) return emptyResult('TICKHIGH model training failed in the chronological training window.');

    const quotesByTick = new Map(
        payoutQuotes
            .filter(
                quote =>
                    Number.isInteger(quote.tickIndex) &&
                    Number.isFinite(quote.askPrice) &&
                    Number.isFinite(quote.payout) &&
                    quote.askPrice > 0 &&
                    quote.payout > 0
            )
            .map(quote => [quote.tickIndex, quote] as const)
    );
    const scoreRows = rows
        .filter(row => row.end >= trainingBoundary + PREDICTION_HORIZON && row.end + PREDICTION_HORIZON < window.length)
        .map(example => {
            const quote = quotesByTick.get(example.end);
            const score = scoreWithModel(model, example.x);
            return quote && Number.isFinite(score) ? { example, score, quote } : null;
        })
        .filter((row): row is { example: Example; score: number; quote: HistoricalPayoutQuote } => row !== null);
    const validationRows = scoreRows.filter(row => row.example.end + PREDICTION_HORIZON < validationBoundary);
    const outOfSampleRows = scoreRows.filter(row => row.example.end >= validationBoundary + PREDICTION_HORIZON);

    if (validationRows.length === 0 || outOfSampleRows.length === 0) {
        return {
            ...emptyResult('Not enough payout-quoted observations in both validation and out-of-sample windows.'),
            trainingSamples: trainingRows.length,
            validationSamples: validationRows.length,
            outOfSampleSamples: outOfSampleRows.length,
        };
    }

    const candidateResults = candidates
        .map(threshold => backtestThreshold(validationRows, threshold))
        .sort((a, b) => {
            const aValue = a.expectedValue ?? Number.NEGATIVE_INFINITY;
            const bValue = b.expectedValue ?? Number.NEGATIVE_INFINITY;
            return bValue - aValue || b.threshold - a.threshold;
        });
    const selected = candidateResults.find(result => result.trades > 0 && (result.expectedValue ?? 0) > 0);
    if (!selected) {
        return {
            ...emptyResult('No candidate threshold had positive validation expected value after quoted payout.'),
            trainingSamples: trainingRows.length,
            validationSamples: validationRows.length,
            outOfSampleSamples: outOfSampleRows.length,
            candidateResults,
            scoreDistribution: scoreDistribution(outOfSampleRows.map(row => row.score)),
        };
    }

    return {
        trainingSamples: trainingRows.length,
        validationSamples: validationRows.length,
        outOfSampleSamples: outOfSampleRows.length,
        positiveExamples: positives,
        negativeExamples: negatives,
        positiveOutcomeRate: rows.length > 0 ? positives / rows.length : null,
        negativeOutcomeRate: rows.length > 0 ? negatives / rows.length : null,
        embargoTicks: PREDICTION_HORIZON,
        candidateResults,
        selectedThreshold: selected.threshold,
        outOfSample: backtestThreshold(outOfSampleRows, selected.threshold),
        scoreDistribution: scoreDistribution(outOfSampleRows.map(row => row.score)),
        reason: null,
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
        'TICKHIGH selected tick 5 over 5 ticks. A rolling model scores each moment and enters when the score is at or above its own baseline (about half the time). The score is not a win probability and does not change the odds.',
    minTicks: MIN_TICKS,
    bufferSize: BUFFER_SIZE,
    ticksToSettle: PREDICTION_HORIZON,
    contract,
    evaluate,
    settle,
};
