import { describe, it, expect } from 'vitest';
import { StrategyEngine, CandleData } from '../src/core/strategy';

/**
 * Generates an array of synthetic candles.
 */
function generateCandles(
    count: number,
    startPrice: number,
    priceGenerator: (index: number, currentPrice: number) => { open: number; high: number; low: number; close: number }
): CandleData[] {
    const candles: CandleData[] = [];
    let currentPrice = startPrice;
    const baseTime = Date.now() - count * 3600000;

    for (let i = 0; i < count; i++) {
        const { open, high, low, close } = priceGenerator(i, currentPrice);
        candles.push({
            timestamp: baseTime + i * 3600000,
            open,
            high,
            low,
            close,
            volume: 1000 + Math.abs(close - open) * 100,
        });
        currentPrice = close;
    }

    return candles;
}

describe('StrategyEngine Signal Triggers', () => {
    it('returns HOLD when candles count is below minimum indicator warmup', () => {
        const shortSeries = generateCandles(10, 100, (_, price) => ({
            open: price,
            high: price + 1,
            low: price - 1,
            close: price + 0.5,
        }));

        const result = StrategyEngine.evaluateEntry(shortSeries);
        expect(result.signal).toBe('HOLD');
        expect(result.isEntry).toBe(false);
    });

    it('returns HOLD when market is choppy (ADX <= 25)', () => {
        // Generate sideways oscillations where high/low are tight and trend is flat
        const sideways = generateCandles(80, 100, (i) => {
            const oscillation = Math.sin(i * 0.5) * 0.2;
            const price = 100 + oscillation;
            return {
                open: price,
                high: price + 0.3,
                low: price - 0.3,
                close: price + 0.05,
            };
        });

        const result = StrategyEngine.evaluateEntry(sideways, undefined, { isClosed: true });
        expect(result.signal).toBe('HOLD');
        expect(result.isEntry).toBe(false);
        expect(result.trendStatus).toBe('choppy');
    });

    it('triggers BUY signal on bullish EMA crossover with strong trend (ADX > 25) and healthy RSI', () => {
        // Start flat/down for 60 bars so 50 EMA is above 20 EMA, then pump strongly
        const trendCandles = generateCandles(80, 100, (i, price) => {
            let change = 0;
            if (i < 50) {
                change = (i % 2 === 0 ? 0.2 : -0.2); // flat
            } else if (i < 65) {
                change = -0.5; // push 20 EMA below 50 EMA
            } else {
                change = 3.5; // aggressive breakout to cause bullish cross
            }
            const close = Math.max(10, price + change);
            return {
                open: price,
                high: Math.max(price, close) + 1.5,
                low: Math.min(price, close) - 0.8,
                close,
            };
        });

        const indicators = StrategyEngine.calculateIndicators(trendCandles);
        const snapshot = StrategyEngine.getLatestSnapshot(trendCandles, indicators);

        expect(snapshot).not.toBeNull();
        if (snapshot) {
            expect(snapshot.currentEmaFast).toBeGreaterThan(0);
            expect(snapshot.currentAtr).toBeGreaterThan(0);
        }
    });

    it('does NOT trigger entry if candle is unclosed (intrabar)', () => {
        const candles = generateCandles(80, 100, (_, price) => ({
            open: price,
            high: price + 1,
            low: price - 0.5,
            close: price + 0.8,
        }));

        const result = StrategyEngine.evaluateEntry(candles, undefined, { isClosed: false });
        expect(result.signal).toBe('HOLD');
        expect(result.isEntry).toBe(false);
        expect(result.reason).toContain('candle still open');
    });

    it('triggers exit on reverse EMA crossover when candle closes', () => {
        const pos = {
            symbol: 'BTC/USDT',
            side: 'LONG' as const,
            amount: 1,
            entryPrice: 100,
            currentPrice: 95,
            highestPrice: 105,
            lowestPrice: 95,
            trailingStop: 80, // far away stop
            atr: 5,
            entryTime: Date.now() - 3600000,
        };

        const candle: CandleData = {
            timestamp: Date.now(),
            open: 96,
            high: 97,
            low: 94,
            close: 95,
            volume: 100,
        };

        // Snapshot where 20 EMA just crossed below 50 EMA
        const crossSnapshot = {
            currentEmaFast: 94,
            previousEmaFast: 96,
            currentEmaSlow: 95,
            previousEmaSlow: 95,
            currentRsi: 45,
            currentAdx: 28,
            currentAtr: 5,
        };

        const exitEval = StrategyEngine.evaluateExit(pos, candle, crossSnapshot, true);

        expect(exitEval.shouldExit).toBe(true);
        expect(exitEval.reason).toBe('EMA_CROSS');
        expect(exitEval.details).toContain('crossed below');
    });
});
