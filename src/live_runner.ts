import ccxt from 'ccxt';
import path from 'path';
import fs from 'fs';
import { db, updateHeartbeat, getSystemState, setSystemStatus, clearPendingCommand, logActivity, marketClosePositions, closeDb, upsertMonitoredMarketState } from './db';
import config, { DEFAULT_CORE_PAIRS, DEFAULT_SATELLITE_PAIRS, getSlippageForSymbol } from './config';
import { createLogger } from './utils/logger';
import { StrategyEngine, RiskManager, CandleData, SetupType } from './strategy/core';
import { StrategyLearner, SetupProximity } from './strategy/learner';
import { notifyOrderEntered, notifyPositionClosed, notifyCircuitBreaker } from './services/notifier';
import { DynamicAssetScreener, getMonitoredPairs } from './screener';

const log = createLogger('bybit-runner');

// ANSI Colors for terminal status logging
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

export { db };

// Prepared statements with composite primary key (symbol, broker)
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
    INSERT INTO paper_trades (
        order_id, symbol, side, type, price, amount, fee, pnl, pnl_percent, timestamp, direction, execution_mode, broker, setup_type, signal_price, fill_price, slippage, funding_pnl
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertActivePosStmt = db.prepare(`
    INSERT INTO active_positions (symbol, broker, side, amount, entry_price, current_price, highest_price, lowest_price, trailing_stop, atr, pnl, pnl_percent, entry_time, updated_at, setup_type, signal_price, accumulated_funding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, broker) DO UPDATE SET
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
        setup_type = excluded.setup_type,
        signal_price = excluded.signal_price,
        accumulated_funding = excluded.accumulated_funding;
`);

const deleteActivePosStmt = db.prepare(`
    DELETE FROM active_positions WHERE symbol = ? AND broker = 'BYBIT'
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

// Strategy & Risk Configuration from core config
export const INITIAL_CAPITAL = config.exchange.initialCapital;
export const ATR_MULTIPLIER = config.strategy.atrMultiplier;
export const MAX_RISK_PCT = config.risk.maxRiskPct;
export const TAKER_FEE = config.exchange.takerFee;
export const SLIPPAGE = config.exchange.slippage;
export const TIMEFRAME = config.exchange.timeframe;

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
    setupType: SetupType;
    takeProfitPrice?: number;
    signalPrice?: number;
    slippageRate?: number;
    accumulatedFunding?: number;
    lastFundingTime?: number;
}

// In-memory state tracking
let capital = INITIAL_CAPITAL;
const positions: Map<string, Position> = new Map();
const lastTradeClosedTime: Record<string, number> = {};
let dailyLosses: { timestamp: number, amount: number }[] = [];
let lockoutUntil = 0;
let lastTradeTime = 0;
let closestSetup: SetupProximity | undefined = undefined;
let monitoredSymbols: string[] = [...DEFAULT_CORE_PAIRS, ...DEFAULT_SATELLITE_PAIRS];

// Restore capital, losses, and active positions from SQLite
(() => {
    try {
        const state = db.prepare('SELECT capital, circuit_breaker_halted, lockout_until FROM bot_state WHERE id = 1').get() as any;
        if (state) {
            // Recalculate true Realized Capital: Initial Capital + Total Closed Trade PnL - Entry Fees
            const closedTradesRow = db.prepare("SELECT COALESCE(SUM(pnl), 0) as totalPnl FROM paper_trades WHERE type != 'ENTRY'").get() as any;
            const entryFeesRow = db.prepare("SELECT COALESCE(SUM(fee), 0) as totalFees FROM paper_trades WHERE type = 'ENTRY'").get() as any;
            const realizedPnl = Number(closedTradesRow?.totalPnl || 0);
            const entryFees = Number(entryFeesRow?.totalFees || 0);
            capital = INITIAL_CAPITAL + realizedPnl - entryFees;
            lockoutUntil = Number(state.lockout_until || 0);
        } else {
            capital = INITIAL_CAPITAL;
            updateBotStateStmt.run(INITIAL_CAPITAL, INITIAL_CAPITAL, 0, 0, Date.now());
        }

        const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
        cleanOldLossesStmt.run(twentyFourHoursAgo);
        dailyLosses = db.prepare('SELECT timestamp, amount FROM daily_losses ORDER BY timestamp ASC').all() as { timestamp: number, amount: number }[];

        const savedPositions = db.prepare("SELECT * FROM active_positions WHERE broker = 'BYBIT'").all() as any[];
        for (const p of savedPositions) {
            const entryPrice = Number(p.entry_price);
            const highestPrice = Number(p.highest_price) > 0 ? Number(p.highest_price) : entryPrice;
            const lowestPrice = (Number(p.lowest_price) > 0) ? Number(p.lowest_price) : entryPrice;
            const defaultStop = p.side === 'SHORT' ? entryPrice * 1.05 : entryPrice * 0.95;
            const trailingStop = Number(p.trailing_stop) > 0 ? Number(p.trailing_stop) : defaultStop;

            positions.set(p.symbol, {
                symbol: p.symbol,
                side: p.side === 'SHORT' ? 'SHORT' : 'LONG',
                amount: Number(p.amount),
                entryPrice,
                highestPrice,
                lowestPrice,
                trailingStop,
                entryTime: Number(p.entry_time),
                atr: Number(p.atr),
                setupType: p.setup_type || 'EMA_CROSSOVER',
                signalPrice: p.signal_price ? Number(p.signal_price) : entryPrice,
                slippageRate: getSlippageForSymbol(p.symbol),
                accumulatedFunding: Number(p.accumulated_funding || 0),
                lastFundingTime: Number(p.entry_time)
            });
        }

        const lastTradeRow = db.prepare('SELECT timestamp FROM paper_trades ORDER BY timestamp DESC LIMIT 1').get() as { timestamp: number } | undefined;
        if (lastTradeRow) {
            lastTradeTime = lastTradeRow.timestamp;
        }

        const pairs = getMonitoredPairs();
        if (pairs && pairs.length > 0) {
            monitoredSymbols = pairs;
        }
    } catch (err) {
        log.warn({ err }, 'Error initializing bot state from database');
    }
})();

export function persistState() {
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

function recordDailyLoss(timestamp: number, amount: number) {
    dailyLosses.push({ timestamp, amount });
    RiskManager.recordDailyLoss(db, timestamp, amount);
}

export function getEffectiveMaxDrawdownPct(): number {
    try {
        const row = db.prepare('SELECT circuit_breaker_limit FROM bot_state WHERE id = 1').get() as any;
        if (row && typeof row.circuit_breaker_limit === 'number' && row.circuit_breaker_limit > 0) {
            return row.circuit_breaker_limit;
        }
    } catch {}
    return config.risk.maxDrawdownPct;
}

function checkCircuitBreaker(timestamp: number): boolean {
    const effectiveLimit = getEffectiveMaxDrawdownPct();
    const status = RiskManager.checkCircuitBreaker(db, capital, timestamp, lockoutUntil, {
        maxDrawdownPct: effectiveLimit,
        lockoutMs: config.risk.lockoutMs,
    });

    if (status.isHalted) {
        if (status.lockoutUntil !== lockoutUntil && status.lockoutUntil > Date.now()) {
            lockoutUntil = status.lockoutUntil;
            persistState();
            notifyCircuitBreaker({
                totalLoss: status.totalLoss24h,
                capital,
                lockoutUntil,
                timestamp
            }).catch(err => log.error({ err }, 'Discord alert error'));
        }
        return true;
    }

    return false;
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
    broker: string = 'BYBIT',
    setupType: SetupType = 'EMA_CROSSOVER',
    signalPrice?: number,
    fillPrice?: number,
    slippage?: number,
    fundingPnl: number = 0
) {
    const orderId = generateOrderId();
    const actualSignalPrice = signalPrice ?? price;
    const actualFillPrice = fillPrice ?? price;
    const actualSlippage = slippage ?? getSlippageForSymbol(symbol);
    insertTradeStmt.run(
        orderId, symbol, side, type, price, amount, fee, pnl, pnlPercent,
        timestamp, direction, executionMode, broker, setupType,
        actualSignalPrice, actualFillPrice, actualSlippage, fundingPnl
    );
    const color = direction === 'LONG' ? C.GREEN : C.MAGENTA;
    const dirEmoji = direction === 'LONG' ? '🟢' : '🔴';
    const actionVerb = side === 'BUY' ? 'Bought' : 'Sold';
    const pnlStr = pnl !== 0 ? ` | Result: ${pnl > 0 ? '✅ Profit' : '❌ Loss'} $${Math.abs(pnl).toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)` : '';
    const slipStr = actualSlippage > 0 ? ` | Slip: ${(actualSlippage * 100).toFixed(3)}%` : '';
    const fundingStr = fundingPnl !== 0 ? ` | Funding: $${fundingPnl.toFixed(2)}` : '';
    console.log(`${color}${dirEmoji} ${actionVerb} ${symbol}${C.RESET} @ $${price.toFixed(2)} | Size: ${amount.toFixed(4)} | Fee: $${fee.toFixed(2)}${pnlStr}${slipStr}${fundingStr} | Setup: ${setupType} | Broker: ${broker}`);
}

// Periodic summary tracking
let lastSummaryTime = Date.now();
const SUMMARY_INTERVAL = 5 * 60 * 1000; // 5 minutes

function maybePrintSummary() {
    const now = Date.now();
    if (now - lastSummaryTime >= SUMMARY_INTERVAL) {
        lastSummaryTime = now;
        let totalUnrealized = 0;
        let totalNotional = 0;
        for (const p of positions.values()) {
            const posRow = db.prepare("SELECT current_price FROM active_positions WHERE symbol = ? AND broker = 'BYBIT'").get(p.symbol) as { current_price: number } | undefined;
            const curPrice = posRow ? posRow.current_price : p.entryPrice;
            const notional = p.amount * curPrice;
            totalNotional += notional;
            const pnlCalc = StrategyEngine.calculatePnL(p.side, p.amount, p.entryPrice, curPrice, {
                slippage: getSlippageForSymbol(p.symbol),
                takerFee: TAKER_FEE,
                accumulatedFunding: p.accumulatedFunding ?? 0
            });
            totalUnrealized += pnlCalc.unrealizedPnl;
        }

        const marginUsed = totalNotional / 10;
        const availableBuyingPower = Math.max(0, capital - marginUsed);
        const totalEquity = capital + totalUnrealized;
        const pnlPct = ((totalEquity - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100);
        const pnlSign = pnlPct >= 0 ? '+' : '';
        const unrealizedSign = totalUnrealized >= 0 ? '+' : '';
        console.log(`\n${C.CYAN}${C.BOLD}⏰ 5-MIN STATUS UPDATE${C.RESET}`);
        console.log(`${C.CYAN}───────────────────────────────────────────────────${C.RESET}`);
        console.log(`   💰 Total Equity: $${totalEquity.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%) | Buying Power: $${availableBuyingPower.toFixed(2)}`);
        console.log(`   📊 Watching: ${monitoredSymbols.length} coins (${monitoredSymbols.join(', ')})`);
        console.log(`   📂 Open Trades: ${positions.size}/${config.watchlist.maxConcurrentPositions} (Margin: $${marginUsed.toFixed(2)}) | Unrealized: ${unrealizedSign}$${Math.abs(totalUnrealized).toFixed(2)}`);
        if (positions.size > 0) {
            for (const [sym, pos] of positions) {
                const dirEmoji = pos.side === 'LONG' ? '🟢' : '🔴';
                console.log(`       ${dirEmoji} ${sym} (${pos.side}) — Entry: $${pos.entryPrice.toFixed(2)} | Stop: $${pos.trailingStop.toFixed(2)}`);
            }
        }
        const isLocked = Date.now() < lockoutUntil;
        console.log(`   🛡️  Safety: ${isLocked ? '⛔ HALTED (circuit breaker active)' : '✅ Normal — all systems go'}`);
        const { learnerLine, setupLine } = StrategyLearner.getStatusLines(db, positions.size, lastTradeTime, closestSetup);
        console.log(learnerLine);
        console.log(setupLine);
        console.log(`${C.CYAN}───────────────────────────────────────────────────${C.RESET}\n`);
    }
}

/**
 * Normalizes symbol to Bybit's canonical CCXT linear perpetual futures symbol.
 */
export function toExchangeSymbol(symbol: string): string {
    if (symbol.includes(':')) return symbol;
    if (symbol.endsWith('/USDT')) return `${symbol}:USDT`;
    return symbol;
}

/**
 * Singleton Bybit CCXT instance
 */
let singletonBybitExchange: any = null;
export function getBybitExchange(): any {
    if (!singletonBybitExchange) {
        singletonBybitExchange = new ccxt.bybit({
            hostname: config.exchange.bybitHostname,
            options: { defaultType: 'future' },
            timeout: 30000,
            enableRateLimit: true
        });
    }
    return singletonBybitExchange;
}

/**
 * Detects CCXT BadSymbol or ExchangeError indicating unsupported/invalid market symbol.
 */
export function isBadSymbolError(err: any): boolean {
    if (!err) return false;
    if (err instanceof ccxt.BadSymbol || err?.name === 'BadSymbol') return true;
    const msg = String(err?.message || err).toLowerCase();
    return (
        msg.includes('does not have market symbol') ||
        msg.includes('symbol invalid') ||
        msg.includes('symbol not supported') ||
        msg.includes('unknown symbol')
    );
}

/**
 * Detects network connectivity drops, DNS failures (EAI_AGAIN / ENOTFOUND), timeouts, or ccxt.NetworkError.
 */
export function isNetworkError(err: any): boolean {
    if (!err) return false;
    if (err instanceof ccxt.NetworkError || err?.name === 'NetworkError' || (err?.constructor && err.constructor.prototype instanceof ccxt.NetworkError)) {
        return true;
    }
    const code = err?.code || err?.cause?.code;
    if (code && ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
        return true;
    }
    const msg = (err?.message || '') + ' ' + (err?.cause?.message || '') + ' ' + String(err);
    return (
        msg.includes('EAI_AGAIN') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('fetch failed') ||
        msg.includes('getaddrinfo') ||
        msg.toLowerCase().includes('network offline') ||
        msg.toLowerCase().includes('network error')
    );
}

/**
 * Dynamically removes an invalid symbol from active memory, SQLite monitored_pairs, and JSON fallback.
 */
export function removeInvalidSymbol(symbol: string, reason: string) {
    log.error({ symbol, reason }, `Removing invalid symbol from watchlist: ${symbol}`);
    const normalized = symbol.replace(':USDT', '');
    monitoredSymbols = monitoredSymbols.filter(s => s !== symbol && s !== normalized && s !== `${normalized}:USDT`);
    try {
        db.prepare('DELETE FROM monitored_pairs WHERE symbol = ? OR symbol = ?').run(symbol, `${normalized}:USDT`);
    } catch (e) {
        // ignore
    }
    try {
        const jsonPath = path.resolve(process.cwd(), 'data/monitored_pairs.json');
        if (fs.existsSync(jsonPath)) {
            const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            if (Array.isArray(data)) {
                const filtered = data.filter((item: any) => item.symbol !== symbol && item.normalizedSymbol !== normalized && item.symbol !== `${normalized}:USDT`);
                fs.writeFileSync(jsonPath, JSON.stringify(filtered, null, 2));
            }
        }
    } catch (e) {
        // ignore
    }
}

/**
 * Safely fetches OHLCV data with retry and exponential backoff for RateLimitExceeded.
 */
export async function fetchOHLCVWithRetry(
    exchange: any,
    symbol: string,
    timeframe: string,
    since: number | undefined,
    limit: number,
    maxRetries: number = 3
): Promise<any[]> {
    let delay = 5000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await exchange.fetchOHLCV(symbol, timeframe, since, limit);
        } catch (err: any) {
            if (isBadSymbolError(err)) {
                throw err;
            }
            if (isNetworkError(err)) {
                if (attempt < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                    continue;
                }
                throw err;
            }
            const isRateLimit =
                err instanceof ccxt.RateLimitExceeded ||
                err?.name === 'RateLimitExceeded' ||
                (err?.message && (err.message.includes('10006') || err.message.toLowerCase().includes('rate limit')));

            if (isRateLimit && attempt < maxRetries) {
                log.warn({ symbol, attempt, maxRetries, delaySeconds: delay / 1000 }, 'Bybit rate limit exceeded. Backing off before retry...');
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2;
            } else {
                throw err;
            }
        }
    }
    return [];
}

/**
 * Ensures sufficient historical candles in SQLite for a symbol on the active timeframe.
 * If candle count < 100, immediately fetches 200 historical candles from Bybit before evaluating.
 */
export async function ensureCandleHistory(
    exchange: any,
    symbol: string,
    timeframe: string = TIMEFRAME,
    minCount: number = 100
): Promise<boolean> {
    try {
        const countRow = db.prepare('SELECT count(*) as c FROM candles WHERE symbol = ? AND timeframe = ?').get(symbol, timeframe) as { c: number } | undefined;
        const currentCount = countRow ? countRow.c : 0;
        if (currentCount < minCount) {
            log.info({ symbol, currentCount, target: 200, timeframe }, `Candle count (${currentCount}) < ${minCount}. Seeding 200 historical candles from Bybit...`);
            const marketSymbol = toExchangeSymbol(symbol);
            const ohlcv = await fetchOHLCVWithRetry(exchange, marketSymbol, timeframe, undefined, 200);
            if (ohlcv && ohlcv.length > 0) {
                const insertMany = db.transaction((candlesArr: any[]) => {
                    for (const c of candlesArr) {
                        upsertCandleStmt.run(symbol, timeframe, c[0], c[1], c[2], c[3], c[4], c[5]);
                    }
                });
                insertMany(ohlcv);
                log.info({ symbol, count: ohlcv.length, timeframe }, 'Successfully seeded historical candles');
                return true;
            }
        }
        return true;
    } catch (err: any) {
        if (isBadSymbolError(err)) {
            removeInvalidSymbol(symbol, err?.message || 'Invalid symbol on exchange');
            return false;
        }
        if (isNetworkError(err)) {
            throw err;
        }
        log.error({ err, symbol, timeframe }, 'Error ensuring candle history');
        return false;
    }
}

/**
 * Seeds historical candles via CCXT if symbol history is insufficient (< 100 bars).
 */
export async function seedHistoryIfNeeded(exchange: any) {
    try {
        for (const symbol of [...monitoredSymbols]) {
            try {
                await ensureCandleHistory(exchange, symbol, TIMEFRAME, 100);
            } catch (err: any) {
                if (isBadSymbolError(err)) {
                    removeInvalidSymbol(symbol, err?.message || 'Invalid symbol on exchange');
                } else if (isNetworkError(err)) {
                    throw err;
                }
            }
        }
    } catch (err: any) {
        if (isNetworkError(err)) {
            console.log(`\x1b[33m[NETWORK]\x1b[0m Network offline: Retrying in 10s...`);
            await new Promise(r => setTimeout(r, 10000));
        } else {
            log.error({ err }, 'Error during seedHistoryIfNeeded');
        }
    }
}

/**
 * Evaluates market tick for a single pair using centralized StrategyEngine and RiskManager.
 */
export async function processTick(
    symbol: string,
    timeframe: string,
    candle: [number, number, number, number, number, number],
    isClosed: boolean,
    isPaused: boolean = false
) {
    const [timestamp, open, high, low, close, volume] = candle;
    upsertCandleStmt.run(symbol, timeframe, timestamp, open, high, low, close, volume);

    const isHalted = checkCircuitBreaker(timestamp);

    const rows = db.prepare(`
        SELECT timestamp, open, high, low, close, volume
        FROM candles
        WHERE symbol = ? AND timeframe = ?
        ORDER BY timestamp DESC
        LIMIT 100
    `).all(symbol, timeframe) as CandleData[];

    if (rows.length < 50) {
        log.warn(
            { symbol, count: rows.length, timeframe },
            `⚠️ Skipping analysis line: Insufficient candle history in database (${rows.length} < 50 required for indicators)`
        );
        return;
    }
    const history = rows.reverse();

    const snapshot = StrategyEngine.getLatestSnapshot(history);
    if (!snapshot) return;

    const currentCandleObj: CandleData = { timestamp, open, high, low, close, volume };

    // Evaluate entry setups and proximity reasoning with Cold-Start Exploration status
    const isExplore = StrategyLearner.getLearnerMode(positions.size, lastTradeTime) === 'EXPLORE';
    const allowIntrabar = config.app.allowIntrabarSignals;
    const signalEval = StrategyEngine.evaluateEntry(history, undefined, {
        isClosed,
        allowShorts: true,
        allowIntrabar,
        isExploreMode: isExplore
    });

    // Track closest setup and near-miss counterfactual shadow trades
    if (signalEval.nearMiss) {
        if (!closestSetup || signalEval.nearMiss.readinessPct >= closestSetup.readinessPct) {
            closestSetup = {
                symbol,
                playbook: signalEval.nearMiss.playbook,
                readinessPct: signalEval.nearMiss.readinessPct,
                statusText: signalEval.nearMiss.message,
            };
        }
        if (isClosed) {
            StrategyLearner.recordShadowTrade(db, {
                symbol,
                playbook: signalEval.nearMiss.playbook,
                direction: signalEval.nearMiss.direction,
                rejected_filter: signalEval.nearMiss.rejectedFilter,
                filter_value: signalEval.nearMiss.filterValue,
                filter_threshold: signalEval.nearMiss.filterThreshold,
                entry_price: signalEval.nearMiss.entryPrice,
                atr: signalEval.nearMiss.atr,
                timestamp,
            });
        }
    }

    // Upsert live monitored market state for dashboard display
    const change24h = history.length > 0 && history[0].close > 0
        ? ((close - history[0].close) / history[0].close) * 100
        : 0;

    const isCore = config.watchlist.pinnedCorePairs.includes(symbol);
    const tier = isCore ? 'CORE' : 'SATELLITE';

    upsertMonitoredMarketState({
        symbol,
        price: close,
        change_24h: change24h,
        ema20: snapshot.currentEmaFast,
        ema50: snapshot.currentEmaSlow,
        rsi14: snapshot.currentRsi,
        adx14: snapshot.currentAdx,
        signal_proximity: signalEval.signalProximity || 'Evaluating market condition',
        updated_at: timestamp,
        tier
    });

    // 1. POSITION MANAGEMENT & DYNAMIC TRAILING STOP
    if (positions.has(symbol)) {
        const pos = positions.get(symbol)!;

        // Accrue funding payments every fundingIntervalHours (default 8h)
        const fundingIntervalMs = (config.exchange.fundingIntervalHours || 8) * 3600 * 1000;
        const defaultFundingRate = config.exchange.defaultFundingRate || 0.0001;
        if (!pos.lastFundingTime) pos.lastFundingTime = pos.entryTime;
        if (pos.accumulatedFunding === undefined) pos.accumulatedFunding = 0;
        const elapsedFundingPeriods = Math.floor((timestamp - pos.lastFundingTime) / fundingIntervalMs);
        if (elapsedFundingPeriods > 0) {
            const notional = pos.amount * close;
            const periodFunding = elapsedFundingPeriods * notional * defaultFundingRate;
            const fundingDelta = pos.side === 'LONG' ? -periodFunding : periodFunding;
            pos.accumulatedFunding += fundingDelta;
            pos.lastFundingTime += elapsedFundingPeriods * fundingIntervalMs;
        }

        const pairSlippage = getSlippageForSymbol(symbol);

        // Intrabar stop guardrail: if intrabar stops disabled and bar is not closed, skip exit evaluation
        const allowStopEvaluation = isClosed || config.app.allowIntrabarStops;
        if (!allowStopEvaluation) {
            return null;
        }

        const exitEval = StrategyEngine.evaluateExit(
            {
                symbol: pos.symbol,
                side: pos.side,
                amount: pos.amount,
                entryPrice: pos.entryPrice,
                currentPrice: close,
                highestPrice: pos.highestPrice,
                lowestPrice: pos.lowestPrice,
                trailingStop: pos.trailingStop,
                atr: pos.atr,
                entryTime: pos.entryTime,
                takeProfitPrice: pos.takeProfitPrice,
                setupType: pos.setupType,
            },
            currentCandleObj,
            snapshot,
            isClosed,
            { atrMultiplier: (pos.setupType === 'EXTREME_RSI_REVERSAL' ? 1.2 : ATR_MULTIPLIER), slippage: pairSlippage }
        );

        pos.trailingStop = exitEval.newTrailingStop;
        pos.highestPrice = exitEval.newHighestPrice;
        pos.lowestPrice = exitEval.newLowestPrice;

        const pnlCalc = StrategyEngine.calculatePnL(pos.side, pos.amount, pos.entryPrice, close, {
            slippage: pairSlippage,
            takerFee: TAKER_FEE,
            accumulatedFunding: pos.accumulatedFunding
        });

        upsertActivePosStmt.run(
            pos.symbol,
            'BYBIT',
            pos.side,
            pos.amount,
            pos.entryPrice,
            close,
            pos.highestPrice,
            pos.lowestPrice,
            pos.trailingStop,
            pos.atr,
            pnlCalc.unrealizedPnl,
            pnlCalc.unrealizedPnlPercent,
            pos.entryTime,
            timestamp,
            pos.setupType || 'EMA_CROSSOVER',
            pos.signalPrice ?? pos.entryPrice,
            pos.accumulatedFunding ?? 0
        );

        if (exitEval.shouldExit && exitEval.reason) {
            const rawSignalPrice = exitEval.reason === 'EMA_CROSS'
                ? close
                : (exitEval.reason === 'TAKE_PROFIT' ? pos.takeProfitPrice! : exitEval.newTrailingStop);
            const executionPrice = exitEval.executionPrice;
            const realized = StrategyEngine.calculatePnL(
                pos.side,
                pos.amount,
                pos.entryPrice,
                executionPrice,
                { slippage: 0, takerFee: TAKER_FEE, accumulatedFunding: pos.accumulatedFunding }
            );

            if (realized.netRealizedPnl < 0) {
                recordDailyLoss(timestamp, Math.abs(realized.netRealizedPnl));
            }

            // Realized PnL directly updates capital balance
            capital += realized.netRealizedPnl;

            logTrade(
                symbol,
                pos.side === 'LONG' ? 'SELL' : 'BUY',
                exitEval.reason,
                executionPrice,
                pos.amount,
                realized.fee,
                realized.netRealizedPnl,
                realized.netRealizedPnlPercent,
                timestamp,
                pos.side,
                'LIVE_FORWARD',
                'BYBIT',
                pos.setupType || 'EMA_CROSSOVER',
                rawSignalPrice,
                executionPrice,
                pairSlippage,
                pos.accumulatedFunding ?? 0
            );

            lastTradeClosedTime[symbol] = timestamp;
            lastTradeTime = timestamp;

            // Recalculate rolling Win Rate and Expectancy for this setup_type and adapt risk
            try {
                const closedTrade = {
                    setupType: pos.setupType || 'EMA_CROSSOVER',
                    symbol: pos.symbol,
                    pnl: realized.netRealizedPnl,
                    pnlPercent: realized.netRealizedPnlPercent,
                    entryPrice: pos.entryPrice,
                    exitPrice: executionPrice,
                    amount: pos.amount,
                    entryTime: pos.entryTime,
                    exitTime: timestamp,
                };
                const adaptation = RiskManager.recordClosedTradeAndAdapt(db, closedTrade);
                if (adaptation.adjusted) {
                    logActivity('STATE_CHANGE', adaptation.message, 'Adaptive risk scaling engine', db);
                    console.log(`${C.YELLOW}🧠 ${adaptation.message}${C.RESET}`);
                }

                // Update Persistent Multi-Armed Bandit / Expectancy Learner
                const posTier = config.watchlist.pinnedCorePairs.includes(pos.symbol) ? 'CORE' : 'SATELLITE';
                const posRegime = StrategyLearner.detectVolatilityRegime(pos.atr, executionPrice, snapshot.currentAdx);
                const rMultiple = pos.atr > 0 ? realized.netRealizedPnl / (pos.atr * pos.amount) : 0;
                StrategyLearner.recordTradeOutcome(db, {
                    playbook: pos.setupType || 'EMA_CROSSOVER',
                    symbolTier: posTier,
                    volatilityRegime: posRegime,
                    netPnl: realized.netRealizedPnl,
                    rMultiple
                });
            } catch (adaptErr) {
                log.error({ adaptErr }, 'Error recording closed trade adaptation');
            }

            positions.delete(symbol);
            deleteActivePosStmt.run(symbol);
            persistState();

            notifyPositionClosed({
                symbol,
                exitPrice: executionPrice,
                pnl: realized.netRealizedPnl,
                pnlPercent: realized.netRealizedPnlPercent,
                reason: `${exitEval.reason} (${pos.side})`,
                durationMs: timestamp - pos.entryTime,
                timestamp
            }).catch(err => log.error({ err }, 'Discord alert error'));

            checkCircuitBreaker(timestamp);
            return null;
        }
        return null;
    }

    // 2. BIDIRECTIONAL ENTRY CONDITIONS (Evaluated on Closed Candles or Intrabar when NOT paused)
    const shouldEvaluateEntry = (isClosed || allowIntrabar) && !isPaused;
    if (shouldEvaluateEntry) {
        console.log(
            `${C.DIM}📊 ${symbol}${C.RESET} $${close.toFixed(2)} | ` +
            `Market: ${signalEval.trendStatus === 'trending' ? C.GREEN + '✅ Trending' + C.RESET : C.RED + '❌ Choppy' + C.RESET} (ADX ${snapshot.currentAdx.toFixed(0)}) | ` +
            `Direction: ${signalEval.trendWord} | ` +
            `Momentum: ${signalEval.momentumWord} (RSI ${snapshot.currentRsi.toFixed(0)}) | ` +
            `Setup: ${signalEval.setupType}`
        );

        const cooldownMs = 15 * 60 * 1000; // 15 min per-symbol cooldown
        const isCooldown = lastTradeClosedTime[symbol] && (timestamp - lastTradeClosedTime[symbol] < cooldownMs);

        if (!positions.has(symbol) && !isHalted && !isCooldown && signalEval.isEntry && signalEval.direction) {
            const side = signalEval.direction;
            const isCorePair = config.watchlist.pinnedCorePairs.includes(symbol);
            const pairTier: 'CORE' | 'SATELLITE' = isCorePair ? 'CORE' : 'SATELLITE';
            const volRegime = StrategyLearner.detectVolatilityRegime(snapshot.currentAtr, close, snapshot.currentAdx);
            const banditWeight = StrategyLearner.getConfidenceWeight(db, signalEval.setupType || 'EMA_CROSSOVER', pairTier, volRegime);

            return {
                symbol,
                side,
                adx: snapshot.currentAdx,
                learnerWeight: banditWeight,
                compositeScore: snapshot.currentAdx * banditWeight,
                signalEval,
                snapshot,
                close,
                timestamp,
                pairTier,
                volRegime
            };
        }
    }
    return null;
}

/**
 * Signal candidate structure for signal quality ranking across the watchlist universe.
 */
export interface PendingSignal {
    symbol: string;
    side: 'LONG' | 'SHORT';
    adx: number;
    learnerWeight: number;
    compositeScore: number;
    signalEval: any;
    snapshot: any;
    close: number;
    timestamp: number;
    pairTier: 'CORE' | 'SATELLITE';
    volRegime: string;
}

/**
 * Executes a prioritized entry setup with leverage-based margin allocation.
 */
export async function executeEntry(sig: PendingSignal) {
    if (config.app.strategyPaused) {
        log.warn({ symbol: sig.symbol, side: sig.side }, '15m strategy execution strictly blocked: STRATEGY_PAUSED is enforced in code');
        return;
    }

    const { symbol, side, signalEval, snapshot, close, timestamp, pairTier, volRegime, learnerWeight } = sig;

    if (positions.has(symbol)) return;

    // Portfolio Heat Guard: Max Concurrent Positions
    const maxConcurrent = config.watchlist.maxConcurrentPositions;
    if (positions.size >= maxConcurrent) {
        const msg = `Signal skipped: Max concurrent positions (${maxConcurrent}) reached`;
        log.warn({ symbol, side, openPositions: positions.size, maxConcurrent }, msg);
        logActivity('ALERT', msg, `${symbol} ${side} entry prevented by portfolio heat guardrail`, db);
        return;
    }

    // Directional Correlation Guard: Max Same-Direction Positions
    const maxSameDir = config.watchlist.maxSameDirectionPositions;
    const sameDirectionCount = Array.from(positions.values()).filter(p => p.side === side).length;
    if (sameDirectionCount >= maxSameDir) {
        const msg = `Signal skipped: Max same direction positions (${maxSameDir} ${side}) reached`;
        log.warn({ symbol, side, sameDirectionCount, maxSameDir }, msg);
        logActivity('ALERT', msg, `${symbol} ${side} entry prevented by directional correlation guardrail`, db);
        return;
    }

    const signalPrice = close;
    const slippage = getSlippageForSymbol(symbol);
    const executionPrice = side === 'LONG' ? signalPrice * (1 + slippage) : signalPrice * (1 - slippage);
    const atrMult = signalEval.recommendedAtrMultiplier || ATR_MULTIPLIER;
    const stopDistance = atrMult * snapshot.currentAtr;
    const initialTrailingStop = side === 'LONG' ? executionPrice - stopDistance : executionPrice + stopDistance;

    // Available Buying Power (10x leverage margin)
    // Margin used = sum(notional / 10)
    const currentMarginUsed = Array.from(positions.values()).reduce((sum, p) => sum + ((p.amount * p.entryPrice) / 10), 0);
    const availableBuyingPower = Math.max(0, capital - currentMarginUsed);

    // Calculate Total Portfolio Open Risk Cap (6% of Total Equity)
    let totalUnrealized = 0;
    for (const p of positions.values()) {
        const pnlCalc = StrategyEngine.calculatePnL(p.side, p.amount, p.entryPrice, p.highestPrice || p.entryPrice, {
            slippage: getSlippageForSymbol(p.symbol),
            takerFee: TAKER_FEE,
            accumulatedFunding: p.accumulatedFunding ?? 0
        });
        totalUnrealized += pnlCalc.unrealizedPnl;
    }
    const totalEquity = capital + totalUnrealized;
    const currentOpenRisk = RiskManager.calculateTotalOpenRisk(positions.values());

    let baseRisk = (signalEval.recommendedRiskPct || MAX_RISK_PCT) * learnerWeight;
    baseRisk = Math.max(0.005, Math.min(0.025, baseRisk));

    const adaptiveRiskPct = RiskManager.calculateAdaptiveRiskPct(db, signalEval.setupType || 'EMA_CROSSOVER', symbol, baseRisk);
    const proposedRiskDollar = availableBuyingPower * adaptiveRiskPct;

    const riskCapCheck = RiskManager.enforceOpenRiskCap({
        currentOpenRisk,
        newPositionRisk: proposedRiskDollar,
        totalEquity,
        maxTotalOpenRiskPct: config.risk.maxTotalOpenRiskPct
    });

    if (!riskCapCheck.allowed) {
        log.warn({ symbol, side, currentOpenRisk, maxAllowed: riskCapCheck.maxAllowedRisk }, riskCapCheck.reason);
        logActivity('ALERT', riskCapCheck.reason!, `${symbol} ${side} entry prevented by 6% total open risk cap`, db);
        return;
    }

    if (riskCapCheck.wasDownsized) {
        console.log(`${C.YELLOW}⚠️  ${riskCapCheck.reason}${C.RESET}`);
        logActivity('ALERT', riskCapCheck.reason!, `${symbol} ${side} entry downsized by total open risk cap`, db);
    }

    const effectiveRiskPct = availableBuyingPower > 0 ? (riskCapCheck.effectiveRisk / availableBuyingPower) : 0;
    const sizing = RiskManager.calculatePositionSize({
        capital: availableBuyingPower,
        executionPrice,
        stopDistance,
        takerFee: TAKER_FEE,
        maxRiskPct: effectiveRiskPct,
        leverage: 10,
    });

    if (!sizing.isAffordable || sizing.positionSize <= 0) {
        log.warn({ symbol, reason: sizing.rejectionReason, availableBuyingPower }, 'Cannot open position — sizing limit exceeded');
        return;
    }

    const positionSize = sizing.positionSize;
    const notional = positionSize * executionPrice;
    const marginRequired = notional / 10;
    const fee = notional * TAKER_FEE;

    // Deduct transaction fee from realized balance (margin is tracked by open position)
    capital -= fee;

    const resolvedSetupType: SetupType = signalEval.setupType || 'EMA_CROSSOVER';
    const newPos: Position = {
        symbol,
        side,
        amount: positionSize,
        entryPrice: executionPrice,
        highestPrice: executionPrice,
        lowestPrice: executionPrice,
        trailingStop: initialTrailingStop,
        entryTime: timestamp,
        atr: snapshot.currentAtr,
        setupType: resolvedSetupType,
        takeProfitPrice: signalEval.takeProfitPrice,
        signalPrice,
        slippageRate: slippage,
        accumulatedFunding: 0,
        lastFundingTime: timestamp
    };
    positions.set(symbol, newPos);
    lastTradeTime = timestamp;

    logTrade(
        symbol,
        side === 'LONG' ? 'BUY' : 'SELL',
        'ENTRY',
        executionPrice,
        positionSize,
        fee,
        0,
        0,
        timestamp,
        side,
        'LIVE_FORWARD',
        'BYBIT',
        resolvedSetupType,
        signalPrice,
        executionPrice,
        slippage,
        0
    );

    upsertActivePosStmt.run(
        symbol,
        'BYBIT',
        side,
        positionSize,
        executionPrice,
        executionPrice,
        executionPrice,
        executionPrice,
        initialTrailingStop,
        snapshot.currentAtr,
        0,
        0,
        timestamp,
        timestamp,
        resolvedSetupType,
        signalPrice,
        0
    );

    persistState();

    notifyOrderEntered({
        symbol,
        entryPrice: executionPrice,
        amount: positionSize,
        initialStop: initialTrailingStop,
        atr: snapshot.currentAtr,
        timestamp,
        direction: side
    }).catch(err => log.error({ err }, 'Discord alert error'));

    const color = side === 'LONG' ? C.GREEN : C.MAGENTA;
    console.log(
        `${color}   💰 ${side} position opened [${resolvedSetupType}]:${C.RESET} ` +
        `Size: ${positionSize.toFixed(4)} ($${notional.toFixed(2)}) | Margin: $${marginRequired.toFixed(2)} | ` +
        `Safety stop: $${initialTrailingStop.toFixed(2)} | Risk: ${(adaptiveRiskPct * 100).toFixed(1)}% | Buying Power: $${(availableBuyingPower - marginRequired - fee).toFixed(2)}`
    );
}

/**
 * Runs a single dry run verifying live CCXT data fetching, indicator calculation, and execution checks.
 */
export async function runDryRun() {
    console.log(`\n========================================================================================`);
    console.log(` [DRY RUN VERIFICATION] REAL-TIME BIDIRECTIONAL PERPETUAL ENGINE`);
    console.log(` Monitored Pairs: ${monitoredSymbols.join(', ')}`);
    console.log(` Mode: ${config.app.executionMode}`);
    console.log(`========================================================================================`);
    const exchange = getBybitExchange();

    await seedHistoryIfNeeded(exchange);

    const pendingSignals: PendingSignal[] = [];

    for (const symbol of monitoredSymbols) {
        console.log(`\n>>> Fetching live Bybit candles for ${symbol}...`);
        try {
            const marketSymbol = toExchangeSymbol(symbol);
            const ohlcv = await fetchOHLCVWithRetry(exchange, marketSymbol, TIMEFRAME, undefined, 5);
            if (!ohlcv || ohlcv.length < 2) {
                log.warn({ symbol }, 'Insufficient candles received from exchange');
                continue;
            }

            const closedCandle = ohlcv[ohlcv.length - 2] as [number, number, number, number, number, number];
            const currentCandle = ohlcv[ohlcv.length - 1] as [number, number, number, number, number, number];

            console.log(`[Closed ${TIMEFRAME} Candle] ${new Date(closedCandle[0]).toISOString()} | Open: $${closedCandle[1]} High: $${closedCandle[2]} Low: $${closedCandle[3]} Close: $${closedCandle[4]}`);
            const closedSig = await processTick(symbol, TIMEFRAME, closedCandle, true);
            if (closedSig) pendingSignals.push(closedSig);

            console.log(`[Current Candle] ${new Date(currentCandle[0]).toISOString()} | Open: $${currentCandle[1]} High: $${currentCandle[2]} Low: $${currentCandle[3]} Close: $${currentCandle[4]}`);
            const currentSig = await processTick(symbol, TIMEFRAME, currentCandle, false);
            if (currentSig && !pendingSignals.some(s => s.symbol === symbol)) pendingSignals.push(currentSig);
        } catch (err) {
            log.error({ err, symbol }, 'Error during dry run for symbol');
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (pendingSignals.length > 0) {
        pendingSignals.sort((a, b) => b.adx - a.adx);
        const maxConcurrent = config.watchlist.maxConcurrentPositions;
        const availableSlots = Math.max(0, maxConcurrent - positions.size);
        for (const sig of pendingSignals.slice(0, availableSlots)) {
            await executeEntry(sig);
        }
    }

    console.log(`\n========================================================================================`);
    console.log(` [DRY RUN SUCCESS] Bidirectional filters and trailing stops computed cleanly!`);
    console.log(` Capital: $${capital.toFixed(2)} | Active Monitored Positions: ${positions.size}`);
    console.log(`========================================================================================\n`);
}

// -------------------------------------------------------------
// Graceful Lifecycle Management & Polling Runner Loop
// -------------------------------------------------------------

let isRunning = true;

function handleShutdown(signal: string) {
    if (!isRunning) return;
    isRunning = false;
    log.info(`Received ${signal}. Flushing state and gracefully exiting Bybit runner...`);
    try {
        persistState();
        setSystemStatus('PAUSED', null, `Runner stopped gracefully via ${signal}`);
        closeDb();
    } catch (e) {
        log.error({ e }, 'Error during graceful shutdown');
    }
    process.exit(0);
}

process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));

process.on('unhandledRejection', (reason: any) => {
    if (isNetworkError(reason)) {
        console.log(`\x1b[33m[NETWORK]\x1b[0m Network offline: Retrying in 10s...`);
        return;
    }
    log.error({ reason }, 'Unhandled Promise Rejection');
});

process.on('uncaughtException', (err: any) => {
    if (isNetworkError(err)) {
        console.log(`\x1b[33m[NETWORK]\x1b[0m Network offline: Retrying in 10s...`);
        return;
    }
    log.fatal({ err }, 'Uncaught Exception in Live Runner');
    process.exit(1);
});

export async function startLive() {
    const exchange = getBybitExchange();
    const lastTimestamps: Record<string, number> = {};

    setSystemStatus('RUNNING', null, 'Bybit live runner started');

    console.log(`\n${C.CYAN}${C.BOLD}╔══════════════════════════════════════════════════════════════════════════╗${C.RESET}`);
    console.log(`${C.CYAN}${C.BOLD}║       🤖  QUANTITATIVE TRADING BOT — ${config.app.executionMode.padEnd(10)} [RUNNING]       ║${C.RESET}`);
    console.log(`${C.CYAN}${C.BOLD}╚══════════════════════════════════════════════════════════════════════════╝${C.RESET}`);
    console.log(`   👀 Watching: ${monitoredSymbols.join(', ')}`);
    console.log(`   ⏱️  Polling Interval: 15 seconds | Timeframe: ${TIMEFRAME}`);
    console.log(`   🛡️  Risk: Max ${(MAX_RISK_PCT * 100).toFixed(0)}% per trade | Drawdown Limit: ${(config.risk.maxDrawdownPct * 100).toFixed(0)}%`);
    console.log(`   💰 Balance: $${capital.toFixed(2)} USDT\n`);

    const screener = new DynamicAssetScreener();
    screener.runScreening().catch(err => log.error({ err }, 'Initial screening error'));
    screener.schedule6Hours();

    try {
        await seedHistoryIfNeeded(exchange);
    } catch (err: any) {
        if (isNetworkError(err)) {
            console.log(`\x1b[33m[NETWORK]\x1b[0m Network offline: Retrying in 10s...`);
            await new Promise(r => setTimeout(r, 10000));
        }
    }

    while (isRunning) {
        try {
            // 1. Heartbeat & Operator Control Command Handling
            updateHeartbeat();
            const sysState = getSystemState();

            if (sysState.pending_command === 'PAUSE') {
                log.info('Executing PAUSE operator command');
                setSystemStatus('PAUSED', null, 'Operator requested pause via dashboard');
                clearPendingCommand();
            } else if (sysState.pending_command === 'RESUME') {
                log.info('Executing RESUME operator command');
                lockoutUntil = 0;
                setSystemStatus('RUNNING', null, 'Operator requested resume via dashboard');
                clearPendingCommand();
            } else if (sysState.pending_command === 'KILL_SWITCH') {
                log.warn('Executing KILL_SWITCH operator command');
                marketClosePositions('BYBIT');
                positions.clear();
                persistState();
                clearPendingCommand();
            }

            const currentStatus = getSystemState().status;
            const isPaused = currentStatus === 'PAUSED' || config.app.strategyPaused;
            if (config.app.strategyPaused) {
                // Ensure dashboard reflects paused status for 15m strategy
                setSystemStatus('PAUSED', null, '15m strategy paused by operator: zero edge after costs');
            }

            const activePairs = getMonitoredPairs();
            if (activePairs && activePairs.length > 0) {
                monitoredSymbols = activePairs;
            }

            // Single batch call to fetch tickers for all symbols (1 API call)
            let tickers: Record<string, any> = {};
            try {
                tickers = await exchange.fetchTickers();
            } catch (err: any) {
                if (isNetworkError(err)) {
                    console.log(`\x1b[33m[NETWORK]\x1b[0m Network offline: Retrying in 10s...`);
                    await new Promise(r => setTimeout(r, 10000));
                    continue;
                }
                log.warn({ err: err?.message || err }, 'Failed batch fetching tickers, will rely on OHLCV prices');
            }

            // 2. Pending signals collection across the monitored universe
            const pendingSignals: PendingSignal[] = [];

            // Stagger symbol requests by 300ms each to prevent Bybit rate-limit warnings
            for (const symbol of [...monitoredSymbols]) {
                if (!isRunning) break;
                try {
                    // Check candle count in SQLite; if count < 100, fetch 200 candles before evaluating
                    const historyOk = await ensureCandleHistory(exchange, symbol, TIMEFRAME, 100);
                    if (!historyOk && !monitoredSymbols.includes(symbol)) {
                        continue; // Invalid symbol was pruned from watchlist
                    }

                    const marketSymbol = toExchangeSymbol(symbol);
                    const ohlcv = await fetchOHLCVWithRetry(exchange, marketSymbol, TIMEFRAME, undefined, 3);
                    if (ohlcv && ohlcv.length >= 2) {
                        const closedCandle = ohlcv[ohlcv.length - 2] as [number, number, number, number, number, number];
                        const currentCandle = ohlcv[ohlcv.length - 1] as [number, number, number, number, number, number];

                        // Cache ticker price into currentCandle close if available
                        const cachedTicker = tickers[marketSymbol] || tickers[symbol] || tickers[`${symbol}:USDT`];
                        if (cachedTicker && cachedTicker.last) {
                            currentCandle[4] = cachedTicker.last;
                        }

                        if (closedCandle && (!lastTimestamps[symbol] || closedCandle[0] > lastTimestamps[symbol])) {
                            console.log(`\n${C.CYAN}🕐 New ${TIMEFRAME} candle closed${C.RESET} ${symbol} at ${new Date(closedCandle[0]).toLocaleTimeString()}`);
                            const closedSig = await processTick(symbol, TIMEFRAME, closedCandle, true, isPaused);
                            if (closedSig) {
                                pendingSignals.push(closedSig);
                            }
                            lastTimestamps[symbol] = closedCandle[0];
                        }

                        const currentSig = await processTick(symbol, TIMEFRAME, currentCandle, false, isPaused);
                        if (currentSig && !pendingSignals.some(s => s.symbol === symbol)) {
                            pendingSignals.push(currentSig);
                        }
                    }
                } catch (err: any) {
                    if (isBadSymbolError(err)) {
                        removeInvalidSymbol(symbol, err?.message || 'Invalid symbol on exchange');
                        continue;
                    }
                    if (isNetworkError(err)) {
                        throw err;
                    }
                    log.error({ err: err?.message || err, symbol }, 'Error processing live data for symbol');
                }

                // Stagger symbol requests by 300ms
                await new Promise((resolve) => setTimeout(resolve, 300));
            }

            // 3. Signal Quality Ranking & Priority Execution
            if (pendingSignals.length > 0 && !isPaused) {
                // Sort by ADX descending (strongest trends first)
                pendingSignals.sort((a, b) => b.adx - a.adx);

                const maxConcurrent = config.watchlist.maxConcurrentPositions;
                const currentOpenPositions = positions.size;
                const availableSlots = Math.max(0, maxConcurrent - currentOpenPositions);
                const selectedSignals = pendingSignals.slice(0, availableSlots);

                if (selectedSignals.length > 0) {
                    console.log(`\n${C.CYAN}🎯 Signal Ranking:${C.RESET} Selected top ${selectedSignals.length} of ${pendingSignals.length} candidates by ADX (Available slots: ${availableSlots}/${maxConcurrent})`);
                    for (const sig of selectedSignals) {
                        await executeEntry(sig);
                    }
                }
            }

            // Counterfactual Learning: Evaluate open shadow trades
            const currentPricesMap = new Map<string, { close: number; high: number; low: number }>();
            for (const sym of monitoredSymbols) {
                const row = db.prepare('SELECT close, high, low FROM candles WHERE symbol = ? AND timeframe = ? ORDER BY timestamp DESC LIMIT 1').get(sym, TIMEFRAME) as any;
                if (row) {
                    currentPricesMap.set(sym, { close: row.close, high: row.high, low: row.low });
                }
            }
            const shadowRes = StrategyLearner.evaluateShadowTrades(db, currentPricesMap);
            if (shadowRes.adjustments.length > 0) {
                for (const adj of shadowRes.adjustments) {
                    console.log(`${C.YELLOW}🧠 ${adj}${C.RESET}`);
                    logActivity('STATE_CHANGE', adj, 'Shadow trade counterfactual filter tuning', db);
                }
            }
        } catch (e: any) {
            if (isNetworkError(e)) {
                console.log(`\x1b[33m[NETWORK]\x1b[0m Network offline: Retrying in 10s...`);
                await new Promise(r => setTimeout(r, 10000));
                continue;
            }
            log.error({ e }, 'Error in live polling loop');
        }
        maybePrintSummary();
        await new Promise(r => setTimeout(r, 15000)); // Poll every 15 seconds
    }
}

if (require.main === module) {
    if (process.argv.includes('--dry-run')) {
        runDryRun().catch(err => {
            log.fatal({ err }, 'Dry run error');
            process.exit(1);
        });
    } else {
        const runForever = async () => {
            while (isRunning) {
                try {
                    await startLive();
                } catch (err: any) {
                    if (isNetworkError(err)) {
                        console.log(`\x1b[33m[NETWORK]\x1b[0m Network offline: Retrying in 10s...`);
                        await new Promise(r => setTimeout(r, 10000));
                    } else {
                        log.fatal({ err }, 'Fatal Live Runner Error');
                        process.exit(1);
                    }
                }
            }
        };
        runForever();
    }
}
