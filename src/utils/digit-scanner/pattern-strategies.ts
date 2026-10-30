import { CONTRACTS } from './contracts';
import type { TradeKind } from './contracts';
import type { Direction, EnsembleResult, Recommendation, StrategyResult } from './types';

/**
 * Pattern strategies for Matches/Differs, Even/Odd and Over/Under.
 *
 * These are heuristics that describe recent digit history. They are the user's chosen alternatives to
 * the conservative statistical ensemble and use looser thresholds, so they signal more often. A signal
 * is a description of past ticks, not a forecast: on fair random digits none of these has an edge.
 * Scores are heuristic indices, never win probabilities.
 */

export interface PatternStrategyInfo {
    id: string;
    name: string;
    /** One-line description shown next to the strategy toggle. */
    summary: string;
    /** Honest caveat shown to the user. */
    caution?: string;
}

export const PATTERN_STRATEGY_INFO: readonly PatternStrategyInfo[] = [
    { id: 'hot_cold', name: 'Hot & Cold Frequency', summary: 'Which digit or side has run hot over the last 100 / 10 ticks.', caution: 'For Matches/Differs it always votes: with no hot digit it picks Differs on the last digit.' },
    { id: 'streak_reversal', name: 'Streak Reversal', summary: 'Bets that a run of the same digit or side ends.', caution: 'Assumes a streak is "due" to end (gambler\'s fallacy).' },
    { id: 'momentum', name: 'Momentum Continuation', summary: 'Bets that the last 10 ticks keep leaning the same way.' },
    { id: 'skew', name: 'Distribution Skew', summary: 'Long-window (up to 500 ticks) bias away from a fair split.' },
    { id: 'transition', name: 'Transition Memory', summary: 'What historically followed the current digit or parity.' },
    { id: 'recency', name: 'Recency Shift', summary: 'Exponentially weighted share that favours the newest ticks.' },
    { id: 'balance_reversion', name: 'Balance Reversion', summary: 'Bets a side or digit that ran short will catch up.', caution: 'Assumes a correction is owed (gambler\'s fallacy).' },
    { id: 'cycle', name: 'Cycle & Alternation', summary: 'Detects a short repeating cycle and projects the next slot.' },
];

export const PATTERN_STRATEGY_IDS: readonly string[] = PATTERN_STRATEGY_INFO.map(s => s.id);

// ───────────────────────── helpers ─────────────────────────

type Side = 'over' | 'under';
type HotCold = 'hot' | 'cold';

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Fair-stream rate of "over t" (digit > t) or "under t" (digit < t). */
const fairRate = (threshold: number, side: Side) => (side === 'over' ? 9 - threshold : threshold) / 10;

const zScore = (share: number, n: number, p: number) =>
    n > 0 && p > 0 && p < 1 ? (share - p) / Math.sqrt((p * (1 - p)) / n) : 0;

/** z-score to confidence-style strength, 52..cap. */
const confidenceFromZ = (z: number, cap = 93) => clamp(Math.round(50 + 8 * Math.abs(z)), 52, cap);

interface Sample {
    n: number;
    share: (predicate: (digit: number) => boolean) => number;
}

const sampleOf = (digits: readonly number[]): Sample => ({
    n: digits.length,
    share: predicate => (digits.length ? digits.filter(predicate).length / digits.length : 0),
});

/** Sample where newer ticks weigh more. n is the Kish effective sample size. */
const weightedSample = (digits: readonly number[], decay: number): Sample => {
    const weights = digits.map((_, i) => Math.pow(decay, digits.length - 1 - i));
    const sum = weights.reduce((a, b) => a + b, 0);
    const sumSq = weights.reduce((a, b) => a + b * b, 0);
    return {
        n: sumSq ? (sum * sum) / sumSq : 0,
        share: predicate => (sum ? digits.reduce((acc, d, i) => acc + (predicate(d) ? weights[i] : 0), 0) / sum : 0),
    };
};

interface Threshold {
    side: Side;
    threshold: number;
    pct: number;
    baseline: number;
    lift: number;
    z: number;
    qualified: boolean;
}

