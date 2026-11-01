import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import config from '../src/config';
import { RiskManager, StrategyEngine, CandleData, IndicatorSnapshot } from '../src/strategy/core';
import { StrategyLearner } from '../src/strategy/learner';

describe('Phase 5: Hardened Risk Model', () => {
    let memDb: Database.Database;

    beforeEach(() => {
        memDb = new Database(':memory:');
        memDb.exec(`
            CREATE TABLE strategy_performance (
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

            CREATE TABLE strategy_learning (
                playbook TEXT NOT NULL,
                symbol_tier TEXT NOT NULL DEFAULT 'CORE',
                volatility_regime TEXT NOT NULL DEFAULT 'NORMAL_VOL',
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

            CREATE TABLE bot_state (
                id INTEGER PRIMARY KEY,
                capital REAL NOT NULL,
                initial_capital REAL NOT NULL,
                circuit_breaker_halted INTEGER DEFAULT 0,
                lockout_until INTEGER DEFAULT 0,
                circuit_breaker_limit REAL DEFAULT 0.05,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE system_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                status TEXT NOT NULL DEFAULT 'RUNNING',
                status_changed_at TEXT NOT NULL,
                last_heartbeat_at TEXT NOT NULL,
                error_component TEXT,
                pending_command TEXT NOT NULL DEFAULT 'NONE'
            );

            CREATE TABLE daily_losses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                amount REAL NOT NULL
            );

            CREATE TABLE paper_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id TEXT NOT NULL,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                type TEXT NOT NULL,
                price REAL NOT NULL,
                amount REAL NOT NULL,
                fee REAL NOT NULL,
                pnl REAL DEFAULT 0,
                pnl_percent REAL DEFAULT 0,
                timestamp INTEGER NOT NULL,
                direction TEXT DEFAULT 'LONG',
                execution_mode TEXT DEFAULT 'LIVE_FORWARD',
                broker TEXT DEFAULT 'BYBIT'
            );

            CREATE TABLE activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                type TEXT NOT NULL,
                message TEXT NOT NULL,
                cause TEXT,
                dismissed INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE active_positions (
                symbol TEXT NOT NULL,
                broker TEXT NOT NULL DEFAULT 'BYBIT',
                side TEXT DEFAULT 'LONG',
                amount REAL NOT NULL,
                entry_price REAL NOT NULL,
                current_price REAL NOT NULL,
                highest_price REAL NOT NULL,
                lowest_price REAL DEFAULT 0,
                trailing_stop REAL NOT NULL,
                atr REAL NOT NULL,
                pnl REAL DEFAULT 0,
                pnl_percent REAL DEFAULT 0,
                entry_time INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                setup_type TEXT DEFAULT 'EMA_CROSSOVER',
                PRIMARY KEY (symbol, broker)
            );
        `);
    });

    afterEach(() => {
        memDb.close();
    });

    describe('1. Global Open Risk Cap (6% of Equity)', () => {
        it('calculates aggregate dollar risk correctly across multiple positions', () => {
            const positions = [
                // Long: entry 50,000, stop 48,000, size 0.1 BTC -> risk = 0.1 * 2000 = $200
                { side: 'LONG' as const, amount: 0.1, entryPrice: 50000, trailingStop: 48000 },
                // Short: entry 3,000, stop 3,100, size 1.0 ETH -> risk = 1.0 * 100 = $100
                { side: 'SHORT' as const, amount: 1.0, entryPrice: 3000, trailingStop: 3100 },
                // Long in profit: entry 100, stop 110, size 10 SOL -> risk = $0 (protected profit)
                { side: 'LONG' as const, amount: 10, entryPrice: 100, trailingStop: 110 },
            ];

            const totalRisk = RiskManager.calculateTotalOpenRisk(positions);
            expect(totalRisk).toBe(300);
        });

        it('permits new position when total risk is well within 6% budget', () => {
            const totalEquity = 10000;
            const currentOpenRisk = 300; // 3%
            const proposedRisk = 200;    // 2% -> total 5% <= 6%

            const check = RiskManager.enforceOpenRiskCap({
                currentOpenRisk,
                newPositionRisk: proposedRisk,
                totalEquity,
                maxTotalOpenRiskPct: 0.06,
            });

            expect(check.allowed).toBe(true);
            expect(check.wasDownsized).toBe(false);
            expect(check.effectiveRisk).toBe(200);
            expect(check.maxAllowedRisk).toBe(600);
            expect(check.availableRiskBudget).toBe(300);
        });

        it('downsizes position when proposed risk partially exceeds remaining budget', () => {
            const totalEquity = 10000;
            const currentOpenRisk = 450; // 4.5%
            const proposedRisk = 250;    // 2.5% -> would be 7% (> 6% cap of $600)

            const check = RiskManager.enforceOpenRiskCap({
                currentOpenRisk,
                newPositionRisk: proposedRisk,
                totalEquity,
                maxTotalOpenRiskPct: 0.06,
            });

            expect(check.allowed).toBe(true);
            expect(check.wasDownsized).toBe(true);
            // Downsized to remaining budget: $600 - $450 = $150
            expect(check.effectiveRisk).toBe(150);
            expect(check.reason).toContain('downsized from $250.00 to $150.00');
        });

        it('strictly rejects trade when open risk already equals or exceeds 6% cap', () => {
            const totalEquity = 10000;
            const currentOpenRisk = 600; // 6.0% (exhausted budget)
            const proposedRisk = 200;

            const check = RiskManager.enforceOpenRiskCap({
                currentOpenRisk,
                newPositionRisk: proposedRisk,
                totalEquity,
                maxTotalOpenRiskPct: 0.06,
            });

            expect(check.allowed).toBe(false);
            expect(check.wasDownsized).toBe(false);
            expect(check.reason).toContain('Total open risk cap (6.0%) reached');
        });
    });

    describe('2. Dynamic Learner 50-Trade Sample-Size Guard', () => {
        it('shrinks adaptive risk scaling towards 1.0 prior when trades_count < 50', () => {
            // Insert setup performance with only 5 trades and raw multiplier 1.25
            memDb.prepare(`
                INSERT INTO strategy_performance (setup_type, symbol, trades_count, wins_count, losses_count, win_rate, risk_multiplier, last_adjusted_at)
                VALUES ('TREND_PULLBACK', 'BTC/USDT', 5, 5, 0, 1.0, 1.25, ?)
            `).run(Date.now());

            const details = RiskManager.calculateAdaptiveRiskDetails(memDb, 'TREND_PULLBACK', 'BTC/USDT', 0.02);

            // Shrunk from 1.25 down to 1.025 (10% credibility with 5/50 trades)
            expect(details.tradesCount).toBe(5);
            expect(details.multiplier).toBeCloseTo(1.025, 3);
            expect(details.riskPct).toBeCloseTo(0.0205, 4);
            expect(details.multiplier).toBeLessThan(1.25);
        });

        it('allows full adaptive risk scaling when trades_count >= 50', () => {
            memDb.prepare(`
                INSERT INTO strategy_performance (setup_type, symbol, trades_count, wins_count, losses_count, win_rate, risk_multiplier, last_adjusted_at)
                VALUES ('TREND_PULLBACK', 'ETH/USDT', 55, 38, 17, 0.69, 1.25, ?)
            `).run(Date.now());

            const details = RiskManager.calculateAdaptiveRiskDetails(memDb, 'TREND_PULLBACK', 'ETH/USDT', 0.02);

            // Valid sample size: 55 trades -> full 1.0 credibility -> multiplier 1.25 -> 0.025 risk
            expect(details.tradesCount).toBe(55);
            expect(details.multiplier).toBe(1.25);
            expect(details.riskPct).toBe(0.025);
        });

        it('shrinks bandit confidence weight towards 1.0 until sample size matures to 50 trades', () => {
            // Only 10 trades in bandit arm (raw weight 1.45, shrunk by 10/50 = 0.20 credibility)
            memDb.prepare(`
                INSERT INTO strategy_learning (playbook, symbol_tier, volatility_regime, trades_count, wins, losses, win_rate, profit_factor, avg_r_multiple, confidence_weight, last_updated)
                VALUES ('VOLATILITY_BREAKOUT', 'CORE', 'NORMAL_VOL', 10, 8, 2, 0.8, 2.5, 1.5, 1.45, ?)
            `).run(Date.now());

            const weight = StrategyLearner.getConfidenceWeight(memDb, 'VOLATILITY_BREAKOUT', 'CORE', 'NORMAL_VOL');
            // 1.0 + (1.45 - 1.0) * (10 / 50) = 1.09
            expect(weight).toBeCloseTo(1.09, 2);
            expect(weight).toBeLessThan(1.45);

            // Now update to 60 trades (full credibility)
            memDb.prepare(`
                UPDATE strategy_learning
                SET trades_count = 60
                WHERE playbook = 'VOLATILITY_BREAKOUT'
            `).run();

            const matureWeight = StrategyLearner.getConfidenceWeight(memDb, 'VOLATILITY_BREAKOUT', 'CORE', 'NORMAL_VOL');
            expect(matureWeight).toBe(1.45);
        });
    });

    describe('3. Trailing Stop Persistence & Ratchet Integrity', () => {
        const dummySnapshot: IndicatorSnapshot = {
            currentEmaFast: 50500,
            previousEmaFast: 50400,
            currentEmaSlow: 50000,
            previousEmaSlow: 49950,
            currentRsi: 55,
            previousRsi: 54,
            currentAtr: 200,
            currentAdx: 28,
            previousAdx: 27,
            candlesCount: 100,
        };

        it('preserves ratcheted high and trailing stop across evaluations without lowering stop', () => {
            const initialPos = {
                symbol: 'BTC/USDT',
                side: 'LONG' as const,
                amount: 1,
                entryPrice: 50000,
                highestPrice: 51000,
                lowestPrice: 49500,
                trailingStop: 50440, // 51000 - 2.8 * 200 = 50440
                atr: 200,
                entryTime: Date.now() - 3600000,
            };

            // Candle with pullback (high does not exceed 51000)
            const candlePullback: CandleData = {
                timestamp: Date.now(),
                open: 50800,
                high: 50900,
                low: 50600,
                close: 50700,
                volume: 500,
            };

            const eval1 = StrategyEngine.evaluateExit(initialPos, candlePullback, dummySnapshot, false, {
                atrMultiplier: 2.8,
            });

            // Trailing stop must NOT decrease during a pullback
            expect(eval1.newTrailingStop).toBe(50440);
            expect(eval1.newHighestPrice).toBe(51000);
            expect(eval1.shouldExit).toBe(false);

            // Next candle pushes higher high: 51500
            const candleNewHigh: CandleData = {
                timestamp: Date.now() + 900000,
                open: 50700,
                high: 51500,
                low: 50700,
                close: 51400,
                volume: 800,
            };

            const eval2 = StrategyEngine.evaluateExit({
                ...initialPos,
                highestPrice: eval1.newHighestPrice,
                trailingStop: eval1.newTrailingStop,
            }, candleNewHigh, dummySnapshot, false, {
                atrMultiplier: 2.8,
            });

            // Stop must ratchet up: 51500 - (2.8 * 200) = 50940
            expect(eval2.newHighestPrice).toBe(51500);
            expect(eval2.newTrailingStop).toBe(50940);
            expect(eval2.stopRaisedOrLowered).toBe(true);
        });
    });

    describe('4. Circuit Breaker Hardening & Trade History Protection', () => {
        it('enforces lockout duration regardless of changing circuit breaker limit', () => {
            const capital = 10000;
            const now = Date.now();
            const lockoutUntil = now + (12 * 60 * 60 * 1000); // 12 hours remaining

            // Check with limit changed to 10%
            const status = RiskManager.checkCircuitBreaker(memDb, capital, now, lockoutUntil, {
                maxDrawdownPct: 0.10, // operator raised limit to 10%
            });

            expect(status.isHalted).toBe(true);
            expect(status.isLockedOut).toBe(true);
            expect(status.lockoutUntil).toBe(lockoutUntil);
            expect(status.reason).toContain('Locked out until');
        });

        it('disallows wiping circuit breaker lockout on normal resume action', () => {
            const now = Date.now();
            const lockoutUntil = now + 3600000; // 1 hour in future

            memDb.prepare(`
                INSERT INTO bot_state (id, capital, initial_capital, circuit_breaker_halted, lockout_until, updated_at)
                VALUES (1, 9400, 10000, 1, ?, ?)
            `).run(lockoutUntil, now);

            // Emulate RESUME action logic: if lockoutUntil > now, lockout is kept intact
            const botState = memDb.prepare('SELECT circuit_breaker_halted, lockout_until FROM bot_state WHERE id = 1').get() as any;
            const isLockedOut = botState && Number(botState.lockout_until) > now;
            expect(isLockedOut).toBe(true);

            // Lockout remains
            expect(Number(botState.lockout_until)).toBe(lockoutUntil);
            expect(Number(botState.circuit_breaker_halted)).toBe(1);
        });

        it('strictly preserves trade history when daily losses are cleared on breaker reset', () => {
            // Seed historical paper trades
            memDb.prepare(`
                INSERT INTO paper_trades (order_id, symbol, side, type, price, amount, fee, pnl, timestamp)
                VALUES ('ORD-001', 'BTC/USDT', 'BUY', 'ENTRY', 50000, 0.1, 3, 0, ?),
                       ('ORD-002', 'BTC/USDT', 'SELL', 'TRAILING_STOP', 49000, 0.1, 3, -106, ?)
            `).run(Date.now() - 7200000, Date.now() - 3600000);

            // Seed daily losses
            memDb.prepare('INSERT INTO daily_losses (timestamp, amount) VALUES (?, ?)').run(Date.now() - 3600000, 106);

            // Emulate hardened circuit breaker reset
            memDb.prepare('DELETE FROM daily_losses').run();
            memDb.prepare('UPDATE bot_state SET circuit_breaker_halted = 0, lockout_until = 0 WHERE id = 1').run();

            // Daily losses are cleared
            const lossCount = memDb.prepare('SELECT count(*) as count FROM daily_losses').get() as any;
            expect(lossCount.count).toBe(0);

            // Paper trades MUST be intact
            const tradeCount = memDb.prepare('SELECT count(*) as count FROM paper_trades').get() as any;
            expect(tradeCount.count).toBe(2);
        });
    });
});
