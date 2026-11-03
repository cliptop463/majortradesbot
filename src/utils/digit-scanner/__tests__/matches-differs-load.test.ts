import { describe, expect, it } from '@jest/globals';
import { MIN_SAMPLE, SampleError, loadSample, resolveDecimals } from '../matches-differs-load';

// 2-decimal prices whose last digits cycle 0..9 so every digit is present.
const prices2dp = (n: number) => Array.from({ length: n }, (_, i) => Number((1500 + i * 0.01 + (i % 7) * 0.1).toFixed(2)));
const fetchOk = (prices: unknown[], pip_size: unknown = 2) => async () => ({ prices, pip_size: pip_size as number });

describe('resolveDecimals', () => {
    const prices = prices2dp(300);

    it('accepts pip_size as a number of decimals when the prices agree', () => {
        expect(resolveDecimals(prices, 2)).toEqual({ decimals: 2, source: 'api' });
    });

    it('accepts pip_size given as a pip value (0.01) when the prices agree', () => {
        expect(resolveDecimals(prices, 0.01)).toEqual({ decimals: 2, source: 'api' });
        expect(resolveDecimals(prices, '0.01')).toEqual({ decimals: 2, source: 'api' });
    });

    it('falls back to the observed precision only when pip_size is missing and there are enough ticks', () => {
        expect(resolveDecimals(prices, null)).toEqual({ decimals: 2, source: 'observed' });
        expect(() => resolveDecimals(prices2dp(50), undefined)).toThrow(SampleError);
    });

    it('rejects a pip_size the prices contradict', () => {
        expect(() => resolveDecimals(prices, 4)).toThrow(/Precision mismatch/);
        expect(() => resolveDecimals(prices, 0)).toThrow(/Precision mismatch/);
    });
});

describe('loadSample', () => {
    it('returns last digits, keeping trailing zeros', async () => {
        const result = await loadSample('R_100', { fetch: fetchOk([1583.2, 1583.25, 1583.31, ...prices2dp(300)]) });
        expect(result.digits.slice(0, 3)).toEqual([0, 5, 1]);
        expect(result.decimals).toBe(2);
        expect(result.precisionSource).toBe('api');
        expect(result.received).toBe(303);
        expect(result.dropped).toBe(0);
    });

    it('asks the connection for 1000 ticks by default and clamps a custom count', async () => {
        const seen: number[] = [];
        const fetch = async (_s: string, count: number) => {
            seen.push(count);
            return { prices: prices2dp(300), pip_size: 2 };
        };
        await loadSample('R_10', { fetch });
        await loadSample('R_10', { fetch, count: 2000 });
        await loadSample('R_10', { fetch, count: 999999 });
        await loadSample('R_10', { fetch, count: 5 });
        expect(seen).toEqual([1000, 2000, 5000, MIN_SAMPLE]);
    });

    it('drops unusable prices and counts them', async () => {
        const result = await loadSample('R_50', { fetch: fetchOk([...prices2dp(300), NaN, null, 'x']) });
        expect(result.dropped).toBe(3);
        expect(result.digits).toHaveLength(300);
    });

    it('reports an API error with its message', async () => {
        const fetch = async () => {
            throw new Error('Symbol not found');
        };
        await expect(loadSample('R_999', { fetch })).rejects.toMatchObject({ code: 'api', message: 'Symbol not found' });
    });

    it('reports an empty response', async () => {
        await expect(loadSample('R_10', { fetch: fetchOk([]) })).rejects.toMatchObject({ code: 'empty' });
        await expect(loadSample('R_10', { fetch: (async () => ({})) as any })).rejects.toMatchObject({ code: 'empty' });
    });

    it('reports too few ticks instead of analysing them', async () => {
        await expect(loadSample('R_10', { fetch: fetchOk(prices2dp(MIN_SAMPLE - 1)) })).rejects.toMatchObject({
            code: 'insufficient',
        });
    });

    it('times out instead of waiting forever', async () => {
        const never = () => new Promise<never>(() => undefined);
        await expect(loadSample('R_10', { fetch: never as any, timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' });
    });

    it('refuses digits when the precision contradicts the prices', async () => {
        await expect(loadSample('R_10', { fetch: fetchOk(prices2dp(300), 4) })).rejects.toMatchObject({ code: 'precision' });
    });
});