// Only thresholds whose fair hit rate is 40%-75% are considered "safe" candidates.
const inBand = (t: number, side: Side) => {
    const rate = (side === 'over' ? 9 - t : t) * 10;
    return rate >= 40 && rate <= 75;
};
const OVER_THRESHOLDS = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter(t => inBand(t, 'over'));
const UNDER_THRESHOLDS = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(t => inBand(t, 'under'));

const qualifies = (m: Threshold, zMin: number, mode: HotCold) =>
    (mode === 'hot' ? m.z >= zMin : m.z <= -zMin) && Math.abs(m.lift) >= 5;

const thresholdScore = (m: Threshold) => Math.abs(m.z * m.lift);

/** Best Over (or Under) threshold; falls back to the most extreme unqualified one. */
function bestThreshold(sample: Sample, side: Side, zMin = 1.6, mode: HotCold = 'hot'): Threshold {
    let best: Threshold | null = null;
    let extreme: Threshold | null = null;
    for (const t of side === 'over' ? OVER_THRESHOLDS : UNDER_THRESHOLDS) {
        const p = fairRate(t, side);
        const share = sample.share(d => (side === 'over' ? d > t : d < t));
        const m: Threshold = {
            side,
            threshold: t,
            pct: share * 100,
            baseline: p * 100,
            lift: ((share - p) / p) * 100,
            z: zScore(share, sample.n, p),
            qualified: false,
        };
        if (qualifies(m, zMin, mode) && (!best || thresholdScore(m) > thresholdScore(best))) {
            best = { ...m, qualified: true };
        }
        if (!extreme || (mode === 'hot' ? m.z > extreme.z : m.z < extreme.z)) extreme = m;
    }
    return best ?? (extreme as Threshold);
}

function bestOverUnder(sample: Sample, zMin = 1.6, mode: HotCold = 'hot'): Threshold {
    const over = bestThreshold(sample, 'over', zMin, mode);
    const under = bestThreshold(sample, 'under', zMin, mode);
    if (over.qualified !== under.qualified) return over.qualified ? over : under;
    return thresholdScore(over) >= thresholdScore(under) ? over : under;
}

/** Barrier digit to use when a strategy only knows the side. */
const defaultBarrier = (digits: readonly number[], side: Side) => {
    const found = bestThreshold(sampleOf(digits), side, 0);
    return found.qualified ? found.threshold : side === 'over' ? 3 : 6;
};

function hotCold(sample: Sample) {
    let hot = { digit: 0, z: -Infinity, pct: 0 };
    let cold = { digit: 0, z: Infinity, pct: 0 };
    for (let d = 0; d < 10; d++) {
        const share = sample.share(x => x === d);
        const z = zScore(share, sample.n, 0.1);
        if (z > hot.z) hot = { digit: d, z, pct: share * 100 };
        if (z < cold.z) cold = { digit: d, z, pct: share * 100 };
    }
    return { hot, cold };
}

const runLength = (digits: readonly number[], predicate: (digit: number) => boolean) => {
    let run = 0;
    for (let i = digits.length - 1; i >= 0 && predicate(digits[i]); i--) run++;
    return run;
};

function detectCycle(seq: readonly string[], repeats: number, maxPeriod = 4) {
    for (let period = 2; period <= maxPeriod; period++) {
        const need = period * repeats;
        if (seq.length < need) continue;
        const tail = seq.slice(-need);
        if (new Set(tail).size < 2) continue;
        let ok = true;
        for (let i = period; i < tail.length; i++) {
            if (tail[i] !== tail[i - period]) {
                ok = false;
                break;
            }
        }
        if (ok) return { period, next: tail[tail.length - period], pattern: tail.join('') };
    }
    return null;
}

// ───────────────────────── raw result plumbing ─────────────────────────

interface Pick {
    direction: Direction;
    digit?: number;
}

type Raw =
    | { kind: 'signal'; pick: Pick; confidence: number; reason: string }
    | { kind: 'abstain'; reason: string }
    | { kind: 'ineligible'; reason: string };

const signal = (direction: Direction, digit: number | undefined, confidence: number, reason: string): Raw => ({
    kind: 'signal',
    pick: { direction, digit },
    confidence,
    reason,
});
const abstain = (reason: string): Raw => ({ kind: 'abstain', reason });
const needs = (reason: string): Raw => ({ kind: 'ineligible', reason });

