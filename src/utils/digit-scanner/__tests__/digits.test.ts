import { describe, expect, it } from '@jest/globals';
import { extractLastDigits, pipDecimals, pipSizeFromPip, getLastDigit } from '../digits';

describe('pipDecimals', () => {
    it('derives correct decimal places from standard pip values', () => {
        expect(pipDecimals(0.01)).toBe(2);
        expect(pipDecimals(0.001)).toBe(3);
        expect(pipDecimals(0.1)).toBe(1);
        expect(pipDecimals(0.0001)).toBe(4);
        expect(pipDecimals(1)).toBe(0);
        expect(pipDecimals(10)).toBe(0);
    });

    it('handles small exponential numbers properly', () => {
        expect(pipDecimals(1e-5)).toBe(5);
    });

    it('returns null for non-number, non-finite, and non-positive numbers', () => {
        expect(pipDecimals(0)).toBeNull();
        expect(pipDecimals(-0.01)).toBeNull();
        expect(pipDecimals(NaN)).toBeNull();
        expect(pipDecimals(Infinity)).toBeNull();
        expect(pipDecimals(-Infinity)).toBeNull();
        expect(pipDecimals('0.01')).toBeNull();
        expect(pipDecimals(null)).toBeNull();
        expect(pipDecimals(undefined)).toBeNull();
        expect(pipDecimals({})).toBeNull();
    });
});

describe('getLastDigit and pipSizeFromPip', () => {
    it('computes the last digit and pip size expected for decimal values', () => {
        expect(getLastDigit(876.5, 2)).toBe(0);
        expect(getLastDigit(123.45, 2)).toBe(5);
        expect(pipSizeFromPip(0.01)).toBe(2);
        expect(pipSizeFromPip(0.0001)).toBe(4);
    });
});

describe('extractLastDigits', () => {
    it('handles trailing zeros correctly on decimal markets', () => {
        const result = extractLastDigits([876.5], 2);
        expect(result.digits).toEqual([0]);
        expect(result.dropped).toBe(0);
    });

    it('handles 2 vs 3 decimal markets correctly', () => {
        expect(extractLastDigits([123.45], 2).digits).toEqual([5]);
        expect(extractLastDigits([123.456], 3).digits).toEqual([6]);
        expect(extractLastDigits([123.40], 2).digits).toEqual([0]);
    });

    it('drops and counts NaN, Infinity, strings, null, undefined', () => {
        const input = [100.15, NaN, 'bad', null, Infinity, undefined, -Infinity, 100.27];
        const result = extractLastDigits(input, 2);
        expect(result.digits).toEqual([5, 7]);
        expect(result.dropped).toBe(6);
    });

    it('returns empty array and 0 dropped for non-array input', () => {
        expect(extractLastDigits(null, 2)).toEqual({ digits: [], dropped: 0 });
        expect(extractLastDigits(undefined, 2)).toEqual({ digits: [], dropped: 0 });
        expect(extractLastDigits('prices', 2)).toEqual({ digits: [], dropped: 0 });
        expect(extractLastDigits(12345, 2)).toEqual({ digits: [], dropped: 0 });
    });

    it('throws RangeError for invalid pip sizes outside 0-12 or non-integers', () => {
        expect(() => extractLastDigits([100], -1)).toThrow(RangeError);
        expect(() => extractLastDigits([100], 13)).toThrow(RangeError);
        expect(() => extractLastDigits([100], 2.5)).toThrow(RangeError);
        expect(() => extractLastDigits([100], NaN)).toThrow(RangeError);
    });
});
