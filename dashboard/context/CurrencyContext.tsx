'use client';

import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';

export type Currency = 'USD' | 'NGN';

export interface FormatMoneyOptions {
    signed?: boolean;
    precision?: 'auto' | number;
}

export interface CurrencyContextValue {
    currency: Currency;
    setCurrency: (currency: Currency) => void;
    fxRate: number;
    fxRateFormatted: string;
    isFxLoading: boolean;
    formatMoney: (usdAmount: number | string, options?: FormatMoneyOptions) => string;
}

const CurrencyContext = createContext<CurrencyContextValue | undefined>(undefined);

const LOCAL_STORAGE_KEY = 'trading_bot_currency';
const DEFAULT_FALLBACK_RATE = 1650;

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
    const [currency, setCurrencyState] = useState<Currency>('USD');
    const [fxRate, setFxRate] = useState<number>(DEFAULT_FALLBACK_RATE);
    const [fxRateFormatted, setFxRateFormatted] = useState<string>('1 USD = ₦1,650.00');
    const [isFxLoading, setIsFxLoading] = useState<boolean>(true);

    // Hydration-safe localStorage restore
    useEffect(() => {
        try {
            const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
            if (saved === 'USD' || saved === 'NGN') {
                setCurrencyState(saved);
            }
        } catch {
            // Ignore storage access errors
        }
    }, []);

    const setCurrency = (c: Currency) => {
        setCurrencyState(c);
        try {
            localStorage.setItem(LOCAL_STORAGE_KEY, c);
        } catch {
            // Ignore storage write errors
        }
    };

    // Fetch live FX rate
    useEffect(() => {
        let isMounted = true;

        async function fetchFx() {
            try {
                const res = await fetch('/api/fx');
                if (res.ok) {
                    const data = await res.json();
                    if (isMounted && data.rate && typeof data.rate === 'number') {
                        setFxRate(data.rate);
                        setFxRateFormatted(data.formatted || `1 USD = ₦${data.rate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
                    }
                }
            } catch {
                // Keep default fallback
            } finally {
                if (isMounted) setIsFxLoading(false);
            }
        }

        fetchFx();
        const interval = setInterval(fetchFx, 5 * 60 * 1000); // 5 min refresh
        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, []);

    const formatMoney = useMemo(() => {
        return (usdAmount: number | string, options?: FormatMoneyOptions): string => {
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
            } else {
                // Smart crypto price precision: preserve significant decimals for tiny token prices
                if (absUsd === 0) {
                    decimals = 2;
                } else if (absUsd < 0.001) {
                    decimals = currency === 'USD' ? 6 : 4;
                } else if (absUsd < 0.1) {
                    decimals = currency === 'USD' ? 4 : 2;
                } else if (absUsd < 1.0) {
                    decimals = currency === 'USD' ? 4 : 2;
                } else {
                    decimals = 2;
                }
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

            // Clean duplicate prefixes or suffixes (preventing NGN₦, $USD, ₦... NGN, etc.)
            result = result
                .replace(/^(NGN\s*|USD\s*)+/gi, '')
                .replace(/(\s*NGN|\s*USD)+$/gi, '')
                .replace(/₦\s*₦+/g, '₦')
                .replace(/\$\s*\$+/g, '$');

            return result;
        };
    }, [currency, fxRate]);

    const value = useMemo<CurrencyContextValue>(() => ({
        currency,
        setCurrency,
        fxRate,
        fxRateFormatted,
        isFxLoading,
        formatMoney
    }), [currency, fxRate, fxRateFormatted, isFxLoading, formatMoney]);

    return (
        <CurrencyContext.Provider value={value}>
            {children}
        </CurrencyContext.Provider>
    );
}

export function useCurrency(): CurrencyContextValue {
    const context = useContext(CurrencyContext);
    if (!context) {
        throw new Error('useCurrency must be used within a CurrencyProvider');
    }
    return context;
}