const pct = (x: number, digits = 1) => (100 * x).toFixed(digits);
const directionOf = (t: Threshold): Direction => (t.side === 'over' ? 'OVER' : 'UNDER');

type RawStrategy = (digits: readonly number[], kind: TradeKind) => Raw;

// ───────────────────────── the eight strategies ─────────────────────────

const hotCold_: RawStrategy = (digits, kind) => {
    if (digits.length < 30) return needs('Insufficient data (needs 30 ticks).');
    const long = sampleOf(digits.slice(-100));
    const recent = digits.slice(-10);

    if (kind === 'even_odd') {
        const share = long.share(d => d % 2 === 0);
        const z = zScore(share, long.n, 0.5);
        if (z >= 1.6) return signal('EVEN', undefined, confidenceFromZ(z), `Even ran ${pct(share)}% of the last ${long.n} ticks (${z.toFixed(1)}σ above an even split).`);
        if (z <= -1.6) return signal('ODD', undefined, confidenceFromZ(z), `Odd ran ${pct(1 - share)}% of the last ${long.n} ticks (${Math.abs(z).toFixed(1)}σ above an even split).`);
        return abstain('Even/odd split sits inside its normal range.');
    }
    if (kind === 'over_under') {
        const t = bestOverUnder(long, 1.6);
        return t.qualified
            ? signal(directionOf(t), t.threshold, confidenceFromZ(t.z), `${CONTRACTS[directionOf(t)].label} ${t.threshold} hit ${t.pct.toFixed(1)}% of the last ${long.n} ticks vs ${t.baseline.toFixed(0)}% fair.`)
            : abstain('No safe threshold runs far enough above its fair rate.');
    }
    const counts = new Array(10).fill(0);
    recent.forEach(d => counts[d]++);
    let top = 0;
    for (let d = 1; d < 10; d++) if (counts[d] > counts[top]) top = d;
    if (counts[top] >= 4) {
        return signal('MATCHES', top, Math.min(52 + 8 * counts[top], 90), `Digit ${top} appeared ${counts[top]}/10 recently (hot).`);
    }
    const last = digits[digits.length - 1];
    return signal('DIFFERS', last, 58, `No hot digit in the last 10 ticks; low-information fallback picks Differs on the last digit (${last}).`);
};

const streakReversal: RawStrategy = (digits, kind) => {
    if (digits.length < 10) return needs('Insufficient data (needs 10 ticks).');
    if (kind === 'even_odd') {
        const evens = runLength(digits, d => d % 2 === 0);
        const odds = runLength(digits, d => d % 2 !== 0);
        if (evens >= 4) return signal('ODD', undefined, Math.min(58 + 6 * evens, 92), `Even streak x${evens}; betting the run ends.`);
        if (odds >= 4) return signal('EVEN', undefined, Math.min(58 + 6 * odds, 92), `Odd streak x${odds}; betting the run ends.`);
        return abstain('No qualifying streak.');
    }
    if (kind === 'over_under') {
        const high = runLength(digits, d => d > 4);
        const low = runLength(digits, d => d <= 4);
        if (high >= 3) {
            const b = defaultBarrier(digits.slice(-60), 'under');
            return signal('UNDER', b, Math.min(58 + 6 * high, 90), `${high} straight ticks above 4; betting a drop, called at Under ${b}.`);
        }
        if (low >= 3) {
            const b = defaultBarrier(digits.slice(-60), 'over');
            return signal('OVER', b, Math.min(58 + 6 * low, 90), `${low} straight ticks at 4 or below; betting a rise, called at Over ${b}.`);
        }
        return abstain('No qualifying streak.');
    }
    const last = digits[digits.length - 1];
    const run = runLength(digits, d => d === last);
    return run >= 3
        ? signal('DIFFERS', last, Math.min(60 + 8 * run, 92), `Digit ${last} on a x${run} streak; betting it does not repeat.`)
        : abstain('No qualifying streak.');
};

