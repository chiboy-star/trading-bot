import { describe, it, expect } from 'vitest';
import ccxt from 'ccxt';
import { isNetworkError, isBadSymbolError } from '../src/live_runner';

describe('Network Resilience & Error Classification', () => {
    it('detects DNS resolution failures (EAI_AGAIN)', () => {
        const error = new Error('getaddrinfo EAI_AGAIN api.bytick.com');
        (error as any).code = 'EAI_AGAIN';
        expect(isNetworkError(error)).toBe(true);
    });

    it('detects ENOTFOUND network errors', () => {
        const error = new Error('getaddrinfo ENOTFOUND api.bybit.com');
        (error as any).code = 'ENOTFOUND';
        expect(isNetworkError(error)).toBe(true);
    });

    it('detects ccxt.NetworkError instances', () => {
        const netErr = new ccxt.NetworkError('Connection reset by peer');
        expect(isNetworkError(netErr)).toBe(true);
    });

    it('detects native fetch failures', () => {
        const fetchErr = new TypeError('fetch failed');
        expect(isNetworkError(fetchErr)).toBe(true);
    });

    it('detects timeout and connection resets', () => {
        const resetErr = { code: 'ECONNRESET', message: 'read ECONNRESET' };
        expect(isNetworkError(resetErr)).toBe(true);

        const timedOutErr = { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' };
        expect(isNetworkError(timedOutErr)).toBe(true);
    });

    it('does not classify business or bad symbol errors as network errors', () => {
        const badSymbol = new ccxt.BadSymbol('bybit does not have market symbol PEPE/USDT:USDT');
        expect(isNetworkError(badSymbol)).toBe(false);
        expect(isBadSymbolError(badSymbol)).toBe(true);
    });
});

describe('Currency Formatter Resilience', () => {
    function formatMoneyHelper(
        usdAmount: number | string,
        currency: 'USD' | 'NGN',
        fxRate: number = 1650,
        options?: { signed?: boolean; precision?: 'auto' | number }
    ): string {
        let numericVal: number;
        if (typeof usdAmount === 'number') {
            numericVal = usdAmount;
        } else if (typeof usdAmount === 'string') {
            const cleaned = (usdAmount as string).replace(/[^0-9.-]/g, '');
            numericVal = parseFloat(cleaned);
        } else {
            numericVal = 0;
        }

        if (isNaN(numericVal)) {
            return currency === 'USD' ? '$0.00' : '₦0.00';
        }

        const isNegative = numericVal < 0;
        const absUsd = Math.abs(numericVal);
        const targetAmount = currency === 'USD' ? absUsd : absUsd * fxRate;
        const symbol = currency === 'USD' ? '$' : '₦';

        let decimals = 2;
        if (options?.precision !== undefined && options.precision !== 'auto') {
            decimals = options.precision;
        }

        const formattedNumber = targetAmount.toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });

        let signStr = '';
        if (options?.signed) {
            if (isNegative) {
                signStr = '-';
            } else if (numericVal > 0) {
                signStr = '+';
            }
        } else if (isNegative) {
            signStr = '-';
        }

        let result = `${signStr}${symbol}${formattedNumber}`;

        // Defensively scrub any duplicate currency tags like NGN₦ or $USD or ₦... NGN
        result = result
            .replace(/^(NGN\s*|USD\s*)+/gi, '')
            .replace(/(\s*NGN|\s*USD)+$/gi, '')
            .replace(/₦\s*₦+/g, '₦')
            .replace(/\$\s*\$+/g, '$');

        return result;
    }

    it('formats USD values cleanly without double prefix or suffix', () => {
        expect(formatMoneyHelper(24.41, 'USD')).toBe('$24.41');
        expect(formatMoneyHelper(-24.41, 'USD')).toBe('-$24.41');
        expect(formatMoneyHelper(24.41, 'USD', 1650, { signed: true })).toBe('+$24.41');
        expect(formatMoneyHelper(-24.41, 'USD', 1650, { signed: true })).toBe('-$24.41');
    });

    it('formats NGN values strictly as ₦24,415.77 without duplicate NGN prefixes or suffixes', () => {
        // 14.797436 * 1650 = 24,415.77
        const res = formatMoneyHelper(14.797436, 'NGN', 1650);
        expect(res).toBe('₦24,415.77');
        expect(res).not.toContain('NGN');
        expect(res.startsWith('₦')).toBe(true);

        const negativeRes = formatMoneyHelper(-14.797436, 'NGN', 1650);
        expect(negativeRes).toBe('-₦24,415.77');
        expect(negativeRes).not.toContain('NGN');
    });

    it('handles string input and scrubs duplicate currency prefixes/suffixes cleanly', () => {
        // Input containing redundant NGN or $ string
        expect(formatMoneyHelper('NGN 14.797436', 'NGN', 1650)).toBe('₦24,415.77');
        expect(formatMoneyHelper('$24.41', 'USD')).toBe('$24.41');
        expect(formatMoneyHelper('-24.41', 'USD')).toBe('-$24.41');
    });
});
