// ============================================================
// Digit Scanner service — complete, self-contained.
// Uses the caller-supplied `sendRequest` (your authorized Deriv WS)
// to fetch active symbols and tick history, then runs the ensemble.
// ============================================================

export type Signal = 'MATCHES' | 'DIFFERS';

export interface StrategyOutput {
  id: string;
  name: string;
  signal: Signal | 'ABSTAIN';
  digit: number | null;
  reason: string;
  weight: number;
}

export interface EnsembleResult {
  signal: Signal;
  digit: number;
  score: number;          // 0..100 heuristic score (NOT a probability)
  agreeCount: number;
  eligibleCount: number;
  strategies: StrategyOutput[];
}

export type ScanStatus =
  | 'ok'
  | 'insufficient_data'
  | 'connection_error'
  | 'parse_error'
  | 'no_signal';

export interface MarketScanResult {
  symbol: string;
  displayName: string;
  status: ScanStatus;
  message?: string;
  ticksUsed: number;
  lastDigit?: number;
  ensemble?: EnsembleResult;
}

export interface ScanReport {
  generatedAt: number;
  minTicks: number;
  ranked: MarketScanResult[];
  excluded: MarketScanResult[];
  winner: MarketScanResult | null;
}

// ------------------------------------------------------------
// EDIT HERE: default market list. Symbol is the only required
// field. Precision is overridden automatically from active_symbols
// pip when available; the value here is only a fallback.
// ------------------------------------------------------------
export const DEFAULT_MARKETS: { symbol: string; displayName: string; precision: number }[] = [
  { symbol: 'R_10',      displayName: 'Volatility 10',       precision: 3 },
  { symbol: 'R_25',      displayName: 'Volatility 25',       precision: 3 },
  { symbol: 'R_50',      displayName: 'Volatility 50',       precision: 4 },
  { symbol: 'R_75',      displayName: 'Volatility 75',       precision: 4 },
  { symbol: 'R_100',     displayName: 'Volatility 100',      precision: 2 },
  { symbol: '1HZ10V',    displayName: 'Volatility 10 (1s)',  precision: 2 },
  { symbol: '1HZ25V',    displayName: 'Volatility 25 (1s)',  precision: 2 },
  { symbol: '1HZ50V',    displayName: 'Volatility 50 (1s)',  precision: 2 },
  { symbol: '1HZ75V',    displayName: 'Volatility 75 (1s)',  precision: 2 },
  { symbol: '1HZ100V',   displayName: 'Volatility 100 (1s)', precision: 2 },
];

// ---------------- Utilities ----------------