const momentum: RawStrategy = (digits, kind) => {
    if (digits.length < 10) return needs('Insufficient data (needs 10 ticks).');
    const last10 = digits.slice(-10);
    if (kind === 'even_odd') {
        const evens = last10.filter(d => d % 2 === 0).length;
        if (evens >= 7) return signal('EVEN', undefined, 55 + 3 * evens, `Even momentum ${evens}/10 recent ticks.`);
        if (10 - evens >= 7) return signal('ODD', undefined, 55 + 3 * (10 - evens), `Odd momentum ${10 - evens}/10 recent ticks.`);
        return abstain('No dominant momentum.');
    }
    if (kind === 'over_under') {
        const high = last10.filter(d => d > 4).length;
        const recent30 = digits.slice(-30);
        if (high >= 7) {
            const b = defaultBarrier(recent30, 'over');
            return signal('OVER', b, 55 + 3 * high, `Over momentum ${high}/10 recent ticks; Over ${b} is the level the last 30 favour.`);
        }
        if (10 - high >= 7) {
            const b = defaultBarrier(recent30, 'under');
            return signal('UNDER', b, 55 + 3 * (10 - high), `Under momentum ${10 - high}/10 recent ticks; Under ${b} is the level the last 30 favour.`);
        }
        return abstain('No dominant momentum.');
    }
    const counts = new Array(10).fill(0);
    last10.forEach(d => counts[d]++);
    let top = 0;
    for (let d = 1; d < 10; d++) if (counts[d] > counts[top]) top = d;
    return counts[top] >= 4
        ? signal('MATCHES', top, Math.min(55 + 8 * counts[top], 90), `Digit ${top} repeating, ${counts[top]}/10 recent ticks.`)
        : abstain('No dominant momentum.');
};

const skew: RawStrategy = (digits, kind) => {
    const window = digits.slice(-500);
    if (window.length < 120) return needs('Needs 120+ ticks.');
    const s = sampleOf(window);
    if (kind === 'even_odd') {
        const share = s.share(d => d % 2 === 0);
        const z = zScore(share, s.n, 0.5);
        if (Math.abs(z) < 2) return abstain(`Even/odd sits ${Math.abs(z).toFixed(1)}σ from fair (no skew).`);
        return signal(z > 0 ? 'EVEN' : 'ODD', undefined, confidenceFromZ(z), `${z > 0 ? 'Even' : 'Odd'} holds ${pct(z > 0 ? share : 1 - share)}% across ${s.n} ticks (${Math.abs(z).toFixed(1)}σ skew).`);
    }
    if (kind === 'over_under') {
        const t = bestOverUnder(s, 2);
        return t.qualified
            ? signal(directionOf(t), t.threshold, confidenceFromZ(t.z), `${CONTRACTS[directionOf(t)].label} ${t.threshold} holds ${t.pct.toFixed(1)}% across ${s.n} ticks vs ${t.baseline.toFixed(0)}% fair (${t.z.toFixed(1)}σ).`)
            : abstain('Long-window spread sits close to fair.');
    }
    const { hot, cold } = hotCold(s);
    if (hot.z >= 2.8) return signal('MATCHES', hot.digit, confidenceFromZ(hot.z), `Digit ${hot.digit} holds ${hot.pct.toFixed(1)}% of ${s.n} ticks vs 10% fair (${hot.z.toFixed(1)}σ over-represented).`);
    if (cold.z <= -2.8) return signal('DIFFERS', cold.digit, confidenceFromZ(cold.z), `Digit ${cold.digit} shows in only ${cold.pct.toFixed(1)}% of ${s.n} ticks (${Math.abs(cold.z).toFixed(1)}σ under-represented).`);
    return abstain('Digit spread is close to uniform.');
};

