import type { Direction } from './types';

export type TradeKind = 'matches_differs' | 'even_odd' | 'over_under';

export interface ContractSpec {
    kind: TradeKind;
    /** Value of the Blockly TRADETYPE_LIST field. */
    tradeType: 'matchesdiffers' | 'evenodd' | 'overunder';
    /** Value of the Blockly TYPE_LIST field. */
    typeValue: 'DIGITMATCH' | 'DIGITDIFF' | 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER';
    /** True when the contract needs a prediction digit (barrier). */
    hasBarrier: boolean;
    label: string;
}

export const CONTRACTS: Record<Direction, ContractSpec> = {
    MATCHES: { kind: 'matches_differs', tradeType: 'matchesdiffers', typeValue: 'DIGITMATCH', hasBarrier: true, label: 'Matches' },
    DIFFERS: { kind: 'matches_differs', tradeType: 'matchesdiffers', typeValue: 'DIGITDIFF', hasBarrier: true, label: 'Differs' },
    EVEN: { kind: 'even_odd', tradeType: 'evenodd', typeValue: 'DIGITEVEN', hasBarrier: false, label: 'Even' },
    ODD: { kind: 'even_odd', tradeType: 'evenodd', typeValue: 'DIGITODD', hasBarrier: false, label: 'Odd' },
    OVER: { kind: 'over_under', tradeType: 'overunder', typeValue: 'DIGITOVER', hasBarrier: true, label: 'Over' },
    UNDER: { kind: 'over_under', tradeType: 'overunder', typeValue: 'DIGITUNDER', hasBarrier: true, label: 'Under' },
};

export const TRADE_KIND_LABELS: Record<TradeKind, string> = {
    matches_differs: 'Matches / Differs',
    even_odd: 'Even / Odd',
    over_under: 'Over / Under',
};

export const TRADE_KINDS: readonly TradeKind[] = ['matches_differs', 'even_odd', 'over_under'];

export const isDirection = (value: unknown): value is Direction =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONTRACTS, value);

/** Returns an error message when the barrier is not valid for the direction, otherwise null. */
export function barrierError(direction: Direction, barrier: number | null | undefined): string | null {
    const spec = CONTRACTS[direction];
    if (!spec.hasBarrier) return null;
    if (typeof barrier !== 'number' || !Number.isInteger(barrier) || barrier < 0 || barrier > 9) {
        return `Digit must be an integer from 0 to 9, received: ${barrier}`;
    }
    if (direction === 'OVER' && barrier > 8) return 'Over needs a digit from 0 to 8 (Over 9 can never win).';
    if (direction === 'UNDER' && barrier < 1) return 'Under needs a digit from 1 to 9 (Under 0 can never win).';
    return null;
}

/** Human-readable pick, e.g. "Matches 7", "Even", "Over 3". */
export function formatPick(direction: Direction, barrier?: number | null): string {
    const spec = CONTRACTS[direction];
    return spec.hasBarrier && barrier !== null && barrier !== undefined ? `${spec.label} ${barrier}` : spec.label;
}

/** Whether the contract would have won on the given next digit. */
export function isWin(direction: Direction, barrier: number | null | undefined, next: number): boolean {
    switch (direction) {
        case 'MATCHES': return next === barrier;
        case 'DIFFERS': return next !== barrier;
        case 'EVEN': return next % 2 === 0;
        case 'ODD': return next % 2 === 1;
        case 'OVER': return next > (barrier as number);
        case 'UNDER': return next < (barrier as number);
        default: return false;
    }
}

/**
 * Win rate of the contract if digits were fair and independent. It is the baseline any strategy must
 * beat, not a forecast: past digits do not change it.
 */
export function fairWinRate(direction: Direction, barrier?: number | null): number {
    switch (direction) {
        case 'MATCHES': return 0.1;
        case 'DIFFERS': return 0.9;
        case 'EVEN':
        case 'ODD': return 0.5;
        case 'OVER': return (9 - (barrier as number)) / 10;
        case 'UNDER': return (barrier as number) / 10;
        default: return 0;
    }
}
