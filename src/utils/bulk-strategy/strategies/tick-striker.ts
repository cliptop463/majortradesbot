import type { BulkConfig, BulkStrategy, ContractSpec, SignalResult } from '../types';

/**
 * Tick Striker: High Tick (TICKHIGH), selected tick 5, 5 ticks.
 *
 * Entry gate: look at the last ~120 ticks, build an up/down series (1 if the tick rose versus the
 * previous one, else 0) and estimate
 *     conf = 0.65 * P(up | same state as the last tick) + 0.35 * overall up-rate
 * Trade when conf >= 0.5.
 *
 * Honest note: the gate describes past ticks. It is not shown to improve the chance that the 5th tick
 * is the highest of five, so treat it as an entry filter, not an edge.
 */

export const MIN_TICKS = 18;
export const BUFFER_SIZE = 120;
export const SELECTED_TICK = 5;
export const THRESHOLD = 0.5;
const MIN_SAMPLES_FOR_RATE = 8;

const contract = (_config: BulkConfig): ContractSpec => ({
    contract_type: 'TICKHIGH',
    duration: 5,
    duration_unit: 't',
    selected_tick: SELECTED_TICK,
});

export function evaluate(ticks: readonly number[]): SignalResult {
    const window = ticks.slice(-BUFFER_SIZE);
    if (window.length < MIN_TICKS) {
        return { trade: false, confidence: 0, reason: `Need ${MIN_TICKS} ticks, have ${window.length}.` };
    }

    const series: number[] = [];
    for (let i = 1; i < window.length; i++) series.push(window[i] > window[i - 1] ? 1 : 0);

    const lastState = series[series.length - 1];
    let sameState = 0;
    let sameStateThenUp = 0;
    for (let j = 0; j < series.length - 1; j++) {
        if (series[j] === lastState) {
            sameState++;
            if (series[j + 1] === 1) sameStateThenUp++;
        }
    }

    const pUpGivenState = sameState > 0 ? sameStateThenUp / sameState : 0.5;
    const upRate = series.length >= MIN_SAMPLES_FOR_RATE ? series.reduce((a, b) => a + b, 0) / series.length : 0.5;
    const confidence = 0.65 * pUpGivenState + 0.35 * upRate;
    const trade = confidence >= THRESHOLD;

    return {
        trade,
        confidence,
        reason: `conf ${confidence.toFixed(3)} (P(up|state) ${pUpGivenState.toFixed(2)}, up-rate ${upRate.toFixed(
            2
        )}) ${trade ? '>=' : '<'} ${THRESHOLD}`,
    };
}

/**
 * Paper settlement from real ticks: the contract wins when the selected tick is strictly higher than
 * every other tick of the five. A tie is treated as a loss (conservative); Live uses Deriv's own result.
 */
export function settle(ticksAfterEntry: readonly number[], spec: ContractSpec): boolean | undefined {
    const duration = spec.duration;
    const selected = spec.selected_tick ?? SELECTED_TICK;
    if (ticksAfterEntry.length < duration) return undefined;
    const five = ticksAfterEntry.slice(0, duration);
    const chosen = five[selected - 1];
    return five.every((quote, index) => index === selected - 1 || chosen > quote);
}

export const tickStriker: BulkStrategy = {
    id: 'tick-striker',
    label: 'Tick Striker',
    description: 'High Tick (TICKHIGH), selected tick 5, 5 ticks. Enters when the up/down estimate is at least 0.5.',
    minTicks: MIN_TICKS,
    bufferSize: BUFFER_SIZE,
    ticksToSettle: 5,
    contract,
    evaluate,
    settle,
};