const transition: RawStrategy = (digits, kind) => {
    if (digits.length < 200) return needs('Needs 200+ ticks.');
    const last = digits[digits.length - 1];
    if (kind === 'even_odd') {
        const parity = last % 2;
        const next: number[] = [];
        for (let i = 0; i < digits.length - 1; i++) if (digits[i] % 2 === parity) next.push(digits[i + 1]);
        if (next.length < 60) return needs('Not enough matching transitions.');
        const s = sampleOf(next);
        const share = s.share(d => d % 2 === 0);
        const z = zScore(share, s.n, 0.5);
        if (Math.abs(z) < 1.8) return abstain(`Nothing follows ${parity ? 'an odd' : 'an even'} tick reliably.`);
        return signal(z > 0 ? 'EVEN' : 'ODD', undefined, confidenceFromZ(z), `After ${parity ? 'an odd' : 'an even'} tick, ${z > 0 ? 'even' : 'odd'} followed ${pct(z > 0 ? share : 1 - share)}% of ${s.n} times.`);
    }
    const next: number[] = [];
    for (let i = 0; i < digits.length - 1; i++) if (digits[i] === last) next.push(digits[i + 1]);
    if (next.length < 40) return needs(`Only ${next.length} ticks have ever followed a ${last}.`);
    const s = sampleOf(next);
    if (kind === 'over_under') {
        const t = bestOverUnder(s, 1.8);
        return t.qualified
            ? signal(directionOf(t), t.threshold, confidenceFromZ(t.z), `After a ${last}, ${CONTRACTS[directionOf(t)].label} ${t.threshold} landed ${t.pct.toFixed(1)}% of ${s.n} times vs ${t.baseline.toFixed(0)}% fair.`)
            : abstain(`Nothing consistent follows a ${last}.`);
    }
    const { hot, cold } = hotCold(s);
    if (hot.z >= 2.8) return signal('MATCHES', hot.digit, confidenceFromZ(hot.z), `${hot.digit} follows a ${last} ${hot.pct.toFixed(1)}% of ${s.n} times vs 10% fair.`);
    if (cold.z <= -2.8) return signal('DIFFERS', cold.digit, confidenceFromZ(cold.z), `${cold.digit} rarely follows a ${last} (${cold.pct.toFixed(1)}% of ${s.n} times).`);
    return abstain(`Nothing consistent follows a ${last}.`);
};

const RECENCY_DECAY = 0.9726549474122855; // half-life about 25 ticks

const recency: RawStrategy = (digits, kind) => {
    if (digits.length < 60) return needs('Needs 60+ ticks.');
    const s = weightedSample(digits.slice(-200), RECENCY_DECAY);
    const effective = Math.round(s.n);
    if (kind === 'even_odd') {
        const share = s.share(d => d % 2 === 0);
        const z = zScore(share, s.n, 0.5);
        if (Math.abs(z) < 1.8) return abstain('Recent ticks show no parity drift.');
        return signal(z > 0 ? 'EVEN' : 'ODD', undefined, confidenceFromZ(z), `Weighted toward the newest ticks, ${z > 0 ? 'even' : 'odd'} holds ${pct(z > 0 ? share : 1 - share)}% (about ${effective} ticks of weight).`);
    }
    if (kind === 'over_under') {
        const t = bestOverUnder(s, 1.8);
        return t.qualified
            ? signal(directionOf(t), t.threshold, confidenceFromZ(t.z), `Weighted toward the newest ticks, ${CONTRACTS[directionOf(t)].label} ${t.threshold} holds ${t.pct.toFixed(1)}% vs ${t.baseline.toFixed(0)}% fair (about ${effective} ticks of weight).`)
            : abstain('Recent ticks show no threshold drift.');
    }
    const { hot, cold } = hotCold(s);
    if (hot.z >= 2.8) return signal('MATCHES', hot.digit, confidenceFromZ(hot.z), `Digit ${hot.digit} is running hot in the newest ticks (${hot.pct.toFixed(1)}% weighted share).`);
    if (cold.z <= -2.8) return signal('DIFFERS', cold.digit, confidenceFromZ(cold.z), `Digit ${cold.digit} has gone quiet in the newest ticks (${cold.pct.toFixed(1)}% weighted share).`);
    return abstain('Recent ticks track the long-run spread.');
};

