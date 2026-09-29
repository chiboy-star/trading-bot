import ccxt from 'ccxt';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { EMA, RSI, ADX, ATR } from 'technicalindicators';
import { notifyOrderEntered, notifyPositionClosed, notifyCircuitBreaker } from './services/notifier';
import { DynamicAssetScreener, getMonitoredPairs } from './screener';

// Load environment variables (.env)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Database setup - always targets canonical root data/market_data.db
function getCanonicalDbPath(): string {
    const rootPath = path.resolve(process.cwd(), 'data/market_data.db');
    if (fs.existsSync(rootPath)) return rootPath;
    const parentPath = path.resolve(process.cwd(), '../data/market_data.db');
    if (fs.existsSync(parentPath)) return parentPath;
    return path.resolve(__dirname, '../../data/market_data.db');
}
export const db = new Database(getCanonicalDbPath());

// Initialize schema for paper trading & dashboard synchronization
db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        UNIQUE(symbol, timeframe, timestamp)
    );

    CREATE TABLE IF NOT EXISTS paper_trades (
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

    CREATE TABLE IF NOT EXISTS active_positions (
        symbol TEXT PRIMARY KEY,
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
        broker TEXT DEFAULT 'BYBIT'
    );

    CREATE TABLE IF NOT EXISTS bot_state (
        id INTEGER PRIMARY KEY,
        capital REAL NOT NULL,
        initial_capital REAL NOT NULL,
        circuit_breaker_halted INTEGER DEFAULT 0,
        lockout_until INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitored_pairs (
        symbol TEXT PRIMARY KEY,
        base_asset TEXT NOT NULL,
        quote_asset TEXT NOT NULL,
        daily_adx REAL NOT NULL,
        volume_24h REAL NOT NULL,
        rank INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_losses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        amount REAL NOT NULL
    );
`);

// Safe column migrations for existing databases
try {
    const cols = db.prepare("PRAGMA table_info(paper_trades)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    if (!colNames.includes('pnl')) {
        db.exec("ALTER TABLE paper_trades ADD COLUMN pnl REAL DEFAULT 0;");
    }
    if (!colNames.includes('pnl_percent')) {
        db.exec("ALTER TABLE paper_trades ADD COLUMN pnl_percent REAL DEFAULT 0;");
    }
    if (!colNames.includes('direction')) {
        db.exec("ALTER TABLE paper_trades ADD COLUMN direction TEXT DEFAULT 'LONG';");
    }
    if (!colNames.includes('execution_mode')) {
        db.exec("ALTER TABLE paper_trades ADD COLUMN execution_mode TEXT DEFAULT 'LIVE_FORWARD';");
    }
    if (!colNames.includes('broker')) {
        db.exec("ALTER TABLE paper_trades ADD COLUMN broker TEXT DEFAULT 'BYBIT';");
    }
} catch (e) {
    console.warn(`\x1b[33m[DB MIGRATION WARNING]\x1b[0m paper_trades migration issue:`, e);
}

try {
    const posCols = db.prepare("PRAGMA table_info(active_positions)").all() as { name: string }[];
    const posColNames = posCols.map(c => c.name);
    if (!posColNames.includes('side')) {
        db.exec("ALTER TABLE active_positions ADD COLUMN side TEXT DEFAULT 'LONG';");
    }
    if (!posColNames.includes('lowest_price')) {
        db.exec("ALTER TABLE active_positions ADD COLUMN lowest_price REAL DEFAULT 0;");
    }
    if (!posColNames.includes('broker')) {
        db.exec("ALTER TABLE active_positions ADD COLUMN broker TEXT DEFAULT 'BYBIT';");
    }
} catch (e) {
    console.warn(`\x1b[33m[DB MIGRATION WARNING]\x1b[0m active_positions migration issue:`, e);
}

// Prepared database statements
const upsertCandleStmt = db.prepare(`
    INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, timeframe, timestamp) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume;
`);

const insertTradeStmt = db.prepare(`
    INSERT INTO paper_trades (order_id, symbol, side, type, price, amount, fee, pnl, pnl_percent, timestamp, direction, execution_mode, broker)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertActivePosStmt = db.prepare(`
    INSERT INTO active_positions (symbol, side, amount, entry_price, current_price, highest_price, lowest_price, trailing_stop, atr, pnl, pnl_percent, entry_time, updated_at, broker)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
        side = excluded.side,
        amount = excluded.amount,
        entry_price = excluded.entry_price,
        current_price = excluded.current_price,
        highest_price = excluded.highest_price,
        lowest_price = excluded.lowest_price,
        trailing_stop = excluded.trailing_stop,
        atr = excluded.atr,
        pnl = excluded.pnl,
        pnl_percent = excluded.pnl_percent,
        updated_at = excluded.updated_at,
        broker = excluded.broker;
`);

const deleteActivePosStmt = db.prepare(`
    DELETE FROM active_positions WHERE symbol = ?
`);

const insertDailyLossStmt = db.prepare(`
    INSERT INTO daily_losses (timestamp, amount) VALUES (?, ?)
`);

const cleanOldLossesStmt = db.prepare(`
    DELETE FROM daily_losses WHERE timestamp < ?
`);

const updateBotStateStmt = db.prepare(`
    INSERT INTO bot_state (id, capital, initial_capital, circuit_breaker_halted, lockout_until, updated_at)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        capital = excluded.capital,
        initial_capital = excluded.initial_capital,
        circuit_breaker_halted = excluded.circuit_breaker_halted,
        lockout_until = excluded.lockout_until,
        updated_at = excluded.updated_at;
`);

// ANSI Colors for terminal logging
const C = {
    RESET: "\x1b[0m",
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    BLUE: "\x1b[34m",
    CYAN: "\x1b[36m",
    MAGENTA: "\x1b[35m",
    DIM: "\x1b[2m",
    BOLD: "\x1b[1m"
};

// Periodic summary tracking
let lastSummaryTime = Date.now();
const SUMMARY_INTERVAL = 5 * 60 * 1000; // 5 minutes

function maybePrintSummary() {
    const now = Date.now();
    if (now - lastSummaryTime >= SUMMARY_INTERVAL) {
        lastSummaryTime = now;
        // Use latest DB current_price for accurate unrealized PnL (not watermarks)
        const totalUnrealized = Array.from(positions.values()).reduce((sum, p) => {
            const posRow = db.prepare('SELECT current_price FROM active_positions WHERE symbol = ?').get(p.symbol) as { current_price: number } | undefined;
            const curPrice = posRow ? posRow.current_price : p.entryPrice;
            if (p.side === 'LONG') {
                return sum + (p.amount * curPrice - p.amount * p.entryPrice);
            } else {
                return sum + (p.amount * p.entryPrice - p.amount * curPrice);
            }
        }, 0);
        const pnlPct = ((capital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100);
        const pnlSign = pnlPct >= 0 ? '+' : '';
        const unrealizedSign = totalUnrealized >= 0 ? '+' : '';
        console.log(`\n${C.CYAN}${C.BOLD}⏰ 5-MIN STATUS UPDATE${C.RESET}`);
        console.log(`${C.CYAN}───────────────────────────────────────────────────${C.RESET}`);
        console.log(`   💰 Balance: $${capital.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}% overall)`);
        console.log(`   📊 Watching: ${monitoredSymbols.length} coins (${monitoredSymbols.join(', ')})`);
        console.log(`   📂 Open Trades: ${positions.size} | Unrealized: ${unrealizedSign}$${Math.abs(totalUnrealized).toFixed(2)}`);
        if (positions.size > 0) {
            for (const [sym, pos] of positions) {
                const dirEmoji = pos.side === 'LONG' ? '🟢' : '🔴';
                console.log(`       ${dirEmoji} ${sym} (${pos.side}) — Entry: $${pos.entryPrice.toFixed(2)} | Stop: $${pos.trailingStop.toFixed(2)}`);
            }
        }
        const isLocked = Date.now() < lockoutUntil;
        console.log(`   🛡️  Safety: ${isLocked ? '⛔ HALTED (circuit breaker active)' : '✅ Normal — all systems go'}`);
        console.log(`${C.CYAN}───────────────────────────────────────────────────${C.RESET}\n`);
    }
}

// Strategy & Risk Configuration
export const INITIAL_CAPITAL = 10000;
export const ATR_MULTIPLIER = 1.5;
export const MAX_RISK_PCT = 0.02; // Risk strictly 2% of portfolio per position
export const TAKER_FEE = 0.00075; // 0.075%
export const SLIPPAGE = 0.0005;   // 0.05%
export const TIMEFRAME = '1h';

export interface Position {
    symbol: string;
    side: 'LONG' | 'SHORT';
    amount: number;
    entryPrice: number;
    highestPrice: number;
    lowestPrice: number;
    trailingStop: number;
    entryTime: number;
    atr: number;
}

// In-memory state tracking
let capital = INITIAL_CAPITAL;
const positions: Map<string, Position> = new Map();
let dailyLosses: { timestamp: number, amount: number }[] = [];
let lockoutUntil = 0;
let monitoredSymbols: string[] = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];

/**
 * Persists a loss record to SQLite and adds it to the in-memory array.
 * This ensures the circuit breaker survives bot restarts.
 */
function recordDailyLoss(timestamp: number, amount: number) {
    dailyLosses.push({ timestamp, amount });
    insertDailyLossStmt.run(timestamp, amount);
}

// Restore capital and positions from SQLite if present
(() => {
    const state = db.prepare('SELECT capital, circuit_breaker_halted, lockout_until FROM bot_state WHERE id = 1').get() as any;
    if (state) {
        capital = state.capital;
        lockoutUntil = state.lockout_until;
    } else {
        updateBotStateStmt.run(INITIAL_CAPITAL, INITIAL_CAPITAL, 0, 0, Date.now());
    }

    // Restore daily losses from SQLite (rolling 24h window)
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    cleanOldLossesStmt.run(twentyFourHoursAgo);
    const savedLosses = db.prepare('SELECT timestamp, amount FROM daily_losses ORDER BY timestamp ASC').all() as { timestamp: number, amount: number }[];
    dailyLosses = savedLosses;

    const savedPositions = db.prepare('SELECT * FROM active_positions').all() as any[];
    for (const p of savedPositions) {
        positions.set(p.symbol, {
            symbol: p.symbol,
            side: (p.side === 'SHORT' ? 'SHORT' : 'LONG'),
            amount: p.amount,
            entryPrice: p.entry_price,
            highestPrice: p.highest_price,
            lowestPrice: p.lowest_price ?? p.entry_price,
            trailingStop: p.trailing_stop,
            entryTime: p.entry_time,
            atr: p.atr
        });
    }

    // Initialize monitored pairs
    const pairs = getMonitoredPairs();
    if (pairs && pairs.length > 0) {
        monitoredSymbols = pairs;
    }
})();

function persistState() {
    const isHalted = Date.now() < lockoutUntil ? 1 : 0;
    updateBotStateStmt.run(capital, INITIAL_CAPITAL, isHalted, lockoutUntil, Date.now());
}

export function getCapital() {
    return capital;
}

export function getPositions() {
    return positions;
}

function generateOrderId() {
    return 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function logTrade(
    symbol: string,
    side: string,
    type: string,
    price: number,
    amount: number,
    fee: number,
    pnl: number,
    pnlPercent: number,
    timestamp: number,
    direction: 'LONG' | 'SHORT' = 'LONG',
    executionMode: 'LIVE_FORWARD' | 'BACKTEST_MOCK' = 'LIVE_FORWARD',
    broker: string = 'BYBIT'
) {
    const orderId = generateOrderId();
    insertTradeStmt.run(orderId, symbol, side, type, price, amount, fee, pnl, pnlPercent, timestamp, direction, executionMode, broker);
    const color = direction === 'LONG' ? C.GREEN : C.MAGENTA;
    const dirEmoji = direction === 'LONG' ? '🟢' : '🔴';
    const actionVerb = side === 'BUY' ? 'Bought' : 'Sold';
    const pnlStr = pnl !== 0 ? ` | Result: ${pnl > 0 ? '✅ Profit' : '❌ Loss'} $${Math.abs(pnl).toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)` : '';
    console.log(`${color}${dirEmoji} ${actionVerb} ${symbol}${C.RESET} @ $${price.toFixed(2)} | Size: ${amount.toFixed(4)} | Fee: $${fee.toFixed(2)}${pnlStr} | Broker: ${broker}`);
}

function checkCircuitBreaker(timestamp: number): boolean {
    const now = Date.now();
    if (now < lockoutUntil || timestamp < lockoutUntil) {
        return true; // Locked out
    }

    // Clean old losses (> 24h rolling window) from memory and DB
    const twentyFourHours = 24 * 60 * 60 * 1000;
    dailyLosses = dailyLosses.filter(l => (timestamp - l.timestamp) <= twentyFourHours);
    cleanOldLossesStmt.run(timestamp - twentyFourHours);
    
    const totalLoss = dailyLosses.reduce((sum, l) => sum + l.amount, 0);
    if (totalLoss >= capital * 0.05) {
        console.log(`\n${C.RED}${C.BOLD}🚨 EMERGENCY STOP — TRADING PAUSED FOR 24 HOURS${C.RESET}`);
        console.log(`${C.RED}   Reason: Lost $${totalLoss.toFixed(2)} in the last 24 hours (over 5% of $${capital.toFixed(2)} balance).${C.RESET}`);
        console.log(`${C.RED}   This is a safety feature to prevent further losses during a bad streak.${C.RESET}`);
        console.log(`${C.RED}   Trading will resume automatically in 24 hours.${C.RESET}\n`);
        lockoutUntil = timestamp + twentyFourHours;
        persistState();
        
        // Dispatch emergency Discord Alert
        notifyCircuitBreaker({
            totalLoss,
            capital,
            lockoutUntil,
            timestamp
        }).catch(err => console.error("Discord alert error:", err));
        return true;
    }

    return false;
}

/**
 * Normalizes symbol to Bybit's canonical CCXT linear perpetual futures symbol (e.g. BTC/USDT -> BTC/USDT:USDT).
 */
export function toExchangeSymbol(symbol: string): string {
    if (symbol.includes(':')) return symbol;
    if (symbol.endsWith('/USDT')) return `${symbol}:USDT`;
    return symbol;
}

/**
 * Safely fetches OHLCV data with sequential retry and exponential backoff for RateLimitExceeded (Bybit 10006).
 */
export async function fetchOHLCVWithRetry(
    exchange: any,
    symbol: string,
    timeframe: string,
    since: number | undefined,
    limit: number,
    maxRetries: number = 3
): Promise<any[]> {
    let delay = 5000; // Start with 5-second backoff
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await exchange.fetchOHLCV(symbol, timeframe, since, limit);
        } catch (err: any) {
            const isRateLimit =
                err instanceof ccxt.RateLimitExceeded ||
                err?.name === 'RateLimitExceeded' ||
                (err?.message && (err.message.includes('10006') || err.message.toLowerCase().includes('rate limit')));

            if (isRateLimit && attempt < maxRetries) {
                console.warn(
                    `${C.YELLOW}[RATE LIMIT EXCEEDED]${C.RESET} Bybit 10006 on ${symbol}. Waiting ${delay / 1000}s before retry (Attempt ${attempt}/${maxRetries})...`
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff: 5s -> 10s -> 20s
            } else {
                throw err;
            }
        }
    }
    return [];
}

/**
 * Seeds historical candles via CCXT if symbol history is insufficient (< 150 bars).
 */
export async function seedHistoryIfNeeded(exchange: any) {
    for (const symbol of monitoredSymbols) {
        const countRow = db.prepare('SELECT count(*) as c FROM candles WHERE symbol = ? AND timeframe = ?').get(symbol, TIMEFRAME) as { c: number };
        if (!countRow || countRow.c < 150) {
            console.log(`${C.CYAN}[SEEDING HISTORY]${C.RESET} Fetching 200 historical candles for ${symbol}...`);
            try {
                const marketSymbol = toExchangeSymbol(symbol);
                const ohlcv = await fetchOHLCVWithRetry(exchange, marketSymbol, TIMEFRAME, undefined, 200);
                if (ohlcv && ohlcv.length > 0) {
                    const insertMany = db.transaction((candlesArr: any[]) => {
                        for (const c of candlesArr) {
                            upsertCandleStmt.run(symbol, TIMEFRAME, c[0], c[1], c[2], c[3], c[4], c[5] || 0);
                        }
                    });
                    insertMany(ohlcv);
                    console.log(`${C.GREEN}[SEEDING COMPLETE]${C.RESET} Loaded ${ohlcv.length} candles for ${symbol}.`);
                }
            } catch (err) {
                console.error(`Failed to seed candles for ${symbol}:`, err);
            }
            // 200ms delay between pair fetches
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
}

/**
 * Processes price ticks (either newly closed candles or incoming incomplete bar updates).
 * Evaluates bidirectional (Long & Short) entry and exit rules.
 */
export async function processTick(
    symbol: string,
    timeframe: string,
    candle: [number, number, number, number, number, number],
    isClosed: boolean
) {
    const [timestamp, open, high, low, close, volume] = candle;
    const isHalted = checkCircuitBreaker(timestamp);

    // Persist candle update
    upsertCandleStmt.run(symbol, timeframe, timestamp, open, high, low, close, volume);

    // Load recent history (150 candles) for numerical indicator warm-up
    const rows = db.prepare(`
        SELECT open, high, low, close FROM candles 
        WHERE symbol = ? AND timeframe = ? 
        ORDER BY timestamp DESC LIMIT 150
    `).all(symbol, timeframe) as { open: number, high: number, low: number, close: number }[];

    if (rows.length < 50) {
        return;
    }

    // Reverse to chronological order (oldest to newest)
    const history = rows.reverse();
    const highs = history.map(c => c.high);
    const lows = history.map(c => c.low);
    const closes = history.map(c => c.close);

    // Compute technical indicators
    const ema20Arr = EMA.calculate({ period: 20, values: closes });
    const ema50Arr = EMA.calculate({ period: 50, values: closes });
    const rsi14Arr = RSI.calculate({ period: 14, values: closes });
    const adx14Arr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    const atr14Arr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

    const currentEma20 = ema20Arr[ema20Arr.length - 1];
    const previousEma20 = ema20Arr[ema20Arr.length - 2];
    const currentEma50 = ema50Arr[ema50Arr.length - 1];
    const previousEma50 = ema50Arr[ema50Arr.length - 2];
    const currentRsi = rsi14Arr[rsi14Arr.length - 1];
    const currentAdx = adx14Arr[adx14Arr.length - 1]?.adx ?? 0;
    const currentAtr = atr14Arr[atr14Arr.length - 1] ?? 0;

    // -------------------------------------------------------------
    // 1. BIDIRECTIONAL POSITION MANAGEMENT & ATR TRAILING STOP-LOSS
    // -------------------------------------------------------------
    if (positions.has(symbol)) {
        const pos = positions.get(symbol)!;
        const effectiveAtr = currentAtr > 0 ? currentAtr : pos.atr;

        if (pos.side === 'LONG') {
            // LONG TRAILING STOP: Ratchets UP based on new recent highs
            if (high > pos.highestPrice) {
                pos.highestPrice = high;
                const proposedStop = pos.highestPrice - (ATR_MULTIPLIER * effectiveAtr);
                if (proposedStop > pos.trailingStop) {
                    pos.trailingStop = proposedStop;
                    console.log(`${C.CYAN}🔒 Safety stop raised:${C.RESET} ${symbol} hit new high ($${pos.highestPrice.toFixed(2)}), auto-exit price moved up to $${pos.trailingStop.toFixed(2)} to lock in more profit`);
                }
            }

            // Live unrealized PnL calculation (Long)
            const unrealizedPnl = (pos.amount * close * (1 - SLIPPAGE) * (1 - TAKER_FEE)) - (pos.amount * pos.entryPrice);
            const unrealizedPnlPct = (unrealizedPnl / (pos.amount * pos.entryPrice)) * 100;

            // Sync with SQLite active_positions table
            upsertActivePosStmt.run(
                pos.symbol,
                pos.side,
                pos.amount,
                pos.entryPrice,
                close,
                pos.highestPrice,
                pos.lowestPrice,
                pos.trailingStop,
                pos.atr,
                unrealizedPnl,
                unrealizedPnlPct,
                pos.entryTime,
                timestamp,
                'BYBIT'
            );

            // Check if Long Trailing Stop is breached
            if (low <= pos.trailingStop) {
                const executionPrice = pos.trailingStop * (1 - SLIPPAGE);
                const grossValue = pos.amount * executionPrice;
                const fee = grossValue * TAKER_FEE;
                const netValue = grossValue - fee;
                const pnl = netValue - (pos.amount * pos.entryPrice);
                const pnlPercent = (pnl / (pos.amount * pos.entryPrice)) * 100;

                console.log(`${C.YELLOW}⚡ Auto-exit triggered:${C.RESET} ${symbol} price ($${low.toFixed(2)}) dropped below safety stop ($${pos.trailingStop.toFixed(2)}) — closing to protect capital`);
                
                if (pnl < 0) {
                    recordDailyLoss(timestamp, Math.abs(pnl));
                }
                capital += netValue;
                logTrade(symbol, 'SELL', 'TRAILING_STOP', executionPrice, pos.amount, fee, pnl, pnlPercent, timestamp, 'LONG', 'LIVE_FORWARD');
                
                positions.delete(symbol);
                deleteActivePosStmt.run(symbol);
                persistState();

                notifyPositionClosed({
                    symbol,
                    exitPrice: executionPrice,
                    pnl,
                    pnlPercent,
                    reason: 'TRAILING_STOP (LONG)',
                    durationMs: timestamp - pos.entryTime,
                    timestamp
                }).catch(err => console.error("Discord alert error:", err));

                checkCircuitBreaker(timestamp);
                return;
            }

            // Check Long Strategy Exit on closed candle (20 EMA crosses below 50 EMA)
            if (isClosed) {
                const crossedBelow = previousEma20 >= previousEma50 && currentEma20 < currentEma50;
                if (crossedBelow) {
                    console.log(`${C.YELLOW}📉 Trend reversed:${C.RESET} ${symbol} short-term trend crossed below long-term trend — exiting long position`);
                    const executionPrice = close * (1 - SLIPPAGE);
                    const grossValue = pos.amount * executionPrice;
                    const fee = grossValue * TAKER_FEE;
                    const netValue = grossValue - fee;
                    const pnl = netValue - (pos.amount * pos.entryPrice);
                    const pnlPercent = (pnl / (pos.amount * pos.entryPrice)) * 100;

                    if (pnl < 0) {
                        recordDailyLoss(timestamp, Math.abs(pnl));
                    }
                    capital += netValue;
                    logTrade(symbol, 'SELL', 'EMA_CROSS', executionPrice, pos.amount, fee, pnl, pnlPercent, timestamp, 'LONG', 'LIVE_FORWARD');

                    positions.delete(symbol);
                    deleteActivePosStmt.run(symbol);
                    persistState();

                    notifyPositionClosed({
                        symbol,
                        exitPrice: executionPrice,
                        pnl,
                        pnlPercent,
                        reason: 'EMA_CROSS (LONG)',
                        durationMs: timestamp - pos.entryTime,
                        timestamp
                    }).catch(err => console.error("Discord alert error:", err));

                    checkCircuitBreaker(timestamp);
                    return;
                }
            }
        } else if (pos.side === 'SHORT') {
            // SHORT TRAILING STOP: Ratchets DOWN based on new recent lows
            if (low < pos.lowestPrice) {
                pos.lowestPrice = low;
                const proposedStop = pos.lowestPrice + (ATR_MULTIPLIER * effectiveAtr);
                if (proposedStop < pos.trailingStop) {
                    pos.trailingStop = proposedStop;
                    console.log(`${C.CYAN}🔒 Safety stop lowered:${C.RESET} ${symbol} hit new low ($${pos.lowestPrice.toFixed(2)}), auto-exit price moved down to $${pos.trailingStop.toFixed(2)} to lock in short profit`);
                }
            }

            // Live unrealized PnL calculation (Short: profit when current price is below entry)
            const coverCost = pos.amount * close * (1 + SLIPPAGE) * (1 + TAKER_FEE);
            const unrealizedPnl = (pos.amount * pos.entryPrice) - coverCost;
            const unrealizedPnlPct = (unrealizedPnl / (pos.amount * pos.entryPrice)) * 100;

            upsertActivePosStmt.run(
                pos.symbol,
                pos.side,
                pos.amount,
                pos.entryPrice,
                close,
                pos.highestPrice,
                pos.lowestPrice,
                pos.trailingStop,
                pos.atr,
                unrealizedPnl,
                unrealizedPnlPct,
                pos.entryTime,
                timestamp,
                'BYBIT'
            );

            // Check if Short Trailing Stop is breached (high rises through stop)
            if (high >= pos.trailingStop) {
                const executionPrice = pos.trailingStop * (1 + SLIPPAGE);
                const grossCost = pos.amount * executionPrice;
                const fee = grossCost * TAKER_FEE;
                const pnl = (pos.amount * pos.entryPrice) - grossCost - fee;
                const pnlPercent = (pnl / (pos.amount * pos.entryPrice)) * 100;

                console.log(`${C.YELLOW}⚡ Auto-exit triggered:${C.RESET} ${symbol} price ($${high.toFixed(2)}) rose above safety stop ($${pos.trailingStop.toFixed(2)}) — closing short to protect capital`);
                
                if (pnl < 0) {
                    recordDailyLoss(timestamp, Math.abs(pnl));
                }
                // Return original collateral plus realized PnL
                capital += (pos.amount * pos.entryPrice) + pnl;
                logTrade(symbol, 'BUY', 'TRAILING_STOP', executionPrice, pos.amount, fee, pnl, pnlPercent, timestamp, 'SHORT', 'LIVE_FORWARD');
                
                positions.delete(symbol);
                deleteActivePosStmt.run(symbol);
                persistState();

                notifyPositionClosed({
                    symbol,
                    exitPrice: executionPrice,
                    pnl,
                    pnlPercent,
                    reason: 'TRAILING_STOP (SHORT)',
                    durationMs: timestamp - pos.entryTime,
                    timestamp
                }).catch(err => console.error("Discord alert error:", err));

                checkCircuitBreaker(timestamp);
                return;
            }

            // Check Short Strategy Exit on closed candle (20 EMA crosses above 50 EMA)
            if (isClosed) {
                const crossedAbove = previousEma20 <= previousEma50 && currentEma20 > currentEma50;
                if (crossedAbove) {
                    console.log(`${C.YELLOW}📈 Trend reversed:${C.RESET} ${symbol} short-term trend crossed above long-term trend — exiting short position`);
                    const executionPrice = close * (1 + SLIPPAGE);
                    const grossCost = pos.amount * executionPrice;
                    const fee = grossCost * TAKER_FEE;
                    const pnl = (pos.amount * pos.entryPrice) - grossCost - fee;
                    const pnlPercent = (pnl / (pos.amount * pos.entryPrice)) * 100;

                    if (pnl < 0) {
                        recordDailyLoss(timestamp, Math.abs(pnl));
                    }
                    capital += (pos.amount * pos.entryPrice) + pnl;
                    logTrade(symbol, 'BUY', 'EMA_CROSS', executionPrice, pos.amount, fee, pnl, pnlPercent, timestamp, 'SHORT', 'LIVE_FORWARD');

                    positions.delete(symbol);
                    deleteActivePosStmt.run(symbol);
                    persistState();

                    notifyPositionClosed({
                        symbol,
                        exitPrice: executionPrice,
                        pnl,
                        pnlPercent,
                        reason: 'EMA_CROSS (SHORT)',
                        durationMs: timestamp - pos.entryTime,
                        timestamp
                    }).catch(err => console.error("Discord alert error:", err));

                    checkCircuitBreaker(timestamp);
                    return;
                }
            }
        }
    }

    // -------------------------------------------------------------
    // 2. BIDIRECTIONAL ENTRY CONDITIONS (Evaluated on Closed Candles)
    // -------------------------------------------------------------
    if (isClosed) {
        const adxPassed = currentAdx > 25;
        const longRsiPassed = currentRsi >= 40 && currentRsi <= 65;
        const shortRsiPassed = currentRsi >= 35 && currentRsi <= 60;
        const longEmaCross = previousEma20 <= previousEma50 && currentEma20 > currentEma50;
        const shortEmaCross = previousEma20 >= previousEma50 && currentEma20 < currentEma50;

        // Human-readable market status
        const trendStatus = adxPassed ? `${C.GREEN}✅ Trending${C.RESET}` : `${C.RED}❌ Choppy/Sideways${C.RESET}`;
        const trendWord = currentEma20 > currentEma50 ? 'upward' : 'downward';
        const momentumWord = currentRsi > 60 ? 'overbought (risky to buy)' : currentRsi < 40 ? 'oversold (risky to sell)' : 'healthy';
        
        console.log(
            `${C.DIM}📊 ${symbol}${C.RESET} $${close.toFixed(2)} | ` +
            `Market: ${trendStatus} (ADX ${currentAdx.toFixed(0)}) | ` +
            `Direction: ${trendWord} | ` +
            `Momentum: ${momentumWord} (RSI ${currentRsi.toFixed(0)})`
        );

        if (!positions.has(symbol) && !isHalted) {
            // A. LONG ENTRY: 20 EMA > 50 EMA AND RSI 40-65 AND ADX > 25
            if (longEmaCross && longRsiPassed && adxPassed) {
                console.log(`\n${C.GREEN}${C.BOLD}🟢 BUYING ${symbol}${C.RESET} — All 3 conditions met:`);
                console.log(`   ✅ Market trending strongly (ADX ${currentAdx.toFixed(0)} > 25)`);
                console.log(`   ✅ Momentum is safe to enter (RSI ${currentRsi.toFixed(0)} in 40-65 range)`);
                console.log(`   ✅ Uptrend just started (fast average crossed above slow average)`);
                
                const executionPrice = close * (1 + SLIPPAGE);
                const stopDistance = ATR_MULTIPLIER * currentAtr;
                const initialTrailingStop = executionPrice - stopDistance;

                // Position sizing: Risk strictly 2% of portfolio per position
                const riskAmount = capital * MAX_RISK_PCT;
                const maxPositionSize = stopDistance > 0 ? riskAmount / stopDistance : 0;
                const maxAffordableSize = (capital * (1 - TAKER_FEE)) / executionPrice;
                const positionSize = Math.min(maxPositionSize, maxAffordableSize);

                if (positionSize <= 0) {
                    console.log(`${C.RED}⚠️  Cannot buy ${symbol}${C.RESET} — calculated position size is too small`);
                    return;
                }

                // Critical: Verify sufficient capital before entry
                const totalCost = (positionSize * executionPrice) + (positionSize * executionPrice * TAKER_FEE);
                if (totalCost > capital) {
                    console.log(`${C.RED}⚠️  Cannot buy ${symbol}${C.RESET} — not enough capital ($${capital.toFixed(2)} available, $${totalCost.toFixed(2)} needed)`);
                    return;
                }

                const cost = positionSize * executionPrice;
                const fee = cost * TAKER_FEE;

                capital -= (cost + fee);
                const newPos: Position = {
                    symbol,
                    side: 'LONG',
                    amount: positionSize,
                    entryPrice: executionPrice,
                    highestPrice: executionPrice,
                    lowestPrice: executionPrice,
                    trailingStop: initialTrailingStop,
                    entryTime: timestamp,
                    atr: currentAtr
                };
                positions.set(symbol, newPos);

                logTrade(symbol, 'BUY', 'ENTRY', executionPrice, positionSize, fee, 0, 0, timestamp, 'LONG', 'LIVE_FORWARD');
                upsertActivePosStmt.run(
                    symbol,
                    'LONG',
                    positionSize,
                    executionPrice,
                    executionPrice,
                    executionPrice,
                    executionPrice,
                    initialTrailingStop,
                    currentAtr,
                    0,
                    0,
                    timestamp,
                    timestamp,
                    'BYBIT'
                );
                persistState();

                notifyOrderEntered({
                    symbol,
                    entryPrice: executionPrice,
                    amount: positionSize,
                    initialStop: initialTrailingStop,
                    atr: currentAtr,
                    timestamp,
                    direction: 'LONG'
                }).catch(err => console.error("Discord alert error:", err));

                console.log(`${C.BLUE}   💰 Position opened:${C.RESET} Size: ${positionSize.toFixed(4)} | Safety stop at: $${initialTrailingStop.toFixed(2)} | Remaining balance: $${capital.toFixed(2)}`);
            }
            // B. SHORT ENTRY: 20 EMA < 50 EMA AND RSI 35-60 AND ADX > 25
            else if (shortEmaCross && shortRsiPassed && adxPassed) {
                console.log(`\n${C.MAGENTA}${C.BOLD}🔴 SHORTING ${symbol}${C.RESET} — All 3 conditions met:`);
                console.log(`   ✅ Market trending strongly (ADX ${currentAdx.toFixed(0)} > 25)`);
                console.log(`   ✅ Momentum is safe to short (RSI ${currentRsi.toFixed(0)} in 35-60 range)`);
                console.log(`   ✅ Downtrend just started (fast average crossed below slow average)`);
                
                const executionPrice = close * (1 - SLIPPAGE);
                const stopDistance = ATR_MULTIPLIER * currentAtr;
                const initialTrailingStop = executionPrice + stopDistance; // Stop placed above for short

                // Position sizing: Risk strictly 2% of portfolio per position
                const riskAmount = capital * MAX_RISK_PCT;
                const maxPositionSize = stopDistance > 0 ? riskAmount / stopDistance : 0;
                const maxAffordableSize = (capital * (1 - TAKER_FEE)) / executionPrice;
                const positionSize = Math.min(maxPositionSize, maxAffordableSize);

                if (positionSize <= 0) {
                    console.log(`${C.RED}⚠️  Cannot short ${symbol}${C.RESET} — calculated position size is too small`);
                    return;
                }

                // Critical: Verify sufficient capital before entry
                const totalMargin = (positionSize * executionPrice) + (positionSize * executionPrice * TAKER_FEE);
                if (totalMargin > capital) {
                    console.log(`${C.RED}⚠️  Cannot short ${symbol}${C.RESET} — not enough capital ($${capital.toFixed(2)} available, $${totalMargin.toFixed(2)} needed)`);
                    return;
                }

                const margin = positionSize * executionPrice;
                const fee = margin * TAKER_FEE;

                capital -= (margin + fee);
                const newPos: Position = {
                    symbol,
                    side: 'SHORT',
                    amount: positionSize,
                    entryPrice: executionPrice,
                    highestPrice: executionPrice,
                    lowestPrice: executionPrice,
                    trailingStop: initialTrailingStop,
                    entryTime: timestamp,
                    atr: currentAtr
                };
                positions.set(symbol, newPos);

                logTrade(symbol, 'SELL', 'ENTRY', executionPrice, positionSize, fee, 0, 0, timestamp, 'SHORT', 'LIVE_FORWARD');
                upsertActivePosStmt.run(
                    symbol,
                    'SHORT',
                    positionSize,
                    executionPrice,
                    executionPrice,
                    executionPrice,
                    executionPrice,
                    initialTrailingStop,
                    currentAtr,
                    0,
                    0,
                    timestamp,
                    timestamp,
                    'BYBIT'
                );
                persistState();

                notifyOrderEntered({
                    symbol,
                    entryPrice: executionPrice,
                    amount: positionSize,
                    initialStop: initialTrailingStop,
                    atr: currentAtr,
                    timestamp,
                    direction: 'SHORT'
                }).catch(err => console.error("Discord alert error:", err));

                console.log(`${C.MAGENTA}   💰 Short position opened:${C.RESET} Size: ${positionSize.toFixed(4)} | Safety stop at: $${initialTrailingStop.toFixed(2)} | Remaining balance: $${capital.toFixed(2)}`);
            }
        }
    }
}

/**
 * Runs a single dry run verifying live CCXT data fetching, indicator calculation, and execution checks.
 */
export async function runDryRun() {
    console.log(`\n========================================================================================`);
    console.log(` [DRY RUN VERIFICATION] REAL-TIME BIDIRECTIONAL PERPETUAL ENGINE`);
    console.log(` Monitored Pairs: ${monitoredSymbols.join(', ')}`);
    console.log(`========================================================================================`);
    const bybitHostname = (process.env.BYBIT_HOSTNAME || 'bytick.com').replace(/^api\./, '');
    const exchange = new ccxt.bybit({ hostname: bybitHostname, options: { defaultType: 'future' }, timeout: 30000, enableRateLimit: true });

    await seedHistoryIfNeeded(exchange);

    for (const symbol of monitoredSymbols) {
        console.log(`\n>>> Fetching live Bybit candles for ${symbol}...`);
        try {
            const marketSymbol = toExchangeSymbol(symbol);
            const ohlcv = await fetchOHLCVWithRetry(exchange, marketSymbol, TIMEFRAME, undefined, 5);
            if (!ohlcv || ohlcv.length < 2) {
                console.error(`Insufficient candles received from exchange for ${symbol}`);
                continue;
            }

            const closedCandle = ohlcv[ohlcv.length - 2] as [number, number, number, number, number, number];
            const currentCandle = ohlcv[ohlcv.length - 1] as [number, number, number, number, number, number];

            console.log(`[Closed 1h Candle] ${new Date(closedCandle[0]).toISOString()} | Open: $${closedCandle[1]} High: $${closedCandle[2]} Low: $${closedCandle[3]} Close: $${closedCandle[4]}`);
            await processTick(symbol, TIMEFRAME, closedCandle, true);

            console.log(`[Current Candle] ${new Date(currentCandle[0]).toISOString()} | Open: $${currentCandle[1]} High: $${currentCandle[2]} Low: $${currentCandle[3]} Close: $${currentCandle[4]}`);
            await processTick(symbol, TIMEFRAME, currentCandle, false);
        } catch (err) {
            console.error(`Error during dry run for ${symbol}:`, err);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    console.log(`\n========================================================================================`);
    console.log(` [DRY RUN SUCCESS] Bidirectional filters and trailing stops computed cleanly!`);
    console.log(` Capital: $${capital.toFixed(2)} | Active Monitored Positions: ${positions.size}`);
    console.log(`========================================================================================\n`);
}

/**
 * Live execution stream listener polling all pairs concurrently.
 * Schedules 24-hour screener update.
 */
export async function startLive() {
    const bybitHostname = (process.env.BYBIT_HOSTNAME || 'bytick.com').replace(/^api\./, '');
    const exchange = new ccxt.bybit({ hostname: bybitHostname, options: { defaultType: 'future' }, timeout: 30000, enableRateLimit: true });
    const lastTimestamps: Record<string, number> = {};

    console.log(`\n${C.CYAN}${C.BOLD}╔══════════════════════════════════════════════════════════════════════════╗${C.RESET}`);
    console.log(`${C.CYAN}${C.BOLD}║              🤖  PAPER TRADING BOT — NOW RUNNING                       ║${C.RESET}`);
    console.log(`${C.CYAN}${C.BOLD}╚══════════════════════════════════════════════════════════════════════════╝${C.RESET}`);
    console.log(``);
    console.log(`   ${C.BOLD}📌 What this does:${C.RESET}`);
    console.log(`      Watches crypto prices on Bybit and makes practice trades`);
    console.log(`      using simulated money. No real funds are at risk.`);
    console.log(``);
    console.log(`   ${C.BOLD}👀 Currently watching:${C.RESET} ${monitoredSymbols.join(', ')} (updates every 24h)`);
    console.log(`   ${C.BOLD}⏱️  Checks prices:${C.RESET} Every 10 seconds`);
    console.log(``);
    console.log(`   ${C.BOLD}📈 Buy signal:${C.RESET} When short-term trend crosses above long-term + market is trending + momentum is healthy`);
    console.log(`   ${C.BOLD}📉 Sell signal:${C.RESET} When short-term trend crosses below long-term (same filters)`);
    console.log(``);
    console.log(`   ${C.BOLD}🛡️  Safety features:${C.RESET}`);
    console.log(`      • Max 2% of balance risked per trade`);
    console.log(`      • Auto-exit if price drops past the trailing safety stop`);
    console.log(`      • Emergency pause if daily losses exceed 5%`);
    console.log(``);
    console.log(`   ${C.DIM}Starting balance: $${capital.toFixed(2)} USDT${C.RESET}`);
    console.log(`${'─'.repeat(74)}\n`);

    // Start 24-hour automated screener background schedule and run initial scan
    const screener = new DynamicAssetScreener();
    screener.runScreening().catch(err => console.error("Initial screening error:", err));
    screener.schedule24Hours();

    // Pre-seed any uninitialized symbols
    await seedHistoryIfNeeded(exchange);

    while (true) {
        try {
            // Re-sync monitored pairs dynamically
            const activePairs = getMonitoredPairs();
            if (activePairs && activePairs.length > 0) {
                monitoredSymbols = activePairs;
            }

            // Sequential processing loop: fetch one pair at a time with 200ms delay
            for (const symbol of monitoredSymbols) {
                try {
                    const marketSymbol = toExchangeSymbol(symbol);
                    const ohlcv = await fetchOHLCVWithRetry(exchange, marketSymbol, TIMEFRAME, undefined, 3);
                    if (ohlcv && ohlcv.length >= 2) {
                        const closedCandle = ohlcv[ohlcv.length - 2] as [number, number, number, number, number, number];
                        const currentCandle = ohlcv[ohlcv.length - 1] as [number, number, number, number, number, number];

                        if (closedCandle && (!lastTimestamps[symbol] || closedCandle[0] > lastTimestamps[symbol])) {
                            console.log(`\n${C.CYAN}🕐 New hourly candle closed${C.RESET} ${symbol} at ${new Date(closedCandle[0]).toLocaleTimeString()}`);
                            await processTick(symbol, TIMEFRAME, closedCandle, true);
                            lastTimestamps[symbol] = closedCandle[0];
                        }

                        // Process current incomplete candle for real-time intrabar trailing stop ratcheting / trigger
                        await processTick(symbol, TIMEFRAME, currentCandle, false);
                    }
                } catch (err: any) {
                    console.error(`Error processing live data for ${symbol}:`, err?.message || err);
                }

                // Guarantee burst limits are respected with manual 200ms delay between pair requests
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
        } catch (e) {
            console.error("Error fetching live data:", e);
        }
        maybePrintSummary();
        await new Promise(r => setTimeout(r, 10000)); // Poll every 10s
    }
}

if (require.main === module) {
    if (process.argv.includes('--dry-run')) {
        runDryRun().catch(console.error);
    } else {
        startLive().catch(console.error);
    }
}
