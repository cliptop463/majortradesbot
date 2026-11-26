export type MoveDirection = 'UP' | 'DOWN';

export interface DirectionOptions {
    /** Ascending return-window lengths; the last entry is the primary window. */
    windows: number[];
    minT: number;
    minShortT: number;
    minEfficiency: number;
    /** Recent price moves checked for a reversal; zero disables this gate. */
    recent: number;
}

export const DIRECTION_DEFAULTS: DirectionOptions = {
    windows: [20, 40, 60],
    minT: 2.5,
    minShortT: 1.5,
    minEfficiency: 0.3,
    recent: 5,
};

export interface WindowStat {
    window: number;
    t: number;
    efficiency: number;
}

export interface DirectionResult {
    direction: MoveDirection | null;
    t: number;
    efficiency: number;
    windows: WindowStat[];
    code: string;
    reason: string;
}

/** Calculates the signed t-statistic and path efficiency for the last w returns. */
export function windowStat(prices: readonly number[], w: number): WindowStat {
    if (!Number.isInteger(w) || w < 1 || prices.length < w + 1) {
        return { window: w, t: 0, efficiency: 0 };
    }

    const window = prices.slice(-(w + 1));
    const returns = window.slice(1).map((price, index) => Math.log(price) - Math.log(window[index]));
    const sum = returns.reduce((total, value) => total + value, 0);
    const absoluteSum = returns.reduce((total, value) => total + Math.abs(value), 0);
    const average = sum / w;
    const sampleVariance =
        w > 1 ? returns.reduce((total, value) => total + (value - average) ** 2, 0) / (w - 1) : 0;
    const standardDeviation = Math.sqrt(sampleVariance);

    return {
        window: w,
        t: standardDeviation === 0 ? 0 : sum / (standardDeviation * Math.sqrt(w)),
        efficiency: absoluteSum === 0 ? 0 : Math.abs(sum) / absoluteSum,
    };
}

const rejected = (
    code: string,
    reason: string,
    t = 0,
    efficiency = 0,
    windows: WindowStat[] = []
): DirectionResult => ({ direction: null, t, efficiency, windows, code, reason });

export function detectDirection(
    prices: readonly number[],
    options: Partial<DirectionOptions> = {}
): DirectionResult {
    const config: DirectionOptions = {
        ...DIRECTION_DEFAULTS,
        ...options,
        windows: options.windows ?? DIRECTION_DEFAULTS.windows,
    };
    const required = Math.max(...config.windows);

    if (!config.windows.length || prices.length < required + 1) {
        return rejected(
            'insufficient_ticks',
            `Need ${required + 1} ticks, have ${prices.length}.`
        );
    }
    if (!prices.every(price => Number.isFinite(price) && price > 0)) {
        return rejected('invalid_tick_data', 'Invalid tick data: prices must be finite and positive.');
    }

    const windows = config.windows.map(window => windowStat(prices, window));
    const primary = windows[windows.length - 1];
    const shortest = windows[0];
    const t = primary.t;
    const efficiency = primary.efficiency;

    if (Math.abs(t) < config.minT) {
        return rejected('weak_drift', `Primary-window |t| ${Math.abs(t).toFixed(2)} is below ${config.minT}.`, t, efficiency, windows);
    }
    if (windows.some(stat => Math.sign(stat.t) !== Math.sign(t))) {
        return rejected('windows_disagree', 'Directional windows disagree on the sign of the move.', t, efficiency, windows);
    }
    if (Math.abs(shortest.t) < config.minShortT) {
        return rejected(
            'move_fading',
            `Shortest-window |t| ${Math.abs(shortest.t).toFixed(2)} is below ${config.minShortT}.`,
            t,
            efficiency,
            windows
        );
    }
    if (efficiency < config.minEfficiency) {
        return rejected(
            'choppy_path',
            `Primary-window efficiency ${efficiency.toFixed(2)} is below ${config.minEfficiency}.`,
            t,
            efficiency,
            windows
        );
    }
    if (config.recent > 0) {
        const tail = prices.slice(-(config.recent + 1));
        const recentNet = Math.log(tail[tail.length - 1]) - Math.log(tail[0]);
        if (recentNet !== 0 && Math.sign(recentNet) !== Math.sign(t)) {
            return rejected('recent_reversal', 'The most recent ticks moved against the primary direction.', t, efficiency, windows);
        }
    }

    const direction = t > 0 ? 'UP' : 'DOWN';
    return {
        direction,
        t,
        efficiency,
        windows,
        code: 'direction_detected',
        reason: `${direction} move passed the t-statistic direction gates (t=${t.toFixed(2)}).`,
    };
}

export function windowsForMinutes(minutes: number, ticksPerMinute: number): number[] {
    const primary = Math.max(6, Math.round(minutes * ticksPerMinute));
    const first = Math.max(2, Math.round(primary / 3));
    const second = Math.max(first + 1, Math.round((2 * primary) / 3));
    return [first, Math.min(second, primary - 1), primary];
}

export function ticksPerMinuteFor(symbol: string): number {
    return /^1HZ/i.test(symbol) ? 60 : 30;
}

export function contractFor(direction: MoveDirection): 'TICKHIGH' | 'TICKLOW' {
    return direction === 'DOWN' ? 'TICKHIGH' : 'TICKLOW';
}
