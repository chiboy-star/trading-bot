import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { StrategyEngine, RiskManager, CandleData, ActivePositionState, IndicatorSnapshot } from '../src/strategy/core';

describe('Strategy Core Suite (@Madueke Design Specification)', () => {
    describe('1. 2% Portfolio Risk Position Sizing Math', () => {
        it('calculates position size respecting 2% risk, stop distance, 0.075% fee, and 0.05% slippage', () => {
            const capital = 10000;
            const executionPrice = 2000;
            const stopDistance = 50; // 2.5% stop distance
            const maxRiskPct = 0.02; // 2% risk = $200

            const sizing = RiskManager.calculatePositionSize({
                capital,
                executionPrice,
                stopDistance,
                maxRiskPct,
                mode: 'fixed',
                takerFee: 0.00075,
            });

            expect(sizing.isAffordable).toBe(true);
            expect(sizing.riskAmount).toBe(200);
            // Size = 200 / 50 = 4.0 units
            expect(sizing.positionSize).toBeCloseTo(4.0, 4);
            // Total cost = 4 * 2000 * (1 + 0.00075) = 8006
            expect(sizing.totalCost).toBeCloseTo(8006, 2);
            expect(sizing.totalCost).toBeLessThanOrEqual(capital);
        });
    });

    describe('2. Long & Short Entry Signal Validation', () => {
        const createSnapshot = (overrides: Partial<IndicatorSnapshot>): IndicatorSnapshot => ({
            currentEmaFast: 105,
            previousEmaFast: 98,
            currentEmaSlow: 100,
            previousEmaSlow: 99,
            currentRsi: 52,
            currentAdx: 28,
            currentAtr: 5,
            ...overrides,
        });

        // 60 synthetic candles for warmup
        const makeCandles = (count: number = 60): CandleData[] => {
            const candles: CandleData[] = [];
            let price = 100;
            const now = Date.now();
            for (let i = 0; i < count; i++) {
                price += 0.5;
                candles.push({
                    timestamp: now - (count - i) * 3600000,
                    open: price - 0.2,
                    high: price + 0.8,
                    low: price - 0.5,
                    close: price,
                    volume: 1000,
                });
            }
            return candles;
        };

        it('validates bullish EMA crossover within RSI window (40-65) and ADX > 25 for LONG', () => {
            const candles = makeCandles(60);
            const indicators = {
                emaFast: [98, 105],
                emaSlow: [99, 100], // Fast crossed above slow
                rsi: [52],          // Within 40-65
                adx: [{ adx: 28 }], // > 25
                atr: [5],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.signal).toBe('BUY');
            expect(evalResult.direction).toBe('LONG');
            expect(evalResult.isEntry).toBe(true);
        });

        it('validates bearish EMA crossover within RSI window (35-60) and ADX > 25 for SHORT', () => {
            const candles = makeCandles(60);
            const indicators = {
                emaFast: [102, 95],
                emaSlow: [100, 98], // Fast crossed below slow
                rsi: [45],          // Within 35-60
                adx: [{ adx: 30 }], // > 25
                atr: [5],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.signal).toBe('SELL');
            expect(evalResult.direction).toBe('SHORT');
            expect(evalResult.isEntry).toBe(true);
        });

        it('rejects signals when ADX <= 25 (choppy consolidation)', () => {
            const candles = makeCandles(60);
            const indicators = {
                emaFast: [98, 105],
                emaSlow: [99, 100],
                rsi: [52],
                adx: [{ adx: 15 }], // Weak trend <= 25 and < 18 threshold
                atr: [5],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.signal).toBe('HOLD');
            expect(evalResult.isEntry).toBe(false);
        });
    });

    describe('3. 1.5x ATR Trailing Stop Ratcheting', () => {
        const snapshot: IndicatorSnapshot = {
            currentEmaFast: 110,
            previousEmaFast: 105,
            currentEmaSlow: 100,
            previousEmaSlow: 99,
            currentRsi: 55,
            currentAdx: 30,
            currentAtr: 10,
        };

        it('ratchets UP in profitable direction and never loosens when price pulls back', () => {
            const pos: ActivePositionState = {
                symbol: 'ETH/USDT',
                side: 'LONG',
                amount: 1,
                entryPrice: 3000,
                currentPrice: 3000,
                highestPrice: 3000,
                lowestPrice: 3000,
                trailingStop: 2985, // 3000 - 1.5 * 10
                atr: 10,
                entryTime: Date.now(),
            };

            // 1. Price prints new high of 3100
            const candleHigh: CandleData = {
                timestamp: Date.now() + 3600000,
                open: 3088,
                high: 3100,
                low: 3088, // Above proposed stop 3085
                close: 3095,
                volume: 500,
            };
            const evalHigh = StrategyEngine.evaluateExit(pos, candleHigh, snapshot, false, { atrMultiplier: 1.5 });
            expect(evalHigh.shouldExit).toBe(false);
            expect(evalHigh.newHighestPrice).toBe(3100);
            expect(evalHigh.newTrailingStop).toBe(3100 - 15); // 3085 (Ratcheted up from 2985)
            expect(evalHigh.stopRaisedOrLowered).toBe(true);

            // 2. Pullback candle to 3088 (high is 3092 < 3100)
            const updatedPos: ActivePositionState = {
                ...pos,
                highestPrice: evalHigh.newHighestPrice,
                trailingStop: evalHigh.newTrailingStop,
            };
            const candlePullback: CandleData = {
                timestamp: Date.now() + 7200000,
                open: 3090,
                high: 3092,
                low: 3086, // Above stop 3085
                close: 3088,
                volume: 400,
            };
            const evalPullback = StrategyEngine.evaluateExit(updatedPos, candlePullback, snapshot, false, { atrMultiplier: 1.5 });
            expect(evalPullback.shouldExit).toBe(false);
            expect(evalPullback.newTrailingStop).toBe(3085); // Preserved! Never lowered!
            expect(evalPullback.stopRaisedOrLowered).toBe(false);

            // 3. Breach candle low falls to 3080 <= 3085
            const candleBreach: CandleData = {
                timestamp: Date.now() + 10800000,
                open: 3088,
                high: 3089,
                low: 3080,
                close: 3082,
                volume: 600,
            };
            const evalBreach = StrategyEngine.evaluateExit(updatedPos, candleBreach, snapshot, false, { atrMultiplier: 1.5 });
            expect(evalBreach.shouldExit).toBe(true);
            expect(evalBreach.reason).toBe('TRAILING_STOP');
        });
    });

    describe('4. 5% Rolling 24h Drawdown Circuit Breaker Activation', () => {
        let testDb: Database.Database;

        beforeEach(() => {
            testDb = new Database(':memory:');
            testDb.exec(`
                CREATE TABLE daily_losses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp INTEGER NOT NULL,
                    amount REAL NOT NULL
                );
            `);
        });

        afterEach(() => {
            testDb.close();
        });

        it('activates emergency lockout when 24h losses reach or exceed 5% of capital', () => {
            const now = Date.now();
            const capital = 10000;
            const maxDrawdownPct = 0.05; // 5% = $500 threshold

            // Record $250 loss 4 hours ago
            RiskManager.recordDailyLoss(testDb, now - 4 * 3600000, 250);
            let status = RiskManager.checkCircuitBreaker(testDb, capital, now, 0, { maxDrawdownPct });
            expect(status.isHalted).toBe(false);
            expect(status.totalLoss24h).toBe(250);

            // Record another $300 loss 1 hour ago -> Total $550 >= $500
            RiskManager.recordDailyLoss(testDb, now - 1 * 3600000, 300);
            status = RiskManager.checkCircuitBreaker(testDb, capital, now, 0, { maxDrawdownPct });
            expect(status.isHalted).toBe(true);
            expect(status.isLockedOut).toBe(true);
            expect(status.totalLoss24h).toBe(550);
            expect(status.lockoutUntil).toBeGreaterThan(now);
        });
    });
});
