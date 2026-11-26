import type { ActiveSymbol } from '@/utils/digit-scanner/types';
import { detectDirection, DIRECTION_DEFAULTS, ticksPerMinuteFor, windowsForMinutes } from './direction';
import type { DirectionOptions, MoveDirection } from './direction';

export interface DirectionScanRow {
    symbol: string;
    displayName: string;
    direction: MoveDirection | null;
    t: number;
    efficiency: number;
    window: number;
    ticks: number;
    recommendation: 'HIGH' | 'LOW' | null;
    reason: string;
}

export interface ScanDirectionsOptions extends Partial<Omit<DirectionOptions, 'windows'>> {
    minutes?: number;
    concurrency?: number;
}

type PriceFetcher = (
    symbol: string,
    count: number
) => Promise<{ prices?: unknown[] }> | { prices?: unknown[] };

export async function scanDirections(
    markets: readonly ActiveSymbol[],
    fetchPrices: PriceFetcher,
    options: ScanDirectionsOptions = {}
): Promise<DirectionScanRow[]> {
    const minutes = options.minutes ?? 1;
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 3));
    const rows = new Array<DirectionScanRow>(markets.length);
    let nextIndex = 0;

    async function scanMarket(market: ActiveSymbol): Promise<DirectionScanRow> {
        const symbol = market.underlying_symbol || market.symbol || '';
        const displayName = market.underlying_symbol_name || market.display_name || symbol;
        const windows = windowsForMinutes(minutes, ticksPerMinuteFor(symbol));
        const primary = windows[windows.length - 1];
        const count = Math.max(120, 2 * primary + 10);
        try {
            const history = await fetchPrices(symbol, count);
            if (!history || !Array.isArray(history.prices)) {
                throw new Error('Response missing price history array.');
            }
            const prices = history.prices.map(price => (typeof price === 'number' ? price : Number(price)));
            const result = detectDirection(prices, {
                ...DIRECTION_DEFAULTS,
                ...options,
                windows,
            });
            return {
                symbol,
                displayName,
                direction: result.direction,
                t: result.t,
                efficiency: result.efficiency,
                window: primary,
                ticks: prices.length,
                recommendation:
                    result.direction === 'DOWN' ? 'HIGH' : result.direction === 'UP' ? 'LOW' : null,
                reason: result.reason,
            };
        } catch (error) {
            return {
                symbol,
                displayName,
                direction: null,
                t: 0,
                efficiency: 0,
                window: primary,
                ticks: 0,
                recommendation: null,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async function worker() {
        while (nextIndex < markets.length) {
            const index = nextIndex++;
            rows[index] = await scanMarket(markets[index]);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, markets.length) }, () => worker()));
    return rows.sort((a, b) => Number(Boolean(b.recommendation)) - Number(Boolean(a.recommendation)) || Math.abs(b.t) - Math.abs(a.t));
}
