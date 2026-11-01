import { describe, it, expect } from 'vitest';
import { StrategyEngine, ActivePositionState, IndicatorSnapshot, CandleData } from '../src/core/strategy';

describe('ATR Trailing Stop Ratcheting & Exit Protection', () => {
    const mockSnapshot: IndicatorSnapshot = {
        currentEmaFast: 105,
        previousEmaFast: 100,
        currentEmaSlow: 95,
        previousEmaSlow: 94,
        currentRsi: 55,
        currentAdx: 30,
        currentAtr: 10,
    };

    describe('Long Position Trailing Stop', () => {
        it('ratchets UP when price prints a new high', () => {
            const pos: ActivePositionState = {
                symbol: 'BTC/USDT',
                side: 'LONG',
                amount: 1,
                entryPrice: 1000,
                currentPrice: 1000,
                highestPrice: 1000,
                lowestPrice: 1000,
                trailingStop: 985, // 1000 - 1.5 * 10
                atr: 10,
                entryTime: Date.now(),
            };

            const candleNewHigh: CandleData = {
                timestamp: Date.now() + 3600000,
                open: 1036,
                high: 1050, // New high! Proposed stop = 1050 - 15 = 1035
                low: 1036, // Above new trailing stop 1035
                close: 1045,
                volume: 100,
            };

            const exitEval = StrategyEngine.evaluateExit(pos, candleNewHigh, mockSnapshot, false, { atrMultiplier: 1.5 });

            expect(exitEval.shouldExit).toBe(false);
            expect(exitEval.stopRaisedOrLowered).toBe(true);
            expect(exitEval.newHighestPrice).toBe(1050);
            expect(exitEval.newTrailingStop).toBe(1035); // Ratcheted up from 985 to 1035
        });

        it('NEVER moves down when price pulls back', () => {
            const pos: ActivePositionState = {
                symbol: 'BTC/USDT',
                side: 'LONG',
                amount: 1,
                entryPrice: 1000,
                currentPrice: 1040,
                highestPrice: 1050,
                lowestPrice: 1000,
                trailingStop: 1035,
                atr: 10,
                entryTime: Date.now(),
            };

            const candlePullback: CandleData = {
                timestamp: Date.now() + 7200000,
                open: 1040,
                high: 1042, // Lower than previous high 1050
                low: 1036, // Above stop 1035
                close: 1038,
                volume: 80,
            };

            const exitEval = StrategyEngine.evaluateExit(pos, candlePullback, mockSnapshot, false, { atrMultiplier: 1.5 });

            expect(exitEval.shouldExit).toBe(false);
            expect(exitEval.stopRaisedOrLowered).toBe(false);
            expect(exitEval.newHighestPrice).toBe(1050); // Preserved
            expect(exitEval.newTrailingStop).toBe(1035); // Does NOT move down
        });

        it('triggers exit when candle low breaches trailing stop', () => {
            const pos: ActivePositionState = {
                symbol: 'BTC/USDT',
                side: 'LONG',
                amount: 1,
                entryPrice: 1000,
                currentPrice: 1040,
                highestPrice: 1050,
                lowestPrice: 1000,
                trailingStop: 1035,
                atr: 10,
                entryTime: Date.now(),
            };

            const candleDrop: CandleData = {
                timestamp: Date.now() + 10800000,
                open: 1038,
                high: 1039,
                low: 1030, // Breached below 1035!
                close: 1032,
                volume: 150,
            };

            const exitEval = StrategyEngine.evaluateExit(pos, candleDrop, mockSnapshot, false, { atrMultiplier: 1.5, trailingStopMode: 'intrabar' });

            expect(exitEval.shouldExit).toBe(true);
            expect(exitEval.reason).toBe('TRAILING_STOP');
            expect(exitEval.executionPrice).toBeCloseTo(1035 * (1 - 0.0005), 2);
        });
    });

    describe('Short Position Trailing Stop', () => {
        it('ratchets DOWN when price prints a new low', () => {
            const pos: ActivePositionState = {
                symbol: 'ETH/USDT',
                side: 'SHORT',
                amount: 5,
                entryPrice: 3000,
                currentPrice: 3000,
                highestPrice: 3000,
                lowestPrice: 3000,
                trailingStop: 3045, // 3000 + 1.5 * 30
                atr: 30,
                entryTime: Date.now(),
            };

            const candleNewLow: CandleData = {
                timestamp: Date.now() + 3600000,
                open: 2940,
                high: 2940, // Below new trailing stop 2945
                low: 2900,  // New low! Proposed stop = 2900 + 45 = 2945
                close: 2910,
                volume: 200,
            };

            const exitEval = StrategyEngine.evaluateExit(pos, candleNewLow, { ...mockSnapshot, currentAtr: 30 }, false, { atrMultiplier: 1.5 });

            expect(exitEval.shouldExit).toBe(false);
            expect(exitEval.stopRaisedOrLowered).toBe(true);
            expect(exitEval.newLowestPrice).toBe(2900);
            expect(exitEval.newTrailingStop).toBe(2945); // Lowered from 3045 to 2945
        });

        it('NEVER moves up when price bounces higher', () => {
            const pos: ActivePositionState = {
                symbol: 'ETH/USDT',
                side: 'SHORT',
                amount: 5,
                entryPrice: 3000,
                currentPrice: 2910,
                highestPrice: 3000,
                lowestPrice: 2900,
                trailingStop: 2945,
                atr: 30,
                entryTime: Date.now(),
            };

            const candleBounce: CandleData = {
                timestamp: Date.now() + 7200000,
                open: 2910,
                high: 2935, // Higher than 2900, but below stop 2945
                low: 2905,
                close: 2930,
                volume: 120,
            };

            const exitEval = StrategyEngine.evaluateExit(pos, candleBounce, { ...mockSnapshot, currentAtr: 30 }, false, { atrMultiplier: 1.5 });

            expect(exitEval.shouldExit).toBe(false);
            expect(exitEval.stopRaisedOrLowered).toBe(false);
            expect(exitEval.newLowestPrice).toBe(2900); // Preserved
            expect(exitEval.newTrailingStop).toBe(2945); // Does NOT move up
        });

        it('triggers exit when candle high breaches short trailing stop', () => {
            const pos: ActivePositionState = {
                symbol: 'ETH/USDT',
                side: 'SHORT',
                amount: 5,
                entryPrice: 3000,
                currentPrice: 2910,
                highestPrice: 3000,
                lowestPrice: 2900,
                trailingStop: 2945,
                atr: 30,
                entryTime: Date.now(),
            };

            const candleSpike: CandleData = {
                timestamp: Date.now() + 10800000,
                open: 2930,
                high: 2955, // Spikes through 2945 stop
                low: 2925,
                close: 2950,
                volume: 300,
            };

            const exitEval = StrategyEngine.evaluateExit(pos, candleSpike, { ...mockSnapshot, currentAtr: 30 }, false, { atrMultiplier: 1.5 });

            expect(exitEval.shouldExit).toBe(true);
            expect(exitEval.reason).toBe('TRAILING_STOP');
            expect(exitEval.executionPrice).toBeCloseTo(2945 * (1 + 0.0005), 2);
        });
    });

    describe('Same-Bar Ordering & Lookahead Elimination', () => {
        it('does NOT trigger stop on the same wide bar that sets a higher stop (Long)', () => {
            const pos: ActivePositionState = {
                symbol: 'BTC/USDT',
                side: 'LONG',
                amount: 1,
                entryPrice: 1000,
                currentPrice: 1000,
                highestPrice: 1000,
                lowestPrice: 1000,
                trailingStop: 960, // Carried stop
                atr: 20,
                entryTime: Date.now(),
            };

            // Wide bar: high = 1060, low = 990 (range = 70).
            // Proposed stop from high = 1060 - 2.0 * 20 = 1020.
            // Notice: low (990) is BELOW 1020, but ABOVE carried stop (960)!
            const wideBar: CandleData = {
                timestamp: Date.now() + 3600000,
                open: 1000,
                high: 1060,
                low: 990,
                close: 1050,
                volume: 500,
            };

            const exitEval = StrategyEngine.evaluateExit(pos, wideBar, { ...mockSnapshot, currentAtr: 20 }, false, { atrMultiplier: 2.0 });

            // Must NOT exit because exits are evaluated against carried stop (960)!
            expect(exitEval.shouldExit).toBe(false);
            // Trailing stop is ratcheted for use on NEXT bar
            expect(exitEval.newTrailingStop).toBe(1020);
            expect(exitEval.newHighestPrice).toBe(1060);
        });

        it('does NOT trigger stop on the same wide bar that sets a lower stop (Short)', () => {
            const pos: ActivePositionState = {
                symbol: 'ETH/USDT',
                side: 'SHORT',
                amount: 1,
                entryPrice: 2000,
                currentPrice: 2000,
                highestPrice: 2000,
                lowestPrice: 2000,
                trailingStop: 2080, // Carried stop
                atr: 20,
                entryTime: Date.now(),
            };

            // Wide bar: low = 1940, high = 2010 (range = 70).
            // Proposed stop from low = 1940 + 2.0 * 20 = 1980.
            // Notice: high (2010) is ABOVE 1980, but BELOW carried stop (2080)!
            const wideBar: CandleData = {
                timestamp: Date.now() + 3600000,
                open: 2000,
                high: 2010,
                low: 1940,
                close: 1950,
                volume: 500,
            };

            const exitEval = StrategyEngine.evaluateExit(pos, wideBar, { ...mockSnapshot, currentAtr: 20 }, false, { atrMultiplier: 2.0 });

            expect(exitEval.shouldExit).toBe(false);
            expect(exitEval.newTrailingStop).toBe(1980);
            expect(exitEval.newLowestPrice).toBe(1940);
        });

        it('assumes worse outcome (stop) if both stop and take profit target are touched in the same bar', () => {
            const pos: ActivePositionState = {
                symbol: 'BTC/USDT',
                side: 'LONG',
                amount: 1,
                entryPrice: 1000,
                currentPrice: 1000,
                highestPrice: 1000,
                lowestPrice: 1000,
                trailingStop: 980,
                takeProfitPrice: 1050,
                atr: 10,
                entryTime: Date.now(),
            };

            // Volatile bar touching BOTH target (1055 >= 1050) and stop (975 <= 980)
            const collisionBar: CandleData = {
                timestamp: Date.now() + 3600000,
                open: 1000,
                high: 1055,
                low: 975,
                close: 1010,
                volume: 500,
            };

            const exitEval = StrategyEngine.evaluateExit(pos, collisionBar, mockSnapshot, false, { atrMultiplier: 2.0 });

            expect(exitEval.shouldExit).toBe(true);
            expect(exitEval.reason).toBe('TRAILING_STOP'); // Conservative: stop chosen over target
        });
    });
});
