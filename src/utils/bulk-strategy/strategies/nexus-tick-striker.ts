import type { BulkConfig, BulkStrategy, ContractSpec, SignalDiagnostics, SignalResult } from '../types';

/** Experimental Nexus-style Tick Striker with sequence and reversal gates. */
export const CONTEXT_TICKS = 1000;
export const BUFFER_SIZE_NEXUS = 1200;
export const SHORT_WINDOW = 50;
export const MIN_TICKS_NEXUS = CONTEXT_TICKS;
export const DURATION_NEXUS = 5;
export const ENTRY_THRESHOLD_NEXUS = 0.55;
export const MAX_REVERSAL_RISK = 0.35;

const valid = (quote: number) => Number.isFinite(quote) && quote > 0;
const mean = (values: readonly number[]) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
const directionSeries = (quotes: readonly number[]) => quotes.slice(1).map((quote, index) => (quote > quotes[index] ? 1 : 0));

const diagnostics = (ticks: number, score: number | null, available: boolean, code: string | null, reason: string | null): SignalDiagnostics => ({
    tickCount: ticks, trainingSampleCount: 0, positiveExamples: 0, negativeExamples: 0,
    positiveOutcomeRate: null, negativeOutcomeRate: null, currentModelScore: score,
    entryThreshold: ENTRY_THRESHOLD_NEXUS, modelTrained: false, signalAvailable: available,
    rejectionCode: code, rejectionReason: reason,
});
const reject = (ticks: number, code: string, reason: string, score: number | null = null): SignalResult => ({
    trade: false, score, reason, diagnostics: diagnostics(ticks, score, false, code, reason),
});

/** Nexus' 65/35 continuation blend. */
export function continuationScore(directions: readonly number[]): number {
    if (directions.length < 8) return 0.5;
    const current = directions[directions.length - 1];
    const overall = mean(directions);
    let same = 0; let opportunities = 0;
    for (let index = 1; index < directions.length; index++) {
        if (directions[index - 1] === current) { opportunities++; if (directions[index] === current) same++; }
    }
    return 0.65 * (opportunities > 0 ? same / opportunities : overall) + 0.35 * overall;
}

export interface NexusSignal { score: number; reversalRisk: number; longUpShare: number; shortUpShare: number; runLength: number; nearResistance: boolean; }

export function analyzeNexusTicks(ticks: readonly number[]): NexusSignal | null {
    if (ticks.length < MIN_TICKS_NEXUS || ticks.some(quote => !valid(quote))) return null;
    const context = ticks.slice(-CONTEXT_TICKS); const directions = directionSeries(context);
    const longUpShare = mean(directions); const shortUpShare = mean(directions.slice(-SHORT_WINDOW));
    const continuation = continuationScore(directions); const currentDirection = directions[directions.length - 1];
    let runLength = 1;
    for (let index = directions.length - 2; index >= 0 && directions[index] === currentDirection; index--) runLength++;
    const resistanceWindow = context.slice(-100); const low = Math.min(...resistanceWindow); const high = Math.max(...resistanceWindow);
    const position = high > low ? (context[context.length - 1] - low) / (high - low) : 0.5;
    const nearResistance = currentDirection === 1 && position >= 0.9;
    const exhaustion = Math.min(1, Math.max(0, (runLength - 5) / 8));
    const reversalRisk = Math.min(1, 0.55 * exhaustion + (nearResistance ? 0.45 : 0));
    const score = 0.35 * longUpShare + 0.35 * shortUpShare + 0.3 * continuation;
    return { score, reversalRisk, longUpShare, shortUpShare, runLength, nearResistance };
}

export function evaluateNexusTicks(ticks: readonly number[]): SignalResult {
    const window = ticks.slice(-BUFFER_SIZE_NEXUS);
    if (window.some(quote => !valid(quote))) return reject(window.length, 'invalid_tick_data', 'Quotes must be finite positive numbers.');
    if (window.length < MIN_TICKS_NEXUS) return reject(window.length, 'insufficient_ticks', `Need ${MIN_TICKS_NEXUS} ticks, have ${window.length}.`);
    const signal = analyzeNexusTicks(window); if (!signal) return reject(window.length, 'analysis_failed', 'Could not analyse the tick sequence.');
    const reversal = signal.reversalRisk > MAX_REVERSAL_RISK;
    const trade = signal.score >= ENTRY_THRESHOLD_NEXUS && signal.shortUpShare >= 0.5 && !reversal;
    const reason = trade ? `Nexus continuation ${signal.score.toFixed(3)} clears ${ENTRY_THRESHOLD_NEXUS}; reversal risk ${signal.reversalRisk.toFixed(3)}.` : `Nexus score ${signal.score.toFixed(3)}, short up-share ${signal.shortUpShare.toFixed(3)}, reversal risk ${signal.reversalRisk.toFixed(3)}.`;
    return { trade, score: signal.score, reason, diagnostics: diagnostics(window.length, signal.score, trade, trade ? null : 'entry_gate', reason) };
}

const contract = (_config: BulkConfig): ContractSpec => ({ contract_type: 'TICKHIGH', duration: DURATION_NEXUS, duration_unit: 't', selected_tick: DURATION_NEXUS });

export function settleNexusTicks(ticksAfterEntry: readonly number[], spec: ContractSpec): boolean | undefined {
    if (ticksAfterEntry.length < DURATION_NEXUS) return undefined;
    if ((spec.selected_tick ?? DURATION_NEXUS) !== DURATION_NEXUS) return false;
    const five = ticksAfterEntry.slice(0, DURATION_NEXUS); if (five.some(quote => !valid(quote))) return false;
    return five[4] > five[0] && five[4] > five[1] && five[4] > five[2] && five[4] > five[3];
}

export const nexusTickStriker: BulkStrategy = {
    id: 'nexus-tick-striker', label: 'Nexus Tick Striker (experimental)',
    description: 'Nexus-style TICKHIGH with 1,000-tick context, 50-tick sequence confirmation, and a reversal gate.',
    minTicks: MIN_TICKS_NEXUS, bufferSize: BUFFER_SIZE_NEXUS, ticksToSettle: DURATION_NEXUS,
    contract, evaluate: evaluateNexusTicks, settle: settleNexusTicks,
};
