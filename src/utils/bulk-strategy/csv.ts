import type { RoundLog } from './types';

export const CSV_HEADER = [
    'round',
    'time',
    'mode',
    'symbol',
    'contracts',
    'stake',
    'cost',
    'won',
    'lost',
    'interrupted',
    'net',
    'cumulative',
    'score',
    'note',
] as const;

const cell = (value: string | number): string => {
    const text = String(value);
    // Quote when needed, and neutralise spreadsheet formulas.
    const safe = /^[=+\-@]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(logs: readonly RoundLog[]): string {
    const rows = logs.map(l =>
        [
            l.round,
            l.time,
            l.mode,
            l.symbol,
            l.contracts,
            l.stake.toFixed(2),
            l.cost.toFixed(2),
            l.won,
            l.lost,
            l.interrupted,
            l.net.toFixed(2),
            l.cumulative.toFixed(2),
            l.score === null ? '' : l.score.toFixed(3),
            l.note,
        ]
            .map(cell)
            .join(',')
    );
    return [CSV_HEADER.join(','), ...rows].join('\n');
}
