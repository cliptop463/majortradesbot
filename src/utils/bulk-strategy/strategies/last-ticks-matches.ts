import type { BulkConfig, BulkStrategy, ContractSpec, MarketTick, SignalResult, TradeIntent } from '../types';

export const MIN_MATCHES_TICK_COUNT = 1;
export const MAX_MATCHES_TICK_COUNT = 10;
export const DEFAULT_MATCHES_TICK_COUNT = 5;
export const MATCHES_LOOKBACK_TICK_COUNT = 100;

export function extractFinalDigit(tick: Pick<MarketTick, 'quote' | 'pipSize'>): number | null {
    const { quote, pipSize } = tick;
    if (!Number.isFinite(quote) || !Number.isInteger(pipSize) || pipSize === null || pipSize < 0 || pipSize > 12) {
        return null;
    }
    const [mantissa, exponentText = '0'] = Math.abs(quote).toString().toLowerCase().split('e');
    const [integerPart, fractionalPart = ''] = mantissa.split('.');
    const coefficient = BigInt(`${integerPart}${fractionalPart}`);
    const scaleShift = pipSize + Number(exponentText) - fractionalPart.length;
    let scaledQuote: bigint;
    if (scaleShift >= 0) {
        scaledQuote = coefficient * 10n ** BigInt(scaleShift);
    } else {
        const divisor = 10n ** BigInt(-scaleShift);
        scaledQuote = (coefficient + divisor / 2n) / divisor;
    }
    return Number(scaledQuote % 10n);
}

export function validateMatchesTickCount(count: number): boolean {
    return Number.isInteger(count) && count >= MIN_MATCHES_TICK_COUNT && count <= MAX_MATCHES_TICK_COUNT;
}

export function createMatchIntents(ticks: readonly MarketTick[], count: number): TradeIntent[] {
    if (!validateMatchesTickCount(count)) {
        throw new RangeError(`Number of recent tick digits must be a whole number from ${MIN_MATCHES_TICK_COUNT} to ${MAX_MATCHES_TICK_COUNT}.`);
    }

    const recent = ticks.slice(-MATCHES_LOOKBACK_TICK_COUNT);
    if (recent.length < count) return [];

    const counts = Array<number>(10).fill(0);
    const lastSeen = Array<number>(10).fill(-1);
    recent.forEach((tick, index) => {
        const digit = extractFinalDigit(tick);
        if (digit === null) throw new Error('Tick precision metadata is unavailable for Last-Ticks Matches.');
        counts[digit]++;
        lastSeen[digit] = index;
    });

    return Array.from({ length: 10 }, (_, digit) => digit)
        .sort((a, b) => counts[a] - counts[b] || lastSeen[a] - lastSeen[b] || a - b)
        .slice(0, count)
        .map(digit => ({
            spec: { contract_type: 'DIGITMATCH', duration: 1, duration_unit: 't', barrier: String(digit) },
            sourceDigit: digit,
        }));
}

const contract = (_config: BulkConfig): ContractSpec => ({
    contract_type: 'DIGITMATCH',
    duration: 1,
    duration_unit: 't',
    barrier: '0',
});

function evaluateMatches(ticks: readonly number[], count: number): SignalResult {
    const trade = validateMatchesTickCount(count) && ticks.length >= count;
    return {
        trade,
        score: null,
        reason: trade ? `Collected ${count} fresh ticks for a batch of unique match barriers.` : 'Collecting fresh ticks for the next match batch.',
    };
}

export const lastTicksMatches: BulkStrategy = {
    id: 'last-ticks-matches',
    label: 'Last-Ticks Matches',
    description:
        'Each batch uses unique DIGITMATCH barriers, ranked by lowest frequency and then longest time since seen in the last 100 ticks. This is only a historical heuristic; it cannot predict or guarantee a win or recover losses.',
    minTicks: MIN_MATCHES_TICK_COUNT,
    bufferSize: MATCHES_LOOKBACK_TICK_COUNT,
    ticksToSettle: 1,
    contract,
    evaluate: ticks => evaluateMatches(ticks, DEFAULT_MATCHES_TICK_COUNT),
    evaluateWithConfig: (ticks, config) => evaluateMatches(ticks, config.matchesTickCount),
    settle: () => undefined,
    createTradeIntents(ticks, config) {
        return createMatchIntents(ticks, config.matchesTickCount);
    },
    settleIntent(ticksAfterEntry, intent) {
        const settlementTick = ticksAfterEntry[0];
        if (!settlementTick) return undefined;
        const settlementDigit = extractFinalDigit(settlementTick);
        const barrier = Number(intent.spec.barrier);
        if (settlementDigit === null || !Number.isInteger(barrier) || barrier < 0 || barrier > 9) return undefined;
        return settlementDigit === barrier;
    },
    batchSize: config => config.matchesTickCount,
};