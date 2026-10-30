import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { fetchHistory, scanMarkets, selectVolatilityMarkets } from '../scan';
import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import type { ActiveSymbol } from '../types';

const makeSymbol = (overrides: Partial<ActiveSymbol> = {}): ActiveSymbol => ({
    symbol: 'R_100',
    underlying_symbol: 'R_100',
    underlying_symbol_name: 'Random 100 Index',
    display_name: 'Random 100 Index',
    market: 'synthetic_index',
    submarket: 'random_index',
    pip_size: 0.01,
    exchange_is_open: 1,
    is_trading_suspended: 0,
    ...overrides,
}) as ActiveSymbol;

describe('digit scanner scan utilities', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('fetchHistory sends the correct tick_history request and returns prices plus pip_size', async () => {
        const send = jest.fn().mockResolvedValue({
            history: { prices: [1.23, 1.24, 1.25] },
            pip_size: 0.01,
        });

        Object.defineProperty(api_base, 'api', {
            value: { send },
            configurable: true,
        });

        const result = await fetchHistory('R_100', 3);

        expect(send).toHaveBeenCalledWith({
            ticks_history: 'R_100',
            end: 'latest',
            count: 3,
            style: 'ticks',
        });
        expect(result).toEqual({ prices: [1.23, 1.24, 1.25], pip_size: 0.01 });
    });

    it('selectVolatilityMarkets retains matching random_index volatility symbols and skips suspended or closed markets', () => {
        const symbols: ActiveSymbol[] = [
            makeSymbol({ symbol: 'R_100', underlying_symbol: 'R_100', exchange_is_open: 1, is_trading_suspended: 0 }),
            makeSymbol({ symbol: 'R_101', underlying_symbol: 'R_101', exchange_is_open: 0, is_trading_suspended: 0 }),
            makeSymbol({ symbol: '1HZ10V', underlying_symbol: '1HZ10V', exchange_is_open: 1, is_trading_suspended: 0 }),
            makeSymbol({ symbol: '1HZ10V', underlying_symbol: '1HZ10V', exchange_is_open: 1, is_trading_suspended: 0 }),
            makeSymbol({ symbol: 'BOOM500', underlying_symbol: 'BOOM500', submarket: 'random_index', exchange_is_open: 1, is_trading_suspended: 0 }),
            makeSymbol({ symbol: 'R_102', underlying_symbol: 'R_102', exchange_is_open: 1, is_trading_suspended: 1 }),
            makeSymbol({ symbol: 'R_103', underlying_symbol: 'R_103', submarket: 'forex', exchange_is_open: 1, is_trading_suspended: 0 }),
        ];

        const result = selectVolatilityMarkets(symbols);

        expect(result.markets.map(m => m.underlying_symbol || m.symbol)).toEqual(['R_100', '1HZ10V']);
        expect(result.skipped.map(s => s.symbol)).toEqual(['R_101', 'R_102']);
    });

    it('scanMarkets reports connection errors per market without creating a recommendation', async () => {
        const markets: ActiveSymbol[] = [
            makeSymbol({ symbol: 'R_100', underlying_symbol: 'R_100', pip_size: 0.01 }),
            makeSymbol({ symbol: 'R_101', underlying_symbol: 'R_101', pip_size: 0.01 }),
        ];

        const fetchHistoryMock = jest
            .fn()
            .mockRejectedValueOnce(new Error('network timeout'))
            .mockResolvedValueOnce({
                prices: Array.from({ length: 250 }, (_, i) => 1.23 + (i % 10) / 100),
            });

        const results = await scanMarkets(markets, fetchHistoryMock, { count: 250, minObservations: 200 });

        expect(results[0].status).toBe('error');
        expect(results[0].message).toContain('network timeout');
        expect(results[0].recommendation).toBeNull();
        expect(results[1].status).not.toBe('error');
        expect(results[1].observations).toBe(250);
    });

    it('respects the 200-tick minimum when scanning history', async () => {
        const market = makeSymbol({ symbol: 'R_100', underlying_symbol: 'R_100', pip_size: 0.01 });
        const prices = Array.from({ length: 199 }, (_, i) => 1.23 + (i % 10) / 100);

        const result = await scanMarkets([market], async () => ({ prices }), { minObservations: 200, count: 199 });

        expect(result[0].status).toBe('insufficient_data');
        expect(result[0].observations).toBe(199);
        expect(result[0].recommendation).toBeNull();
    });
});

describe('scanMarkets data-quality guards', () => {
    const market = () => [makeSymbol({ symbol: 'R_100', underlying_symbol: 'R_100', pip_size: 0.01 })];
    const randomish = (n: number) => Array.from({ length: n }, (_, i) => Number((100 + ((i * 37) % 100) / 100 + Math.floor(i / 100)).toFixed(2)));

    it('excludes a market whose prices do not match the configured precision', async () => {
        // Prices only show 1 decimal place while the pip says 2: last digits would be padded zeros.
        const prices = Array.from({ length: 300 }, (_, i) => Number((100 + (i % 10) / 10).toFixed(1)));
        const fetchHistoryMock: any = (jest.fn() as any).mockResolvedValue({ prices });
        const [result] = await scanMarkets(market(), fetchHistoryMock as any, { count: 300, minObservations: 200 });
        expect(result.status).toBe('error');
        expect(result.message).toContain('Precision mismatch');
        expect(result.recommendation).toBeNull();
    });

    it('excludes a degenerate digit stream instead of recommending it', async () => {
        const prices = Array.from({ length: 300 }, (_, i) => Number((100 + i * 0.1 + 0.05).toFixed(2)));
        const fetchHistoryMock: any = (jest.fn() as any).mockResolvedValue({ prices });
        const [result] = await scanMarkets(market(), fetchHistoryMock as any, { count: 300, minObservations: 200 });
        expect(result.status).toBe('error');
        expect(result.message).toContain('degenerate');
        expect(result.recommendation).toBeNull();
    });

    it('still analyses a market whose precision matches', async () => {
        const fetchHistoryMock: any = (jest.fn() as any).mockResolvedValue({ prices: randomish(300) });
        const [result] = await scanMarkets(market(), fetchHistoryMock as any, { count: 300, minObservations: 200 });
        expect(result.status).not.toBe('error');
    });
});