export function precisionFromPip(pip: string | number): number {
  const s = String(pip);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function extractDigits(quotes: number[], precision: number): number[] {
  return quotes.map((q) => {
    const s = q.toFixed(precision);
    return Number(s[s.length - 1]);
  });
}

function tally(digits: number[]): number[] {
  const c = new Array(10).fill(0);
  for (const d of digits) c[d]++;
  return c;
}

const abstain = (id: string, name: string, reason: string): StrategyOutput =>
  ({ id, name, signal: 'ABSTAIN', digit: null, reason, weight: 0 });

// ---------------- Heuristics ----------------

export function hDigitFrequency(d: number[]): StrategyOutput {
  const id = 'digitFrequency', name = 'Digit Frequency';
  const c = tally(d);
  const max = Math.max(...c), min = Math.min(...c);
  if (max - min < 3) return abstain(id, name, `Digit counts too even (min ${min}, max ${max}).`);
  const least = c.indexOf(min);
  return { id, name, signal: 'MATCHES', digit: least, weight: 1,
    reason: `Digit ${least} appeared ${min}x vs a high of ${max}x over ${d.length} ticks.` };
}

export function hRecentStreak(d: number[]): StrategyOutput {
  const id = 'recentStreak', name = 'Recent Streak';
  const last = d[d.length - 1];
  let run = 1;
  for (let i = d.length - 2; i >= 0 && d[i] === last; i--) run++;
  if (run < 3) return abstain(id, name, `Last digit ${last} ran ${run}x (needs 3+).`);
  return { id, name, signal: 'DIFFERS', digit: last, weight: 1,
    reason: `Digit ${last} repeated ${run} times consecutively.` };
}

export function hShortMomentum(d: number[]): StrategyOutput {
  const id = 'shortMomentum', name = 'Short-term Momentum';
  const w = Math.min(50, Math.floor(d.length / 4));
  if (w < 10) return abstain(id, name, 'Not enough ticks for a momentum window.');
  const recent = tally(d.slice(-w));
  const prior = tally(d.slice(-2 * w, -w));
  let best = 0, bestDelta = -Infinity;
  for (let i = 0; i < 10; i++) {
    const delta = recent[i] / w - prior[i] / w;
    if (delta > bestDelta) { bestDelta = delta; best = i; }
  }
  if (bestDelta <= 0) return abstain(id, name, 'No digit improving recently.');
  return { id, name, signal: 'MATCHES', digit: best, weight: 1,
    reason: `Digit ${best} frequency rose ${(bestDelta * 100).toFixed(1)}pp in the last ${w} ticks.` };
}

export function hDistributionSkew(d: number[]): StrategyOutput {
  const id = 'distributionSkew', name = 'Distribution Skew';
  const c = tally(d);
  const exp = d.length / 10;
  const chi = c.reduce((s, o) => s + (o - exp) ** 2 / exp, 0);
  if (chi < 16.92) return abstain(id, name, `Chi-square ${chi.toFixed(1)} below 16.92 threshold.`);
  const hottest = c.indexOf(Math.max(...c));
  return { id, name, signal: 'DIFFERS', digit: hottest, weight: 1,
    reason: `Distribution skewed (chi²=${chi.toFixed(1)}); digit ${hottest} over-represented.` };
}

export function hTransitions(d: number[]): StrategyOutput {
  const id = 'transitions', name = 'Transitions';
  if (d.length < 60) return abstain(id, name, 'Not enough ticks for transition counts.');
  const last = d[d.length - 1];
  const next = new Array(10).fill(0);
  let total = 0;
  for (let i = 0; i < d.length - 1; i++) {
    if (d[i] === last) { next[d[i + 1]]++; total++; }
  }
  if (total < 8) return abstain(id, name, `Only ${total} transitions after digit ${last}.`);
  const pick = next.indexOf(Math.max(...next));
  if (next[pick] === 0) return abstain(id, name, 'No successor observed.');
  return { id, name, signal: 'MATCHES', digit: pick, weight: 1,
    reason: `After digit ${last}, ${pick} followed ${next[pick]} of ${total} times.` };
}

export function hRecencyWeighted(d: number[]): StrategyOutput {
  const id = 'recencyWeighted', name = 'Recency Weighted';
  const halflife = Math.max(5, d.length / 5);
  const score = new Array(10).fill(0);
  d.forEach((digit, i) => { score[digit] += Math.exp(-(d.length - 1 - i) / halflife); });
  const pick = score.indexOf(Math.max(...score));
  const total = score.reduce((a, b) => a + b, 0);
  return { id, name, signal: 'MATCHES', digit: pick, weight: 1,
    reason: `Digit ${pick} holds ${((score[pick] / total) * 100).toFixed(1)}% of decay-weighted mass.` };
}

export function hGaps(d: number[]): StrategyOutput {
  const id = 'gaps', name = 'Gaps';
  const lastSeen = new Array(10).fill(-1);
  d.forEach((digit, i) => { lastSeen[digit] = i; });
  let pick = -1, gap = -1;
  for (let i = 0; i < 10; i++) {
    const g = d.length - 1 - lastSeen[i];
    if (g > gap) { gap = g; pick = i; }
  }
  if (gap < 10) return abstain(id, name, `Longest gap is only ${gap} ticks.`);
  return { id, name, signal: 'MATCHES', digit: pick, weight: 1,
    reason: `Digit ${pick} has not appeared for ${gap} ticks.` };
}

export function hRepeatingCycles(d: number[]): StrategyOutput {
  const id = 'repeatingCycles', name = 'Repeating Cycles';
  if (d.length < 80) return abstain(id, name, 'Not enough ticks for cycle detection.');
  let bestP = 0, bestScore = 0;
  for (let p = 2; p <= 25; p++) {
    let hits = 0, n = 0;
    for (let i = p; i < d.length; i++) { n++; if (d[i] === d[i - p]) hits++; }
    const s = hits / n;
    if (s > bestScore) { bestScore = s; bestP = p; }
  }
  if (bestScore < 0.15 || bestP === 0) {
    return abstain(id, name, `No period above 15% match (best ${(bestScore * 100).toFixed(1)}%).`);
  }
  const predicted = d[d.length - bestP];
  return { id, name, signal: 'MATCHES', digit: predicted, weight: 1,
    reason: `Period ${bestP} matched ${(bestScore * 100).toFixed(1)}% of ticks; predicts ${predicted}.` };
}

export const ALL_HEURISTICS = [
  hDigitFrequency, hRecentStreak, hShortMomentum, hDistributionSkew,
  hTransitions, hRecencyWeighted, hGaps, hRepeatingCycles,
];

// ---------------- Ensemble ----------------

export function combine(strategies: StrategyOutput[]): EnsembleResult {
  const eligible = strategies.filter(
    (s) => s.signal !== 'ABSTAIN' && s.digit !== null && s.weight > 0,
  );
  const totalWeight = eligible.reduce((s, x) => s + x.weight, 0);

  if (totalWeight === 0) {
    return {
      signal: 'MATCHES', digit: 0, score: 0,
      agreeCount: 0, eligibleCount: 0, strategies,
    };
  }

  const buckets = new Map<string, { signal: Signal; digit: number; weight: number; count: number }>();
  for (const s of eligible) {
    const key = `${s.signal}:${s.digit}`;
    const b = buckets.get(key) ?? { signal: s.signal as Signal, digit: s.digit!, weight: 0, count: 0 };
    b.weight += s.weight;
    b.count += 1;
    buckets.set(key, b);
  }

  const ordered = [...buckets.values()].sort(
    (a, b) =>
      b.weight - a.weight ||
      b.count - a.count ||
      (a.signal === b.signal ? a.digit - b.digit : a.signal === 'MATCHES' ? -1 : 1),
  );

  const top = ordered[0];
  return {
    signal: top.signal,
    digit: top.digit,
    score: Math.round((top.weight / totalWeight) * 100),
    agreeCount: top.count,
    eligibleCount: eligible.length,
    strategies,
  };
}

// ---------------- Scan orchestration ----------------

export interface ScanOptions {
  sendRequest: (payload: Record<string, unknown>) => Promise<any>;
  markets?: { symbol: string; displayName: string; precision: number }[];
  tickCount?: number;   // default 1000
  minTicks?: number;    // default 200
}

async function scanOne(
  sendRequest: ScanOptions['sendRequest'],
  m: { symbol: string; displayName: string; precision: number },
  pipMap: Map<string, number>,
  tickCount: number,
  minTicks: number,
): Promise<MarketScanResult> {
  const precision = pipMap.get(m.symbol) ?? m.precision;
  const base: MarketScanResult = {
    symbol: m.symbol, displayName: m.displayName,
    status: 'connection_error', ticksUsed: 0,
  };

  let resp: any;
  try {
    resp = await sendRequest({
      ticks_history: m.symbol,
      count: tickCount,
      end: 'latest',
      style: 'ticks',
    });
  } catch (e: any) {
    return { ...base, message: e?.message ?? 'Connection failed.' };
  }
  if (resp?.error) return { ...base, message: resp.error.message ?? 'API error.' };

  const quotes: number[] = (resp?.history?.prices ?? []).map(Number);
  if (!quotes.length) {
    return { ...base, status: 'parse_error', message: 'No tick history returned.' };
  }
  if (quotes.length < minTicks) {
    return { ...base, status: 'insufficient_data', ticksUsed: quotes.length,
      message: `Only ${quotes.length} ticks (need ${minTicks}).` };
  }

  const digits = extractDigits(quotes, precision);
  const strategies = ALL_HEURISTICS.map((h) => h(digits));
  const ensemble = combine(strategies);

  if (ensemble.eligibleCount === 0) {
    return { ...base, status: 'no_signal', ticksUsed: digits.length,
      message: 'All strategies abstained (no eligible signal).' };
  }

  return {
    symbol: m.symbol, displayName: m.displayName, status: 'ok',
    ticksUsed: digits.length,
    lastDigit: digits[digits.length - 1],
    ensemble,
  };
}

/**
 * Ranking rule (deterministic):
 *   1. Heuristic score, descending
 *   2. Agreeing-strategy count, descending
 *   3. Eligible-strategy count, descending
 *   4. Market symbol, ascending (stable tie-break)
 *
 * Markets that failed any data check are placed in `excluded`
 * and never eligible to win. They are NOT treated as a signal.
 */
export async function scanMarkets(opts: ScanOptions): Promise<ScanReport> {
  const sendRequest = opts.sendRequest;
  const markets = opts.markets ?? DEFAULT_MARKETS;
  const tickCount = opts.tickCount ?? 1000;
  const minTicks = opts.minTicks ?? 200;

  // Best-effort pip lookup so precision always comes from the source of truth.
  const pipMap = new Map<string, number>();
  try {
    const act: any = await sendRequest({ active_symbols: 'brief' });
    for (const s of act?.active_symbols ?? []) {
      if (s?.symbol && s?.pip !== undefined) {
        pipMap.set(s.symbol, precisionFromPip(s.pip));
      }
    }
  } catch {
    // Silent fallback — each market's configured precision is used.
  }

  const results: MarketScanResult[] = [];
  for (const m of markets) {
    results.push(await scanOne(sendRequest, m, pipMap, tickCount, minTicks));
  }

  const ranked = results
    .filter((r) => r.status === 'ok' && r.ensemble)
    .sort((a, b) =>
      b.ensemble!.score - a.ensemble!.score ||
      b.ensemble!.agreeCount - a.ensemble!.agreeCount ||
      b.ensemble!.eligibleCount - a.ensemble!.eligibleCount ||
      (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
    );

  const excluded = results.filter((r) => r.status !== 'ok');

  return {
    generatedAt: Date.now(), minTicks, ranked, excluded,
    winner: ranked[0] ?? null,
  };
}