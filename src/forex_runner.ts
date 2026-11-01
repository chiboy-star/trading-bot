import { db } from './db';
import config from './config';
import { createLogger } from './utils/logger';
import { StrategyEngine, RiskManager, CandleData } from './strategy/core';

const log = createLogger('forex-runner');

const insertTradeStmt = db.prepare(`
    INSERT INTO paper_trades (order_id, symbol, side, type, price, amount, fee, pnl, pnl_percent, timestamp, direction, execution_mode, broker)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function generateOrderId(symbol: string): string {
    const cleanSym = symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `FX-${cleanSym}-${Date.now().toString().slice(-4)}-${rand}`;
}

/**
 * Logs a forex trade into the database, explicitly setting execution_mode to 'LIVE_FORWARD' and broker to 'OANDA'.
 */
export function logForexTrade(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'ENTRY' | 'TRAILING_STOP' | 'EMA_CROSS' | 'MANUAL_CLOSE',
    price: number,
    amount: number,
    fee: number,
    pnl: number,
    pnlPercent: number,
    timestamp: number = Date.now(),
    direction: 'LONG' | 'SHORT' = 'LONG',
    executionMode: 'LIVE_FORWARD' | 'BACKTEST_MOCK' = 'LIVE_FORWARD',
    broker: string = 'OANDA'
) {
    const orderId = generateOrderId(symbol);
    insertTradeStmt.run(orderId, symbol, side, type, price, amount, fee, pnl, pnlPercent, timestamp, direction, executionMode, broker);
    log.info({ symbol, direction, side, type, price, amount, pnl, broker }, `[FOREX ${broker}] Logged ${direction} trade on ${symbol}`);
}

/**
 * Forex paper trading runner wired to the centralized StrategyEngine and RiskManager.
 * Disabled by default; toggled via FOREX_ENABLED=true in .env.
 */
export class ForexPaperRunner {
    private isRunning: boolean = false;
    private symbol: string = 'EUR/USD';

    public start(): void {
        // SAFETY DIRECTIVE HARD BLOCK:
        // Live execution requires explicit LIVE mode and written operator approval
        if (config.app.isLive) {
            const liveModeAllowed = config.app.isLive && process.env.LIVE_EXECUTION_WRITTEN_APPROVAL === 'APPROVED_LIVE_EXECUTION_BY_OPERATOR';
            if (!liveModeAllowed) {
                log.fatal('⚠️ SAFETY HARD BLOCK: Forex live execution requires BOTH EXECUTION_MODE=LIVE (--live) AND LIVE_EXECUTION_WRITTEN_APPROVAL="APPROVED_LIVE_EXECUTION_BY_OPERATOR". Halting execution.');
                throw new Error('Forex live execution blocked: Missing written operator approval.');
            }
        }

        if (!config.forex.enabled) {
            log.info('Forex paper runner is disabled by default (FOREX_ENABLED=false). To activate, configure FOREX_ENABLED=true and OANDA credentials in .env.');
            return;
        }

        this.isRunning = true;
        log.info({ symbol: this.symbol }, 'Starting Forex paper trading runner connected to StrategyEngine...');

        // Graceful lifecycle shutdown
        const shutdown = () => {
            if (!this.isRunning) return;
            log.info('Shutting down Forex paper runner gracefully...');
            this.isRunning = false;
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    }

    public evaluateMarket(candles: CandleData[]): void {
        if (!this.isRunning || candles.length < 50) return;

        const signal = StrategyEngine.evaluateEntry(candles, undefined, { allowShorts: true });
        if (signal.isEntry && signal.direction) {
            log.info({ signal: signal.signal, direction: signal.direction, reason: signal.reason }, 'Forex signal generated');
        }
    }
}

if (require.main === module) {
    const runner = new ForexPaperRunner();
    runner.start();
}
