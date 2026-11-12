import type { BulkConfig, BulkStrategy, ContractSpec, SignalResult } from '../types';

const MIN = 120;
const valid = (x: number) => Number.isFinite(x) && x > 0;
const digit = (x: number) => Number(String(Math.abs(x)).replace('.', '').slice(-1));
const ds = (ticks: readonly number[]) => ticks.slice(-120).filter(valid).map(digit);
const out = (trade: boolean, score: number, reason: string): SignalResult => ({ trade, score, reason });
const settle = (ticks: readonly number[], spec: ContractSpec, f: (d: number) => boolean) => !ticks.length ? undefined : f(digit(ticks[0]));
const contract = (type: string, barrier?: string): ContractSpec => ({ contract_type: type, duration: 1, duration_unit: 't', ...(barrier === undefined ? {} : { barrier }) });

export const nexusEvenOdd: BulkStrategy = {
    id: 'nexus-even-odd', label: 'Nexus Even / Odd', description: 'Parity frequency with a Nexus-style confidence gate.', minTicks: MIN, bufferSize: 120, ticksToSettle: 1,
    contract: () => contract('DIGITEVEN'),
    evaluate: ticks => { const x = ds(ticks); const even = x.filter(d => d % 2 === 0).length / Math.max(1, x.length); return x.length < MIN ? out(false, even, `Need ${MIN} ticks, have ${x.length}.`) : out(Math.max(even, 1 - even) >= 0.54, Math.max(even, 1 - even), even >= 0.5 ? 'Even selected.' : 'Odd selected.'); },
    settle: (ticks, spec) => settle(ticks, spec, d => spec.contract_type === 'DIGITEVEN' ? d % 2 === 0 : d % 2 === 1),
};

export const nexusRiseFall: BulkStrategy = {
    id: 'nexus-rise-fall', label: 'Nexus Rise / Fall', description: 'Short continuation score for CALL or PUT.', minTicks: MIN, bufferSize: 120, ticksToSettle: 1,
    contract: () => contract('CALL'),
    evaluate: ticks => { const x = ticks.slice(-120).filter(valid); const up = x.slice(1).filter((q, i) => q > x[i]).length / Math.max(1, x.length - 1); return x.length < MIN ? out(false, up, `Need ${MIN} ticks, have ${x.length}.`) : out(Math.max(up, 1 - up) >= 0.54, Math.max(up, 1 - up), up >= 0.5 ? 'Rise selected.' : 'Fall selected.'); },
    settle: (ticks, spec) => ticks.length < 2 ? undefined : spec.contract_type === 'CALL' ? ticks[1] > ticks[0] : ticks[1] < ticks[0],
};

export const nexusOverUnder: BulkStrategy = {
    id: 'nexus-over-under', label: 'Nexus Over / Under', description: 'Last-digit threshold frequency.', minTicks: MIN, bufferSize: 120, ticksToSettle: 1,
    contract: () => contract('DIGITOVER', '4'),
    evaluate: ticks => { const x = ds(ticks); const over = x.filter(d => d > 4).length / Math.max(1, x.length); return x.length < MIN ? out(false, over, `Need ${MIN} ticks, have ${x.length}.`) : out(Math.max(over, 1 - over) >= 0.54, Math.max(over, 1 - over), over >= 0.5 ? 'Over 4 selected.' : 'Under 5 selected.'); },
    settle: (ticks, spec) => settle(ticks, spec, d => spec.contract_type === 'DIGITOVER' ? d > 4 : d < 5),
};

export const nexusMatchesDiffers: BulkStrategy = {
    id: 'nexus-matches-differs', label: 'Nexus Matches / Differs', description: 'Most/least frequent last-digit heuristic.', minTicks: MIN, bufferSize: 120, ticksToSettle: 1,
    contract: () => contract('DIGITMATCH', '0'),
    evaluate: ticks => { const x = ds(ticks); const counts = Array(10).fill(0); x.forEach(d => counts[d]++); const hi = counts.indexOf(Math.max(...counts)); const lo = counts.indexOf(Math.min(...counts)); const match = counts[hi] / Math.max(1, x.length); return x.length < MIN ? out(false, match, `Need ${MIN} ticks, have ${x.length}.`) : out(match >= 0.16, match, `Matches ${hi} selected at ${(match * 100).toFixed(1)}%.`); },
    settle: (ticks, spec) => settle(ticks, spec, d => spec.contract_type === 'DIGITMATCH' ? d === Number(spec.barrier) : d !== Number(spec.barrier)),
};
