import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import config, { getSlippageForSymbol } from '../src/config';
import { StrategyEngine, CandleData, IndicatorSnapshot } from '../src/strategy/core';

describe('Phase 4: Signal Timing & Paper Execution Realism', () => {
    let memDb: Database.Database;

    beforeEach(() => {
        memDb = new Database(':memory:');
        memDb.exec(`
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
                broker TEXT DEFAULT 'BYBIT',
                setup_type TEXT DEFAULT 'EMA_CROSSOVER',
                signal_price REAL,
                fill_price REAL,
                slippage REAL DEFAULT 0,
                funding_pnl REAL DEFAULT 0
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
                signal_price REAL,
                accumulated_funding REAL DEFAULT 0,
                PRIMARY KEY (symbol, broker)
            );
        `);
    });

    afterEach(() => {
        memDb.close();
    });

    describe('1. Signal Timing & Intrabar Rejection', () => {
        // Construct synthetic candle history establishing a confirmed uptrend
        function buildUptrendHistory(): CandleData[] {
            const history: CandleData[] = [];
            let price = 50000;
            const now = Date.now();
            for (let i = 60; i >= 1; i--) {
                price += 50;
                history.push({
                    timestamp: now - i * 15 * 60 * 1000,
                    open: price - 20,
                    high: price + 40,
                    low: price - 30,
                    close: price,
                    volume: 1000,
                });
            }
            return history;
        }

        it('strictly rejects entry signals on unclosed (intra-candle) bars when allowIntrabar is false', () => {
            const history = buildUptrendHistory();
            const evaluation = StrategyEngine.evaluateEntry(history, undefined, {
                isClosed: false,
                allowIntrabar: false,
                allowShorts: true,
                isExploreMode: false,
            });

            expect(evaluation.isEntry).toBe(false);
            expect(evaluation.signal).toBe('HOLD');
            expect(evaluation.reason).toContain('Intrabar: candle still open');
        });

        it('permits entry evaluation when candle is closed (isClosed === true)', () => {
            const history = buildUptrendHistory();
            const evaluation = StrategyEngine.evaluateEntry(history, undefined, {
                isClosed: true,
                allowIntrabar: false,
                allowShorts: true,
                isExploreMode: false,
            });

            // Evaluation proceeded past the intrabar gatekeeper
            expect(evaluation.reason).not.toContain('Intrabar: candle still open');
        });
    });

    describe('2. Tiered Slippage Calibration', () => {
        it('assigns 0.05% slippage to CORE tier assets', () => {
            for (const sym of config.watchlist.pinnedCorePairs) {
                expect(getSlippageForSymbol(sym)).toBe(0.0005);
            }
        });

        it('assigns 0.12% slippage to SATELLITE tier assets', () => {
            const satellitePairs = ['AVAX/USDT', 'NEAR/USDT', 'LINK/USDT', 'OP/USDT', 'TIA/USDT'];
            for (const sym of satellitePairs) {
                expect(getSlippageForSymbol(sym)).toBe(0.0012);
            }
        });

        it('correctly models entry fill price with directional adverse slippage', () => {
            const btcSignal = 60000;
            const btcSlippage = getSlippageForSymbol('BTC/USDT'); // 0.05%
            const longFill = btcSignal * (1 + btcSlippage);
            const shortFill = btcSignal * (1 - btcSlippage);

            expect(longFill).toBe(60030); // Higher price for buyers
            expect(shortFill).toBe(59970); // Lower price for sellers

            const nearSignal = 5.00;
            const nearSlippage = getSlippageForSymbol('NEAR/USDT'); // 0.12%
            const nearLongFill = nearSignal * (1 + nearSlippage);
            const nearShortFill = nearSignal * (1 - nearSlippage);

            expect(nearLongFill).toBeCloseTo(5.006, 4);
            expect(nearShortFill).toBeCloseTo(4.994, 4);
        });
    });

    describe('3. PnL Realism: Funding Rate & Execution Audit', () => {
        it('incorporates accumulated funding into net realized and unrealized PnL', () => {
            const amount = 1;
            const entryPrice = 50000;
            const exitPrice = 51000; // $1,000 gross gain
            const takerFee = 0.0006;
            const slippage = 0.0005;

            // Long position held through 3 funding intervals paying 0.01% each ($15 total funding paid)
            const fundingPnlLong = -15.00;
            const pnlLong = StrategyEngine.calculatePnL('LONG', amount, entryPrice, exitPrice, {
                slippage,
                takerFee,
                accumulatedFunding: fundingPnlLong,
            });

            // Gross exit: 51000 * (1 - 0.0005) = 50974.5
            // Fee: 50974.5 * 0.0006 = 30.5847
            // Net without funding: 50974.5 - 30.5847 - 50000 = 943.9153
            // With -$15 funding: 943.9153 - 15 = 928.9153
            expect(pnlLong.netRealizedPnl).toBeCloseTo(928.92, 2);
            expect(pnlLong.fundingPnl).toBe(-15.00);

            // Short position receiving +$15 funding
            const fundingPnlShort = +15.00;
            const pnlShort = StrategyEngine.calculatePnL('SHORT', amount, entryPrice, 49000, {
                slippage,
                takerFee,
                accumulatedFunding: fundingPnlShort,
            });

            // Initial: 50000
            // Gross cover: 49000 * (1 + 0.0005) = 49024.5
            // Fee: 49024.5 * 0.0006 = 29.4147
            // Net without funding: 50000 - 49024.5 - 29.4147 = 946.0853
            // With +$15 funding: 946.0853 + 15 = 961.0853
            expect(pnlShort.netRealizedPnl).toBeCloseTo(961.09, 2);
            expect(pnlShort.fundingPnl).toBe(15.00);
        });

        it('persists and audits signal_price vs fill_price in database', () => {
            const insertStmt = memDb.prepare(`
                INSERT INTO paper_trades (
                    order_id, symbol, side, type, price, amount, fee, pnl, pnl_percent, timestamp, direction, execution_mode, broker, setup_type, signal_price, fill_price, slippage, funding_pnl
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const signalPrice = 60000;
            const slippage = 0.0005;
            const fillPrice = signalPrice * (1 + slippage);
            const fee = fillPrice * 1.5 * 0.0006;

            insertStmt.run(
                'ORD-TEST-001', 'BTC/USDT', 'BUY', 'ENTRY', fillPrice, 1.5, fee, 0, 0,
                Date.now(), 'LONG', 'LIVE_FORWARD', 'BYBIT', 'TREND_PULLBACK',
                signalPrice, fillPrice, slippage, 0
            );

            const row = memDb.prepare('SELECT * FROM paper_trades WHERE order_id = ?').get('ORD-TEST-001') as any;
            expect(row.signal_price).toBe(60000);
            expect(row.fill_price).toBe(60030);
            expect(row.slippage).toBe(0.0005);
            expect(row.funding_pnl).toBe(0);
        });
    });

    describe('4. Trailing Stop Behavior (Intrabar vs Close)', () => {
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

        it('triggers stop exit intrabar when testPrice breaches trailing stop', () => {
            const pos = {
                symbol: 'BTC/USDT',
                side: 'LONG' as const,
                amount: 1,
                entryPrice: 50000,
                highestPrice: 50500,
                lowestPrice: 49800,
                trailingStop: 50000, // stop at 50000
                atr: 200,
                entryTime: Date.now() - 3600000,
            };

            const unclosedCandle: CandleData = {
                timestamp: Date.now(),
                open: 50200,
                high: 50300,
                low: 49900, // dips below stop of 50000
                close: 50100,
                volume: 500,
            };

            const exit = StrategyEngine.evaluateExit(pos, unclosedCandle, dummySnapshot, false, {
                trailingStopMode: 'intrabar',
                slippage: 0.0005,
            });

            expect(exit.shouldExit).toBe(true);
            expect(exit.reason).toBe('TRAILING_STOP');
            expect(exit.executionPrice).toBe(50000 * (1 - 0.0005)); // 49975
        });
    });
});
