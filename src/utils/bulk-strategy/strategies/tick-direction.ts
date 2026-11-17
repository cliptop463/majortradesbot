import { contractFor, detectDirection } from '@/utils/tick-direction/direction';
import type { BulkConfig, BulkStrategy, ContractSpec, SignalResult } from '../types';

export const HORIZON_DIRECTION = 5;
export const SELECTED_TICK_DIRECTION = 1;
export const MIN_TICKS_DIRECTION = 61;
export const BUFFER_SIZE_DIRECTION = 300;

const makeContract = (contractType: 'TICKHIGH' | 'TICKLOW', selectedTick = SELECTED_TICK_DIRECTION): ContractSpec => ({
    contract_type: contractType,
    duration: HORIZON_DIRECTION,
    duration_unit: 't',
    selected_tick: selectedTick,
});

export function evaluateDirection(ticks: readonly number[]): SignalResult {
    const result = detectDirection(ticks.slice(-BUFFER_SIZE_DIRECTION));
    const score =
        result.code === 'insufficient_ticks' || result.code === 'invalid_tick_data' ? null : Math.abs(result.t);
    if (!result.direction) return { trade: false, score, reason: result.reason };
    return {
        trade: true,
        score,
        reason: result.reason,
        contract: makeContract(contractFor(result.direction)),
    };
}

export function settleDirection(ticksAfterEntry: readonly number[], spec: ContractSpec): boolean | undefined {
    if (ticksAfterEntry.length < HORIZON_DIRECTION) return undefined;
    const quotes = ticksAfterEntry.slice(0, HORIZON_DIRECTION);
    const selectedTick = spec.selected_tick ?? SELECTED_TICK_DIRECTION;
    if (
        !quotes.every(quote => Number.isFinite(quote) && quote > 0) ||
        !Number.isInteger(selectedTick) ||
        selectedTick < 1 ||
        selectedTick > HORIZON_DIRECTION ||
        (spec.contract_type !== 'TICKHIGH' && spec.contract_type !== 'TICKLOW')
    ) {
        return false;
    }

    const selected = quotes[selectedTick - 1];
    return quotes.every((quote, index) => {
        if (index === selectedTick - 1) return true;
        return spec.contract_type === 'TICKHIGH' ? selected > quote : selected < quote;
    });
}

export const tickDirection: BulkStrategy = {
    id: 'tick-direction',
    label: 'Tick Direction',
    description:
        'Buys High Tick after a gated falling-price move or Low Tick after a gated rising-price move. Direction uses only nested-window t-statistics; Paper-test results against the quoted break-even win rate.',
    minTicks: MIN_TICKS_DIRECTION,
    bufferSize: BUFFER_SIZE_DIRECTION,
    ticksToSettle: HORIZON_DIRECTION,
    contract: (_config: BulkConfig) => makeContract('TICKHIGH'),
    evaluate: evaluateDirection,
    settle: settleDirection,
};
