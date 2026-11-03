import { checkPrecision, pipDecimals } from './digits';
import { fetchHistory as defaultFetchHistory } from './scan';
import { DEFAULT_SAMPLE, lastDigit } from './matches-differs';

/** Fewer valid ticks than this cannot support a meaningful chi-square on 10 digits. */
export const MIN_SAMPLE = 100;
export const MAX_SAMPLE = 5000;
export const FETCH_TIMEOUT_MS = 10000;

export type SampleErrorCode = 'timeout' | 'api' | 'empty' | 'insufficient' | 'precision';

export class SampleError extends Error {
    code: SampleErrorCode;
    constructor(code: SampleErrorCode, message: string) {
        super(message);
        this.name = 'SampleError';
        this.code = code;
    }
}

export type FetchHistoryFn = (
    symbol: string,
    count: number
) => Promise<{ prices: unknown[]; pip_size?: number | string | null }>;

export interface LoadedSample {
    symbol: string;
    digits: number[];
    requested: number;
    received: number;
    /** Valid prices that could not be turned into a digit. */
    dropped: number;
    decimals: number;
    /** 'api' when the API's pip_size was confirmed by the prices; 'observed' when it was missing. */
    precisionSource: 'api' | 'observed';
}

export interface LoadSampleOptions {
    count?: number;
    timeoutMs?: number;
    /** Defaults to the project's authorized ticks_history helper. Injected in tests. */
    fetch?: FetchHistoryFn;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, symbol: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new SampleError('timeout', `Timed out after ${Math.round(ms / 1000)} s loading ticks for ${symbol}.`)),
            ms
        );
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });

/**
 * Works out how many decimal places the prices have. The API's pip_size is trusted only when the prices
 * agree with it, because a wrong precision would silently produce wrong last digits (or all zeros).
 */
export function resolveDecimals(
    prices: unknown[],
    rawPipSize: unknown
): { decimals: number; source: 'api' | 'observed' } {
    const raw = typeof rawPipSize === 'string' ? Number(rawPipSize) : rawPipSize;
    const candidates: number[] = [];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
        if (Number.isInteger(raw) && raw <= 12) candidates.push(raw); // pip_size as a number of decimals
        const viaPip = pipDecimals(raw); // pip_size as a pip value such as 0.01
        if (viaPip !== null && !candidates.includes(viaPip)) candidates.push(viaPip);
    }

    for (const candidate of candidates) {
        if (checkPrecision(prices, candidate).ok) return { decimals: candidate, source: 'api' };
    }

    const observed = checkPrecision(prices, 0).observed;
    if (candidates.length === 0 && prices.length >= 200) {
        return { decimals: observed, source: 'observed' };
    }
    throw new SampleError(
        'precision',
        `Precision mismatch: the API reported pip_size ${String(rawPipSize ?? 'none')} but tick prices show ${observed} decimal place(s). Last digits would be unreliable.`
    );
}

/** Fetches recent ticks for a market over the existing connection and returns their last digits. */
export async function loadSample(symbol: string, options?: LoadSampleOptions): Promise<LoadedSample> {
    const requested = Math.min(MAX_SAMPLE, Math.max(MIN_SAMPLE, Math.floor(options?.count ?? DEFAULT_SAMPLE)));
    const fetchFn = options?.fetch ?? defaultFetchHistory;

    let history: Awaited<ReturnType<FetchHistoryFn>>;
    try {
        history = await withTimeout(fetchFn(symbol, requested), options?.timeoutMs ?? FETCH_TIMEOUT_MS, symbol);
    } catch (error) {
        if (error instanceof SampleError) throw error;
        throw new SampleError('api', error instanceof Error ? error.message : `Unable to load ticks for ${symbol}.`);
    }

    const prices = Array.isArray(history?.prices) ? history.prices : [];
    if (prices.length === 0) {
        throw new SampleError('empty', `No tick history was returned for ${symbol}.`);
    }

    const { decimals, source } = resolveDecimals(prices, history.pip_size);
    const digits = prices
        .map(price => lastDigit(price as number, decimals))
        .filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    const dropped = prices.length - digits.length;

    if (digits.length < MIN_SAMPLE) {
        throw new SampleError(
            'insufficient',
            `Only ${digits.length} valid tick(s) were available for ${symbol}; at least ${MIN_SAMPLE} are needed.`
        );
    }

    return { symbol, digits, requested, received: prices.length, dropped, decimals, precisionSource: source };
}
