import type { ActiveSymbol } from './types';

export function getLastDigit(price: number, pipSize: number): number {
    if (!Number.isFinite(price) || !Number.isInteger(pipSize) || pipSize < 0 || pipSize > 12) {
        throw new RangeError(`pipSize must be an integer between 0 and 12, received: ${pipSize}`);
    }

    const multiplier = 10 ** pipSize;
    return Math.abs(Math.round(price * multiplier)) % 10;
}

export function pipSizeFromPip(pip: number): number {
    if (typeof pip !== 'number' || !Number.isFinite(pip) || pip <= 0) {
        return 0;
    }

    if (pip >= 1) {
        return 0;
    }

    const text = pip.toString();
    const exponent = text.match(/e-(\d+)$/i)?.[1];
    if (exponent) {
        return parseInt(exponent, 10);
    }

    const decimals = text.split('.')[1]?.length ?? 0;
    return decimals;
}

/**
 * Derive the decimal places from a pip value (e.g. 0.01 -> 2, 1 -> 0).
 * Returns null for non-number, non-finite, or <= 0 values.
 */
export function pipDecimals(pip: unknown): number | null {
    if (typeof pip !== 'number' || !Number.isFinite(pip) || pip <= 0) {
        return null;
    }
    if (pip >= 1) {
        return 0;
    }
    const str = pip.toString();
    const expMatch = str.match(/e-(\d+)$/i);
    if (expMatch) {
        return parseInt(expMatch[1], 10);
    }
    return pipSizeFromPip(pip);
}

/**
 * Extracts the last digit from an array of prices using the specified pipSize decimals.
 * Invalid (non-number or non-finite) prices are dropped and counted in `dropped`.
 * A non-array input returns `{ digits: [], dropped: 0 }`.
 * Throws RangeError if pipSize is not an integer between 0 and 12.
 */
export function extractLastDigits(
    prices: unknown,
    pipSize: number
): { digits: number[]; dropped: number } {
    if (typeof pipSize !== 'number' || !Number.isInteger(pipSize) || pipSize < 0 || pipSize > 12) {
        throw new RangeError(`pipSize must be an integer between 0 and 12, received: ${pipSize}`);
    }

    if (!Array.isArray(prices)) {
        return { digits: [], dropped: 0 };
    }

    const digits: number[] = [];
    let dropped = 0;

    for (let i = 0; i < prices.length; i++) {
        const price = prices[i];
        if (typeof price === 'number' && Number.isFinite(price)) {
            digits.push(getLastDigit(price, pipSize));
        } else {
            dropped++;
        }
    }

    return { digits, dropped };
}

/** Number of decimal places in the shortest decimal representation of a finite number. */
export function decimalPlaces(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const text = String(value);
    const exponent = text.match(/e-(\d+)$/i);
    if (exponent) {
        const mantissaDecimals = text.split('e')[0].split('.')[1]?.length ?? 0;
        return parseInt(exponent[1], 10) + mantissaDecimals;
    }
    return text.split('.')[1]?.length ?? 0;
}

export interface PrecisionCheck {
    ok: boolean;
    observed: number;
    /** Present when ok is false. */
    reason?: string;
}

/**
 * Cross-checks the configured precision against the prices themselves.
 *
 * Prices arrive as JSON numbers, so trailing zeros are lost ("1234.50" -> 1234.5), but across a few
 * hundred ticks at least one price shows the full precision. If the configured pipSize differs from
 * the most decimals ever seen, the extracted "last digit" would be wrong (pipSize too low) or padded
 * with artificial zeros (pipSize too high). Either way the digit stream is not trustworthy, so the
 * market must be excluded instead of analysed.
 */
export function checkPrecision(prices: unknown, pipSize: number): PrecisionCheck {
    const valid = Array.isArray(prices)
        ? prices.filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
        : [];
    if (valid.length === 0) {
        return { ok: false, observed: 0, reason: 'No valid prices to verify precision.' };
    }
    const observed = valid.reduce((max, p) => Math.max(max, decimalPlaces(p)), 0);
    if (observed === pipSize) return { ok: true, observed };
    return {
        ok: false,
        observed,
        reason: `Precision mismatch: configured ${pipSize} decimal place(s) but prices show ${observed}. Last digits would be unreliable.`,
    };
}

export type { ActiveSymbol };