const balanceReversion: RawStrategy = (digits, kind) => {
    const window = digits.slice(-200);
    if (window.length < 80) return needs('Needs 80+ ticks.');
    const s = sampleOf(window);
    if (kind === 'even_odd') {
        const share = s.share(d => d % 2 === 0);
        const z = zScore(share, s.n, 0.5);
        if (z <= -1.8) return signal('EVEN', undefined, confidenceFromZ(z, 88), `Even has only ${pct(share)}% of the last ${s.n} ticks (running ${Math.abs(z).toFixed(1)}σ short).`);
        if (z >= 1.8) return signal('ODD', undefined, confidenceFromZ(z, 88), `Odd has only ${pct(1 - share)}% of the last ${s.n} ticks (running ${z.toFixed(1)}σ short).`);
        return abstain('Even/odd is close to balanced.');
    }
    if (kind === 'over_under') {
        const t = bestOverUnder(s, 1.8, 'cold');
        return t.qualified
            ? signal(directionOf(t), t.threshold, confidenceFromZ(t.z, 88), `${CONTRACTS[directionOf(t)].label} ${t.threshold} landed only ${t.pct.toFixed(1)}% of ${s.n} ticks vs ${t.baseline.toFixed(0)}% fair; betting a correction.`)
            : abstain('No threshold is running short of its fair rate.');
    }
    let overdue = -1;
    let longest = -1;
    for (let d = 0; d < 10; d++) {
        let gap = digits.length;
        for (let i = digits.length - 1; i >= 0; i--) {
            if (digits[i] === d) {
                gap = digits.length - 1 - i;
                break;
            }
        }
        if (gap > longest) {
            longest = gap;
            overdue = d;
        }
    }
    if (longest < 35) return abstain(`Longest gap is only ${longest} ticks; nothing overdue.`);
    return signal('MATCHES', overdue, clamp(Math.round(55 + (longest - 35) * 1.2), 55, 88), `Digit ${overdue} unseen for ${longest} ticks (${(100 * Math.pow(0.9, longest)).toFixed(1)}% chance of a gap this long in a fair stream). A long gap does not make the digit due.`);
};

const cycle: RawStrategy = (digits, kind) => {
    if (digits.length < 12) return needs('Insufficient data (needs 12 ticks).');
    const recent = digits.slice(-24);
    if (kind === 'even_odd') {
        const found = detectCycle(recent.map(d => (d % 2 === 0 ? 'E' : 'O')), 3);
        return found
            ? signal(found.next === 'E' ? 'EVEN' : 'ODD', undefined, clamp(60 + 4 * found.period, 60, 86), `Parity locked on a ${found.period}-tick cycle (${found.pattern}); next slot is ${found.next === 'E' ? 'even' : 'odd'}.`)
            : abstain('Parity shows no repeating cycle.');
    }
    if (kind === 'over_under') {
        const found = detectCycle(recent.map(d => (d > 4 ? 'H' : 'L')), 3);
        if (!found) return abstain('Halves show no repeating cycle.');
        const over = found.next === 'H';
        const b = defaultBarrier(digits.slice(-60), over ? 'over' : 'under');
        return signal(over ? 'OVER' : 'UNDER', b, clamp(60 + 4 * found.period, 60, 86), `Halves locked on a ${found.period}-tick cycle (${found.pattern}); next slot is the ${over ? '5-9' : '0-4'} half.`);
    }
    const found = detectCycle(recent.map(String), 2);
    return found
        ? signal('MATCHES', Number(found.next), clamp(58 + 3 * found.period, 58, 82), `Digits repeating on a ${found.period}-tick cycle (${found.pattern}); next slot is ${found.next}.`)
        : abstain('Digits show no repeating cycle.');
};

const RAW_STRATEGIES: Record<string, RawStrategy> = {
    hot_cold: hotCold_,
    streak_reversal: streakReversal,
    momentum,
    skew,
    transition,
    recency,
    balance_reversion: balanceReversion,
    cycle,
};

// ───────────────────────── public API ─────────────────────────

export function runPatternStrategy(id: string, digits: readonly number[], kind: TradeKind): StrategyResult {
    const info = PATTERN_STRATEGY_INFO.find(s => s.id === id);
    const run = RAW_STRATEGIES[id];
    if (!info || !run) throw new RangeError(`Unknown pattern strategy: ${id}`);
    const raw = run(digits, kind);
    if (raw.kind === 'signal') {
        return {
            id,
            name: info.name,
            status: 'signal',
            signal: raw.pick.direction,
            direction: raw.pick.direction,
            digit: raw.pick.digit,
            strength: clamp(raw.confidence, 0, 100) / 100,
            reason: raw.reason,
        };
    }
    return { id, name: info.name, status: raw.kind, signal: 'ABSTAIN', reason: raw.reason };
}

export interface AnalyzePatternOptions {
    /** Strategy ids to run. Default: all eight. An empty list is rejected. */
    strategyIds?: readonly string[];
    /** Minimum strategies that must agree on the same pick (default 1). */
    minAgree?: number;
}

