import { extractFinalDigit } from './last-ticks-matches';
import type { BulkStrategy, MarketTick, SignalResult, TradeIntent } from '../types';

const TICK_COUNT = 1;
const match = (digit: number) => ({
    contract_type: 'DIGITMATCH',
    duration: TICK_COUNT,
    duration_unit: 't' as const,
    barrier: String(digit),
});

const readDigits = (ticks: readonly MarketTick[], count: number): number[] | null => {
    const sample = ticks.slice(-count);
    if (sample.length < count) return null;
    const digits = sample.map(extractFinalDigit);
    return digits.every((digit): digit is number => digit !== null) ? digits : null;
};

const abstain = (reason: string): SignalResult => ({ trade: false, score: null, reason });
const signal = (digit: number, score: number, reason: string): SignalResult => ({
    trade: true,
    score,
    reason,
    contract: match(digit),
});
const noSettlement = () => undefined;
const settleMatch = (ticks: readonly MarketTick[], spec: { barrier?: string }) => {
    const tick = ticks[0];
    if (!tick || spec.barrier === undefined) return undefined;
    const digit = extractFinalDigit(tick);
    return digit === null ? undefined : digit === Number(spec.barrier);
};
const createMatchIntent = (result: SignalResult): TradeIntent[] =>
    result.trade && result.contract ? [{ spec: result.contract }] : [];

const blueprintWindow = 20;

export const blueprintRecentPattern: BulkStrategy = {
    id: 'blueprint-recent-pattern',
    label: 'Blueprint Recent Pattern (experimental)',
    description:
        'Inspired by Blueprint’s short recent-digit patterns: emphasizes a digit repeated in the last three ticks, otherwise the most frequent digit in the last 20. Requires a visible cluster before selecting Matches. No random fallback or confidence score.',
    minTicks: blueprintWindow,
    bufferSize: blueprintWindow,
    ticksToSettle: TICK_COUNT,
    contract: () => match(0),
    evaluate: () => abstain('This strategy requires tick precision metadata.'),
    evaluateMarketTicks: ticks => {
        const digits = readDigits(ticks, blueprintWindow);
        if (!digits) return abstain(`Waiting for ${blueprintWindow} ticks with valid precision metadata.`);

        const recent = digits.slice(-3);
        const latest = recent[recent.length - 1];
        const recentCount = recent.filter(digit => digit === latest).length;
        const counts = Array<number>(10).fill(0);
        digits.forEach(digit => { counts[digit]++; });
        const frequent = counts.reduce((best, count, digit) => (count > counts[best] ? digit : best), 0);
        const digit = recentCount >= 2 ? latest : frequent;
        const count = counts[digit];

        if (recentCount < 2 && count < 4) {
            return abstain(`No recent digit cluster: the top digit appeared ${count}/${blueprintWindow} times.`);
        }
        return signal(
            digit,
            count / blueprintWindow,
            `Recent-pattern candidate is digit ${digit} (${recentCount}/3 in the latest ticks; ${count}/${blueprintWindow} overall). Historical pattern only; not a probability.`
        );
    },
    settle: noSettlement,
    createTradeIntents: (ticks, config) => createMatchIntent(blueprintRecentPattern.evaluateMarketTicks!(ticks, config)),
    settleIntent: (ticks, intent) => settleMatch(ticks, intent.spec),
};

const proAnalyserWindow = 500;
const proAnalyserZThreshold = 2.8;

