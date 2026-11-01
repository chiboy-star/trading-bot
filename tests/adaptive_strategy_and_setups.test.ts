import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { StrategyEngine, RiskManager, CandleData, SetupType } from '../src/strategy/core';
import { StrategyLearner } from '../src/strategy/learner';

describe('Adaptive Strategy & 3-Setup Engine Suite', () => {
    let testDb: Database.Database;

    beforeEach(() => {
        testDb = new Database(':memory:');
        testDb.exec(`
            CREATE TABLE IF NOT EXISTS strategy_performance (
                setup_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                trades_count INTEGER NOT NULL DEFAULT 0,
                wins_count INTEGER NOT NULL DEFAULT 0,
                losses_count INTEGER NOT NULL DEFAULT 0,
                win_rate REAL NOT NULL DEFAULT 0,
                expectancy REAL NOT NULL DEFAULT 0,
                risk_multiplier REAL NOT NULL DEFAULT 1.0,
                last_adjusted_at INTEGER NOT NULL,
                PRIMARY KEY (setup_type, symbol)
            );

            CREATE TABLE IF NOT EXISTS strategy_learning (
                playbook TEXT NOT NULL,
                symbol_tier TEXT NOT NULL,
                volatility_regime TEXT NOT NULL,
                trades_count INTEGER NOT NULL DEFAULT 0,
                wins INTEGER NOT NULL DEFAULT 0,
                losses INTEGER NOT NULL DEFAULT 0,
                win_rate REAL NOT NULL DEFAULT 0,
                profit_factor REAL NOT NULL DEFAULT 1.0,
                avg_r_multiple REAL NOT NULL DEFAULT 0,
                confidence_weight REAL NOT NULL DEFAULT 1.0,
                last_updated INTEGER NOT NULL,
                PRIMARY KEY (playbook, symbol_tier, volatility_regime)
            );

            CREATE TABLE IF NOT EXISTS shadow_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                playbook TEXT NOT NULL,
                direction TEXT NOT NULL,
                rejected_filter TEXT NOT NULL,
                filter_value REAL NOT NULL,
                filter_threshold REAL NOT NULL,
                entry_price REAL NOT NULL,
                atr REAL NOT NULL,
                timestamp INTEGER NOT NULL,
                eval_candle_count INTEGER DEFAULT 0,
                outcome_pnl REAL DEFAULT NULL,
                outcome_r REAL DEFAULT NULL,
                status TEXT DEFAULT 'OPEN'
            );
        `);
    });

    afterEach(() => {
        testDb.close();
    });

    const makeCandles = (count: number = 60, basePrice: number = 100): CandleData[] => {
        const candles: CandleData[] = [];
        let price = basePrice;
        const now = Date.now();
        for (let i = 0; i < count; i++) {
            price += 0.1;
            candles.push({
                timestamp: now - (count - i) * 900000, // 15m intervals
                open: price - 0.2,
                high: price + 0.5,
                low: price - 0.5,
                close: price,
                volume: 1000,
            });
        }
        return candles;
    };

    describe('1. Setup 1: EMA_CROSSOVER', () => {
        it('identifies classic EMA crossover when 20 EMA crosses above 50 EMA with ADX > 20 and RSI in momentum zone', () => {
            const candles = makeCandles(60);
            const indicators = {
                emaFast: [98, 105],
                emaSlow: [99, 100],
                rsi: [54],
                adx: [{ adx: 28 }],
                atr: [4],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.isEntry).toBe(true);
            expect(evalResult.setupType).toBe('EMA_CROSSOVER');
            expect(evalResult.direction).toBe('LONG');
        });
    });

    describe('2. Setup 2: TREND_PULLBACK (High Frequency)', () => {
        it('identifies TREND_PULLBACK when established trend pulls back near 20 EMA and closes back in trend direction', () => {
            const candles = makeCandles(60, 100);
            // Last candle pulls back to touch 20 EMA and bounces:
            const lastIdx = candles.length - 1;
            candles[lastIdx].open = 100.0;
            candles[lastIdx].low = 99.8;
            candles[lastIdx].close = 100.3; // Bounces and closes bullishly above EMA
            candles[lastIdx - 1].close = 99.9; // Previous close was pullback

            const indicators = {
                emaFast: [100.0, 100.0],
                emaSlow: [95.0, 95.0],   // Already established bullish trend
                rsi: [50],               // Between 42-68 for Long
                adx: [{ adx: 25 }],      // ADX > 20
                atr: [2],                // ATR = 2, 0.3 * ATR = 0.6
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.isEntry).toBe(true);
            expect(evalResult.setupType).toBe('TREND_PULLBACK');
            expect(evalResult.direction).toBe('LONG');
            expect(evalResult.signalProximity.toLowerCase()).toContain('pullback');
        });
    });

    describe('3. Setup 3: VOLATILITY_BREAKOUT', () => {
        it('triggers VOLATILITY_BREAKOUT when ADX is rising and price breaks out above recent 10-candle high', () => {
            const candles = makeCandles(60, 100);
            // High breakout candle:
            const lastIdx = candles.length - 1;
            candles[lastIdx].close = 115; // Higher than all recent 10 candles

            const indicators = {
                emaFast: [102, 104],
                emaSlow: [100, 101],
                rsi: [62],              // RSI > 50 for Long
                adx: [{ adx: 22 }, { adx: 25 }], // Rising ADX > 22 by > 1.5
                atr: [3],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.isEntry).toBe(true);
            expect(evalResult.setupType).toBe('VOLATILITY_BREAKOUT');
            expect(evalResult.direction).toBe('LONG');
        });
    });

    describe('4. Adaptive Strategy Performance & Dynamic Risk Scaling', () => {
        it('adapts risk between 1.0% and 2.5% based on rolling win rate', () => {
            const setupType: SetupType = 'TREND_PULLBACK';
            const symbol = 'Q/USDT';

            // Base risk when no history is default 2%
            const initialRisk = RiskManager.calculateAdaptiveRiskPct(testDb, setupType, symbol, 0.02);
            expect(initialRisk).toBe(0.02);

            // Record 5 winning trades in a row
            for (let i = 0; i < 5; i++) {
                RiskManager.recordClosedTradeAndAdapt(testDb, {
                    setupType,
                    symbol,
                    pnl: 150,
                    pnlPercent: 1.5,
                    entryPrice: 100,
                    exitPrice: 101.5,
                    amount: 10,
                    entryTime: Date.now() - 3600000,
                    exitTime: Date.now(),
                });
            }

            // Win rate is 100% (> 55%), risk multiplier should boost risk up to 2.5%
            const boostedRisk = RiskManager.calculateAdaptiveRiskPct(testDb, setupType, symbol, 0.02);
            expect(boostedRisk).toBeGreaterThan(0.02);
            expect(boostedRisk).toBeLessThanOrEqual(0.025);

            // Now record 10 losing trades in a row
            for (let i = 0; i < 10; i++) {
                RiskManager.recordClosedTradeAndAdapt(testDb, {
                    setupType,
                    symbol,
                    pnl: -100,
                    pnlPercent: -1.0,
                    entryPrice: 100,
                    exitPrice: 99,
                    amount: 10,
                    entryTime: Date.now() - 3600000,
                    exitTime: Date.now(),
                });
            }

            // Win rate is now 5/15 = 33.3% (< 40%), risk multiplier should throttle risk down towards 1.0%
            const throttledRisk = RiskManager.calculateAdaptiveRiskPct(testDb, setupType, symbol, 0.02);
            expect(throttledRisk).toBeLessThan(0.02);
            expect(throttledRisk).toBeGreaterThanOrEqual(0.01);
        });
    });

    describe('5. Intrabar Paper Signal Evaluation', () => {
        it('allows paper signal evaluation when allowIntrabar is enabled even if candle is not closed', () => {
            const candles = makeCandles(60);
            const indicators = {
                emaFast: [98, 105],
                emaSlow: [99, 100],
                rsi: [54],
                adx: [{ adx: 28 }],
                atr: [4],
            };

            // Not closed, but allowIntrabar is true
            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, {
                isClosed: false,
                allowShorts: true,
                allowIntrabar: true
            });

            expect(evalResult.isEntry).toBe(true);
            expect(evalResult.setupType).toBe('EMA_CROSSOVER');
        });

        it('disallows signal when candle is not closed and allowIntrabar is false', () => {
            const candles = makeCandles(60);
            const indicators = {
                emaFast: [98, 105],
                emaSlow: [99, 100],
                rsi: [54],
                adx: [{ adx: 28 }],
                atr: [4],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, {
                isClosed: false,
                allowShorts: true,
                allowIntrabar: false
            });

            expect(evalResult.isEntry).toBe(false);
        });
    });

    describe('6. Playbook A: TREND_PULLBACK (Strict RSI Range Enforcement)', () => {
        it('identifies short pullback when EMA20 < EMA50, ADX >= 20 and RSI recovered from <35 to 48 (in 45-65)', () => {
            const candles = makeCandles(60, 50);
            const indicators = {
                emaFast: [48.0, 48.0],
                emaSlow: [52.0, 52.0],        // Downtrend established (EMA20 < EMA50)
                rsi: [24, 28, 33, 48],         // Oversold < 35 in last 4 bars, recovered into 45-65
                adx: [{ adx: 33 }],            // ADX 33 (Trending Down)
                atr: [1.5],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.isEntry).toBe(true);
            expect(evalResult.setupType).toBe('TREND_PULLBACK');
            expect(evalResult.direction).toBe('SHORT');
            expect(evalResult.reason).toContain('recovered');
        });

        it('strictly REJECTS short entry when RSI is 21-30 (oversold) to prevent immediate stopouts on bounce', () => {
            const candles = makeCandles(60, 50);
            // Candle touched 20 EMA and rejected downward:
            const lastIdx = candles.length - 1;
            candles[lastIdx].open = 48.2;
            candles[lastIdx].high = 48.3; // Touched 20 EMA at 48.0
            candles[lastIdx].close = 47.7; // Red rejection candle (close < open)

            const indicators = {
                emaFast: [48.0, 48.0],
                emaSlow: [52.0, 52.0],        // Downtrend established
                rsi: [24, 22, 23, 26],         // Oversold RSI 26 (DANGEROUS: price dumped away, will bounce)
                adx: [{ adx: 33 }],
                atr: [1.5],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.isEntry).toBe(false);
            expect(evalResult.signal).toBe('HOLD');
            expect(evalResult.setupType).toBeNull();
        });

        it('identifies long pullback when EMA20 > EMA50, ADX >= 20 and RSI cooled off from >65 into 35-55', () => {
            const candles = makeCandles(60, 50);
            const indicators = {
                emaFast: [55.0, 55.0],
                emaSlow: [50.0, 50.0],        // Uptrend established (EMA20 > EMA50)
                rsi: [68, 66, 60, 52],         // Overbought > 65 in last 4 bars, cooled off into 35-55
                adx: [{ adx: 26 }],            // ADX 26
                atr: [1.2],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.isEntry).toBe(true);
            expect(evalResult.setupType).toBe('TREND_PULLBACK');
            expect(evalResult.direction).toBe('LONG');
        });

        it('strictly REJECTS long entry when RSI is > 55 (overbought, not pulled back to EMA)', () => {
            const candles = makeCandles(60, 50);
            const lastIdx = candles.length - 1;
            candles[lastIdx].open = 55.0;
            candles[lastIdx].close = 55.5;

            const indicators = {
                emaFast: [55.0, 55.0],
                emaSlow: [50.0, 50.0],
                rsi: [62],                    // RSI 62 > 55: price has not pulled back sufficiently
                adx: [{ adx: 26 }],
                atr: [1.2],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.isEntry).toBe(false);
            expect(evalResult.signal).toBe('HOLD');
        });
    });

    describe('7. Playbook B: EMA_CROSSOVER (2-Candle Momentum Window)', () => {
        it('identifies EMA crossover that occurred on the previous candle (2-candle window confirmation)', () => {
            const candles = makeCandles(60);
            // 2 bars ago: fast 95 < slow 98. 1 bar ago: fast crossed above slow (101 > 99). Current bar: fast remains above (103 > 100).
            const indicators = {
                emaFast: [95, 101, 103],
                emaSlow: [98, 99, 100],
                rsi: [56],
                adx: [{ adx: 19 }, { adx: 21 }], // ADX >= 18
                atr: [3],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.isEntry).toBe(true);
            expect(evalResult.setupType).toBe('EMA_CROSSOVER');
            expect(evalResult.direction).toBe('LONG');
        });
    });

    describe('8. Playbook C: EXTREME_RSI_REVERSAL (Mean-Reversion Scalp)', () => {
        it('triggers half-size long reversal scalp with tight 1.2x ATR stop and 2.0x ATR profit target on extreme oversold RSI < 22', () => {
            const candles = makeCandles(60, 10);
            const lastIdx = candles.length - 1;
            const prevIdx = lastIdx - 1;
            candles[prevIdx].high = 10.2;
            candles[prevIdx].close = 9.8;
            candles[lastIdx].open = 9.7;
            candles[lastIdx].close = 10.3; // Reversal body closing above previous high

            const indicators = {
                emaFast: [9.5, 9.5],
                emaSlow: [11.0, 11.0],
                rsi: [18],                  // Extreme exhaustion < 22
                adx: [{ adx: 16 }],
                atr: [0.5],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.isEntry).toBe(true);
            expect(evalResult.setupType).toBe('EXTREME_RSI_REVERSAL');
            expect(evalResult.direction).toBe('LONG');
            expect(evalResult.recommendedRiskPct).toBe(0.01); // 1% half size
            expect(evalResult.recommendedAtrMultiplier).toBe(1.2); // 1.2x ATR stop
            expect(evalResult.takeProfitPrice).toBeCloseTo(10.3 + (2.0 * 0.5), 1); // 2.0x ATR target
        });

        it('triggers short reversal scalp on extreme overbought RSI > 78 with reversal body', () => {
            const candles = makeCandles(60, 100);
            const lastIdx = candles.length - 1;
            const prevIdx = lastIdx - 1;
            candles[prevIdx].low = 99.5;
            candles[lastIdx].open = 101.0;
            candles[lastIdx].close = 99.0; // Reversal body closing below previous low

            const indicators = {
                emaFast: [102, 102],
                emaSlow: [95, 95],
                rsi: [81],                  // Extreme exhaustion > 78
                adx: [{ adx: 17 }],
                atr: [2.0],
            };

            const evalResult = StrategyEngine.evaluateEntry(candles, indicators, { isClosed: true, allowShorts: true });
            expect(evalResult.isEntry).toBe(true);
            expect(evalResult.setupType).toBe('EXTREME_RSI_REVERSAL');
            expect(evalResult.direction).toBe('SHORT');
            expect(evalResult.recommendedRiskPct).toBe(0.01);
            expect(evalResult.recommendedAtrMultiplier).toBe(1.2);
            expect(evalResult.takeProfitPrice).toBeCloseTo(99.0 - (2.0 * 2.0), 1);
        });
    });

    describe('9. Multi-Armed Bandit & Reinforcement Learning Engine (StrategyLearner)', () => {
        it('tracks performance per (playbook, symbol_tier, volatility_regime) and updates confidence weight', () => {
            // Record 4 winning trades on TREND_PULLBACK CORE NORMAL_VOL
            for (let i = 0; i < 4; i++) {
                StrategyLearner.recordTradeOutcome(testDb, {
                    playbook: 'TREND_PULLBACK',
                    symbolTier: 'CORE',
                    volatilityRegime: 'NORMAL_VOL',
                    netPnl: 100,
                    rMultiple: 1.5,
                });
            }

            const boostedWeight = StrategyLearner.getConfidenceWeight(testDb, 'TREND_PULLBACK', 'CORE', 'NORMAL_VOL');
            expect(boostedWeight).toBeGreaterThan(1.0);
            expect(boostedWeight).toBeLessThanOrEqual(1.75);

            // Record losing trades on EMA_CROSSOVER SATELLITE HIGH_VOL
            for (let i = 0; i < 6; i++) {
                StrategyLearner.recordTradeOutcome(testDb, {
                    playbook: 'EMA_CROSSOVER',
                    symbolTier: 'SATELLITE',
                    volatilityRegime: 'HIGH_VOL',
                    netPnl: -50,
                    rMultiple: -1.0,
                });
            }

            const throttledWeight = StrategyLearner.getConfidenceWeight(testDb, 'EMA_CROSSOVER', 'SATELLITE', 'HIGH_VOL');
            expect(throttledWeight).toBeLessThan(1.0);
            expect(throttledWeight).toBeGreaterThanOrEqual(0.5);
        });

        it('activates Cold-Start EXPLORATION_MODE when open positions == 0 and no trade in last 60 minutes', () => {
            const ninetyMinAgo = Date.now() - (90 * 60 * 1000);
            const mode = StrategyLearner.getLearnerMode(0, ninetyMinAgo);
            expect(mode).toBe('EXPLORE');

            const exploreThresh = StrategyLearner.getExplorationThresholds(true, 20);
            expect(exploreThresh.adxThreshold).toBe(17); // 20 - 3 points
            expect(exploreThresh.rsiDelta).toBe(4);      // 4 points wider RSI window

            // When a position is currently open, mode is EXPLOIT
            const exploitMode = StrategyLearner.getLearnerMode(1, ninetyMinAgo);
            expect(exploitMode).toBe('EXPLOIT');
        });

        it('records and counterfactually evaluates Near-Miss Shadow Trades', () => {
            const now = Date.now();
            StrategyLearner.recordShadowTrade(testDb, {
                symbol: 'STRK/USDT',
                playbook: 'TREND_PULLBACK',
                direction: 'SHORT',
                rejected_filter: 'RSI_TOO_LOW',
                filter_value: 26,
                filter_threshold: 35,
                entry_price: 1.50,
                atr: 0.05,
                timestamp: now,
            });

            const rows = testDb.prepare("SELECT * FROM shadow_trades WHERE symbol = 'STRK/USDT'").all() as any[];
            expect(rows.length).toBe(1);
            expect(rows[0].status).toBe('OPEN');

            // Advance 4 candles with lower price (profitable short outcome)
            const candleMap = new Map<string, { close: number; high: number; low: number }>();
            candleMap.set('STRK/USDT', { close: 1.40, high: 1.45, low: 1.38 });

            for (let i = 0; i < 4; i++) {
                StrategyLearner.evaluateShadowTrades(testDb, candleMap);
            }

            const resolvedRow = testDb.prepare("SELECT * FROM shadow_trades WHERE id = ?").get(rows[0].id) as any;
            expect(resolvedRow.status).toBe('RESOLVED');
            expect(resolvedRow.outcome_r).toBeGreaterThan(0);
        });

        it('generates 5-minute terminal status update lines with learner and closest setup info', () => {
            const status = StrategyLearner.getStatusLines(testDb, 0, 0, {
                symbol: 'AKE/USDT',
                playbook: 'TREND_PULLBACK',
                readinessPct: 85,
                statusText: 'waiting for RSI > 35, currently 30',
            });

            expect(status.learnerLine).toContain('🧠 Learner: Mode');
            expect(status.setupLine).toContain('🎯 Closest Setup: AKE/USDT ([TREND_PULLBACK] - 85% ready, waiting for RSI > 35, currently 30)');
        });
    });
});