const kindDirections = (kind: TradeKind): Direction[] =>
    (Object.keys(CONTRACTS) as Direction[]).filter(d => CONTRACTS[d].kind === kind);

const argOf = (result: StrategyResult) => (result.digit === undefined ? '' : String(result.digit));

/**
 * Runs the selected strategies and combines their votes into one pick.
 *
 * Rule (deterministic): votes are grouped by direction; the direction with the highest
 * 100*agreeing + 30*votes + total strength wins; within it, the digit with the most votes (then highest
 * total strength, then lowest digit) is chosen. The heuristic score is the average strength of the
 * agreeing strategies, scaled by their share of total strength. It is an index, not a probability.
 */
export function analyzePattern(
    digits: readonly number[],
    kind: TradeKind,
    options?: AnalyzePatternOptions
): EnsembleResult {
    const ids = options?.strategyIds ?? PATTERN_STRATEGY_IDS;
    const minAgree = Math.max(1, Math.floor(options?.minAgree ?? 1));

    if (ids.length === 0) {
        return { strategies: [], recommendation: null, reason: 'No strategies selected.' };
    }
    if (digits.length === 0 || digits.some(d => !Number.isInteger(d) || d < 0 || d > 9)) {
        return {
            strategies: [],
            recommendation: null,
            reason: 'Invalid digit sequence: expected a non-empty array of integers from 0 to 9.',
        };
    }

    const strategies = ids.map(id => runPatternStrategy(id, digits, kind));
    const eligible = strategies.filter(s => s.status !== 'ineligible').length;
    if (eligible === 0) return { strategies, recommendation: null, reason: 'No eligible strategies.' };

    const allowed = new Set(kindDirections(kind));
    const votes = strategies.filter(s => s.status === 'signal' && s.direction && allowed.has(s.direction));
    if (votes.length === 0) return { strategies, recommendation: null, reason: 'No strategy produced a valid signal.' };

    const strength = (s: StrategyResult) => (s.strength ?? 0) * 100;

    const groups = new Map<Direction, StrategyResult[]>();
    for (const v of votes) {
        const list = groups.get(v.direction as Direction) ?? [];
        list.push(v);
        groups.set(v.direction as Direction, list);
    }

    const bestDigitFor = (list: StrategyResult[]) => {
        const byArg = new Map<string, { count: number; total: number }>();
        for (const v of list) {
            const entry = byArg.get(argOf(v)) ?? { count: 0, total: 0 };
            entry.count += 1;
            entry.total += strength(v);
            byArg.set(argOf(v), entry);
        }
        return [...byArg.entries()].sort(
            (a, b) =>
                b[1].count - a[1].count ||
                b[1].total - a[1].total ||
                (a[0] === '' ? -1 : b[0] === '' ? 1 : Number(a[0]) - Number(b[0]))
        )[0][0];
    };

    const ranked = [...groups.entries()]
        .map(([direction, list]) => {
            const arg = bestDigitFor(list);
            const agreeing = list.filter(v => argOf(v) === arg);
            const total = list.reduce((a, v) => a + strength(v), 0);
            return { direction, arg, agreeing, rank: 100 * agreeing.length + 30 * list.length + total };
        })
        .sort((a, b) => b.rank - a.rank || a.direction.localeCompare(b.direction));

    const winner = ranked[0];
    if (winner.agreeing.length < minAgree) {
        return {
            strategies,
            recommendation: null,
            reason: `Consensus not reached: ${winner.agreeing.length} agreeing strategy(ies); ${minAgree} required.`,
        };
    }

    const agreeingStrength = winner.agreeing.reduce((a, v) => a + strength(v), 0);
    const allStrength = votes.reduce((a, v) => a + strength(v), 0);
    const score = clamp(
        Math.round((agreeingStrength / winner.agreeing.length) * (0.72 + 0.38 * (allStrength > 0 ? agreeingStrength / allStrength : 1))),
        1,
        96
    );

    const recommendation: Recommendation = {
        direction: winner.direction,
        digit: winner.arg === '' ? null : Number(winner.arg),
        agree: winner.agreeing.length,
        disagree: votes.length - winner.agreeing.length,
        eligible,
        heuristicScore: score,
    };
    return { strategies, recommendation };
}
