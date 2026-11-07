import { describe, expect, it } from '@jest/globals';
import { CSV_HEADER, toCsv } from '../csv';
import type { RoundLog } from '../types';

const log = (patch: Partial<RoundLog> = {}): RoundLog => ({
    round: 1,
    time: '2026-11-04T10:00:00.000Z',
    mode: 'paper',
    symbol: 'R_100',
    contracts: 3,
    stake: 0.35,
    cost: 1.05,
    won: 0,
    lost: 3,
    interrupted: 0,
    net: -1.05,
    cumulative: -1.05,
    score: 0.61234,
    note: '',
    ...patch,
});

describe('toCsv', () => {
    it('writes a header and one row per round', () => {
        const lines = toCsv([log(), log({ round: 2, won: 3, lost: 0, net: 2.1, cumulative: 1.05 })]).split('\n');
        expect(lines[0]).toBe(CSV_HEADER.join(','));
        expect(lines).toHaveLength(3);
        expect(lines[1]).toBe('1,2026-11-04T10:00:00.000Z,paper,R_100,3,0.35,1.05,0,3,0,-1.05,-1.05,0.612,false,');
        expect(lines[2].startsWith('2,')).toBe(true);
    });

    it('is just the header when there are no rounds', () => {
        expect(toCsv([])).toBe(CSV_HEADER.join(','));
    });

    it('leaves the score empty when the strategy could not produce one', () => {
        expect(toCsv([log({ score: null })]).split('\n')[1].split(',')[12]).toBe('');
    });

    it('identifies timeout-forced entries as testing-only', () => {
        expect(toCsv([log({ testingOnly: true })]).split('\n')[1].split(',')[13]).toBe('true');
    });

    it('quotes notes with commas, quotes and new lines', () => {
        const row = toCsv([log({ note: 'He said "stop", then\nleft' })]).split('\n').slice(1).join('\n');
        expect(row.endsWith('"He said ""stop"", then\nleft"')).toBe(true);
    });

    it('neutralises spreadsheet formulas in text fields', () => {
        const row = toCsv([log({ note: '=HYPERLINK("x")' })]);
        expect(row).toContain(`"'=HYPERLINK(""x"")"`);
        expect(toCsv([log({ note: '-cmd' })])).toContain("'-cmd");
    });

    it('keeps real negative numbers as numbers', () => {
        expect(toCsv([log({ net: -2.5 })])).toContain(',-2.50,');
    });
});
