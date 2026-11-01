import { NextResponse } from 'next/server';
import { getFxRate, setFxRate } from '@/lib/db';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_RATE = parseFloat(process.env.DEFAULT_USD_NGN_RATE || '1650');

export async function GET() {
    const now = Date.now();
    const cached = getFxRate('USD_NGN');

    if (cached && (now - cached.updated_at) < CACHE_TTL_MS) {
        return NextResponse.json({
            pair: 'USD_NGN',
            rate: cached.rate,
            formatted: `1 USD = ₦${cached.rate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            updatedAt: cached.updated_at,
            source: 'cache'
        });
    }

    // Attempt live fetch with a tight 3s timeout
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        // Try Binance USDT/NGN ticker or CoinGecko
        const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDTNGN', {
            signal: controller.signal,
            next: { revalidate: 900 }
        });
        clearTimeout(timeoutId);

        if (res.ok) {
            const data = await res.json();
            const liveRate = parseFloat(data.price);
            if (!isNaN(liveRate) && liveRate > 100) {
                setFxRate('USD_NGN', liveRate);
                return NextResponse.json({
                    pair: 'USD_NGN',
                    rate: liveRate,
                    formatted: `1 USD = ₦${liveRate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    updatedAt: now,
                    source: 'live'
                });
            }
        }
    } catch {
        // Fallback gracefully on timeout or network error
    }

    // If fetch failed, return existing cached rate if any, or default fallback
    const fallbackRate = cached ? cached.rate : DEFAULT_RATE;
    if (!cached) {
        setFxRate('USD_NGN', fallbackRate);
    }

    return NextResponse.json({
        pair: 'USD_NGN',
        rate: fallbackRate,
        formatted: `1 USD = ₦${fallbackRate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        updatedAt: cached ? cached.updated_at : now,
        source: cached ? 'stale_cache' : 'fallback'
    });
}