export const proAnalyserFrequency: BulkStrategy = {
    id: 'proanalyser-frequency',
    label: 'ProAnalyser Digit Frequency (experimental)',
    description:
        'Inspired by ProAnalyser’s full digit-frequency view: checks a 500-tick window for a digit unusually frequent versus the 10% fair baseline, then selects Matches. The screen does not claim predictive win probability.',
    minTicks: proAnalyserWindow,
    bufferSize: proAnalyserWindow,
    ticksToSettle: TICK_COUNT,
    contract: () => match(0),
    evaluate: () => abstain('This strategy requires tick precision metadata.'),
    evaluateMarketTicks: ticks => {
        const digits = readDigits(ticks, proAnalyserWindow);
        if (!digits) return abstain(`Waiting for ${proAnalyserWindow} ticks with valid precision metadata.`);
        const counts = Array<number>(10).fill(0);
        digits.forEach(digit => { counts[digit]++; });
        const digit = counts.reduce((best, count, index) => (count > counts[best] ? index : best), 0);
        const expected = digits.length / 10;
        const standardDeviation = Math.sqrt(digits.length * 0.1 * 0.9);
        const z = (counts[digit] - expected) / standardDeviation;
        if (z < proAnalyserZThreshold) {
            return abstain(`Most frequent digit ${digit} is within ordinary sample variation (z=${z.toFixed(2)}; needs ${proAnalyserZThreshold}).`);
        }
        return signal(
            digit,
            counts[digit] / digits.length,
            `Digit ${digit} appeared ${counts[digit]}/${digits.length} times (z=${z.toFixed(2)} versus the 10% baseline). Historical deviation only.`
        );
    },
    settle: noSettlement,
    createTradeIntents: (ticks, config) => createMatchIntent(proAnalyserFrequency.evaluateMarketTicks!(ticks, config)),
    settleIntent: (ticks, intent) => settleMatch(ticks, intent.spec),
};

const tacticsWindow = 120;
const RECENT_SHARE_WEIGHT = 2;

export const tacticsWeightedFrequency: BulkStrategy = {
    id: 'tactics-weighted-frequency',
    label: 'Tactics Weighted Frequency (experimental)',
    description:
        'Inspired by Tactics’ recency-weighted digit ranking: gives the newest 60% of a 120-tick sample twice the weight of the older 40%. Requires a conservative weighted deviation before selecting Matches.',
    minTicks: tacticsWindow,
    bufferSize: tacticsWindow,
    ticksToSettle: TICK_COUNT,
    contract: () => match(0),
    evaluate: () => abstain('This strategy requires tick precision metadata.'),
    evaluateMarketTicks: ticks => {
        const digits = readDigits(ticks, tacticsWindow);
        if (!digits) return abstain(`Waiting for ${tacticsWindow} ticks with valid precision metadata.`);

        const recentStart = Math.floor(digits.length * 0.4);
        const sumWeights = digits.reduce((sum, _digit, index) => sum + (index >= recentStart ? RECENT_SHARE_WEIGHT : 1), 0);
        const sumSquaredWeights = digits.reduce(
            (sum, _digit, index) => sum + (index >= recentStart ? RECENT_SHARE_WEIGHT ** 2 : 1),
            0
        );
        const weightedCounts = Array<number>(10).fill(0);
        digits.forEach((digit, index) => {
            weightedCounts[digit] += index >= recentStart ? RECENT_SHARE_WEIGHT : 1;
        });

        const digit = weightedCounts.reduce((best, count, index) => (count > weightedCounts[best] ? index : best), 0);
        const share = weightedCounts[digit] / sumWeights;
        const effectiveSampleSize = sumWeights ** 2 / sumSquaredWeights;
        const standardDeviation = Math.sqrt(0.1 * 0.9 / effectiveSampleSize);
        const z = (share - 0.1) / standardDeviation;
        if (z < proAnalyserZThreshold) {
            return abstain(`Weighted digit share is within ordinary sample variation (z=${z.toFixed(2)}; needs ${proAnalyserZThreshold}).`);
        }
        return signal(
            digit,
            share,
            `Digit ${digit} has ${(share * 100).toFixed(1)}% weighted share (effective sample ${effectiveSampleSize.toFixed(0)}, z=${z.toFixed(2)}). Historical deviation only.`
        );
    },
    settle: noSettlement,
    createTradeIntents: (ticks, config) => createMatchIntent(tacticsWeightedFrequency.evaluateMarketTicks!(ticks, config)),
    settleIntent: (ticks, intent) => settleMatch(ticks, intent.spec),
};
