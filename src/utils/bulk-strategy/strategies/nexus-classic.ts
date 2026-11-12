import type { BulkConfig, BulkStrategy, ContractSpec, MarketTick, TradeIntent, SignalResult } from '../types';

const MIN = 120;
const BUFFER = 120;
const valid = (x: number) => Number.isFinite(x) && x > 0;
const digit = (x: number) => Number(String(Math.abs(x)).replace('.', '').slice(-1));
const digits = (ticks: readonly number[]) => ticks.slice(-BUFFER).filter(valid).map(digit);
const freq = (xs: readonly number[], d: number) => xs.length ? xs.filter(x => x === d).length / xs.length : 0;
const result = (trade: boolean, score: number, reason: string): SignalResult => ({ trade, score, reason });
const settlement = (ticks: readonly number[], spec: ContractSpec, test: (d: number) => boolean) => {
    if (!ticks.length) return undefined;
    if (spec.duration > 1 && ticks.length < spec.duration) return undefined;
    return test(digit(ticks[0]));
};

export const nexusDigitPrinter: BulkStrategy = {
    id: 'nexus-digit-printer', label: 'Nexus Digit Printer',
    description: 'Transition-weighted DIGITMATCH using recent last-digit behaviour.', minTicks: MIN, bufferSize: BUFFER, ticksToSettle: 1,
    contract: () => ({ contract_type: 'DIGITMATCH', duration: 1, duration_unit: 't', barrier: '0' }),
    evaluate: ticks => {
        const ds = digits(ticks); if (ds.length < MIN) return result(false, null as any, `Need ${MIN} ticks, have ${ds.length}.`);
        const current = ds[ds.length - 1]; const counts = Array(10).fill(0); let n = 0;
        for (let i = 1; i < ds.length; i++) if (ds[i - 1] === current) { counts[ds[i]]++; n++; }
        const choice = counts.map((x, d) => ({ d, p: n ? x / n : freq(ds, d) })).sort((a, b) => b.p - a.p)[0];
        return result(choice.p >= 0.13, choice.p, `Digit Printer selects Matches ${choice.d} at ${(choice.p * 100).toFixed(1)}%.`);
    },
    settle: (ticks, spec) => settlement(ticks, spec, d => d === Number(spec.barrier)),
};

export const nexusOver8Sniper: BulkStrategy = {
    id: 'nexus-over8-sniper', label: 'Nexus Over 8 Sniper',
    description: 'DIGITOVER 8 when recent digit-9 frequency is elevated.', minTicks: MIN, bufferSize: BUFFER, ticksToSettle: 5,
    contract: () => ({ contract_type: 'DIGITOVER', duration: 5, duration_unit: 't', barrier: '8' }),
    evaluate: ticks => { const ds = digits(ticks); const p = freq(ds, 9); return ds.length < MIN ? result(false, p, `Need ${MIN} ticks, have ${ds.length}.`) : result(p >= 0.14, p, `Digit 9 frequency is ${(p * 100).toFixed(1)}%.`); },
    settle: (ticks, spec) => settlement(ticks, spec, d => d > Number(spec.barrier)),
};

export const nexusAutoSwitcher: BulkStrategy = {
    id: 'nexus-auto-switcher', label: 'Nexus Auto Switcher',
    description: 'RUNHIGH/RUNLOW selected from recent price-direction persistence.', minTicks: MIN, bufferSize: BUFFER, ticksToSettle: 2,
    contract: config => ({ contract_type: 'RUNHIGH', duration: 2, duration_unit: 't' }),
    evaluate: ticks => { const xs = ticks.slice(-BUFFER).filter(valid); const ups = xs.slice(1).filter((x, i) => x > xs[i]).length / Math.max(1, xs.length - 1); return xs.length < MIN ? result(false, ups, `Need ${MIN} ticks, have ${xs.length}.`) : result(true, Math.max(ups, 1 - ups), ups >= 0.5 ? 'Auto Switcher selects RUNHIGH.' : 'Auto Switcher selects RUNLOW.'); },
    settle: (ticks, spec) => { if (ticks.length < 2) return undefined; return spec.contract_type === 'RUNHIGH' ? ticks[1] > ticks[0] : ticks[1] < ticks[0]; },
    createTradeIntents: (ticks: readonly MarketTick[]): TradeIntent[] => {
        const quotes = ticks.slice(-BUFFER).map(t => t.quote).filter(valid);
        if (quotes.length < MIN) return [];
        const ups = quotes.slice(1).filter((x, i) => x > quotes[i]).length / Math.max(1, quotes.length - 1);
        return [{ spec: { contract_type: ups >= 0.5 ? 'RUNHIGH' : 'RUNLOW', duration: 2, duration_unit: 't' } }];
    },
};

export const nexusOver2Under7: BulkStrategy = {
    id: 'nexus-over2-under7', label: 'Nexus Over 2 + Under 7',
    description: 'Two one-tick contracts covering digits 3 through 6.', minTicks: MIN, bufferSize: BUFFER, ticksToSettle: 1,
    contract: () => ({ contract_type: 'DIGITOVER', duration: 1, duration_unit: 't', barrier: '2' }),
    evaluate: ticks => { const ds = digits(ticks); const p = ds.filter(d => d >= 3 && d <= 6).length / Math.max(1, ds.length); return ds.length < MIN ? result(false, p, `Need ${MIN} ticks, have ${ds.length}.`) : result(p >= 0.5, p, `Middle-digit share is ${(p * 100).toFixed(1)}%.`); },
    settle: (ticks, spec) => settlement(ticks, spec, d => spec.contract_type === 'DIGITOVER' ? d > 2 : d < 7),
    createTradeIntents: () => [
        { spec: { contract_type: 'DIGITOVER', duration: 1, duration_unit: 't', barrier: '2' } },
        { spec: { contract_type: 'DIGITUNDER', duration: 1, duration_unit: 't', barrier: '7' } },
    ],
    batchSize: () => 2,
};
