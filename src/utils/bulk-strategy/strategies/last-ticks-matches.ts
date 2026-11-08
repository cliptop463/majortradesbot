import type { BulkConfig, BulkStrategy, ContractSpec, MarketTick, SignalResult, TradeIntent } from '../types';

export const MIN_MATCHES_TICK_COUNT = 1;
export const MAX_MATCHES_TICK_COUNT = 10;
export const DEFAULT_MATCHES_TICK_COUNT = 5;

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

    const recent = ticks.slice(-count);
    if (recent.length < count) return [];

    return recent.map(tick => {
        const digit = extractFinalDigit(tick);
        if (digit === null) throw new Error('Tick precision metadata is unavailable for Last-Ticks Matches.');
        return {
            spec: { contract_type: 'DIGITMATCH', duration: 1, duration_unit: 't', barrier: String(digit) },
            sourceDigit: digit,
        };
    });
}

const contract = (_config: BulkConfig): ContractSpec => ({
    contract_type: 'DIGITMATCH',
    duration: 1,
    duration_unit: 't',
    barrier: '0',
});

export const lastTicksMatches: BulkStrategy = {
    id: 'last-ticks-matches',
    label: 'Last-Ticks Matches',
    description: 'Match each of the newest selected tick digits with its own one-tick DIGITMATCH contract. Repeated digits remain separate contracts.',
    minTicks: MIN_MATCHES_TICK_COUNT,
    bufferSize: MAX_MATCHES_TICK_COUNT,
    ticksToSettle: 1,
    contract,
    evaluate(ticks, config) {
        const count = config?.matchesTickCount ?? DEFAULT_MATCHES_TICK_COUNT;
        const trade = validateMatchesTickCount(count) && ticks.length >= count;
        const result: SignalResult = {
            trade,
            score: null,
            reason: trade ? `Collected the newest ${count} tick digits.` : 'Collecting recent tick digits.',
        };
        return result;
    },
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