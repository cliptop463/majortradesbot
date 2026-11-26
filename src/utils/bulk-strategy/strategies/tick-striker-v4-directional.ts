import { detectDirection } from '@/utils/tick-direction/direction';
import type { BulkStrategy } from '../types';
import { tickStrikerV4, evaluateV4 } from './tick-striker-v4';

export function evaluateV4Directional(ticks: readonly number[]) {
    const gate = detectDirection(ticks);
    if (gate.direction !== 'UP') {
        return {
            trade: false,
            score: Math.abs(gate.t),
            reason: `Tick Striker V4 needs an UP move for TICKHIGH. ${gate.reason}`,
        };
    }

    const result = evaluateV4(ticks);
    return { ...result, reason: `${gate.reason} ${result.reason}` };
}

export const tickStrikerV4Directional: BulkStrategy = {
    ...tickStrikerV4,
    id: 'tick-striker-v4-directional',
    label: 'Tick Striker V4 Directional',
    description:
        'Tick Striker V4 is evaluated only after the t-statistic gate confirms an upward price move, as required for its TICKHIGH contract.',
    evaluate: evaluateV4Directional,
};
