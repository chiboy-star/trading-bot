import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Dynamically locate market_data.db
function getDbPath(): string {
    const candidates = [
        path.join(process.cwd(), '..', 'data', 'market_data.db'),
        path.join(process.cwd(), 'data', 'market_data.db'),
        path.resolve(__dirname, '../../../data/market_data.db'),
        path.resolve(__dirname, '../../data/market_data.db')
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }

    const defaultPath = path.join(process.cwd(), '..', 'data', 'market_data.db');
    const dir = path.dirname(defaultPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return defaultPath;
}

let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
    if (!dbInstance) {
        const dbPath = getDbPath();
        dbInstance = new Database(dbPath, { readonly: false });
        try {
            dbInstance.pragma('journal_mode = WAL');
            dbInstance.pragma('busy_timeout = 5000');
            dbInstance.pragma('synchronous = NORMAL');
        } catch {
            // Pragma fallback
        }
        ensureTables(dbInstance);
    }
    return dbInstance;
}

function ensureTables(db: Database.Database) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS system_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            status TEXT NOT NULL DEFAULT 'RUNNING',
            status_changed_at TEXT NOT NULL,
            last_heartbeat_at TEXT NOT NULL,
            error_component TEXT,
            pending_command TEXT NOT NULL DEFAULT 'NONE'
        );

        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            cause TEXT,
            dismissed INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS active_positions (
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
            PRIMARY KEY (symbol, broker)
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
            broker TEXT DEFAULT 'BYBIT',
            signal_price REAL,
            fill_price REAL,
            slippage REAL DEFAULT 0,
            funding_pnl REAL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS bot_state (
            id INTEGER PRIMARY KEY,
            capital REAL NOT NULL,
            initial_capital REAL NOT NULL,
            circuit_breaker_halted INTEGER DEFAULT 0,
            lockout_until INTEGER DEFAULT 0,
            circuit_breaker_limit REAL DEFAULT 0.05,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS monitored_market_state (
            symbol TEXT PRIMARY KEY,
            price REAL NOT NULL,
            change_24h REAL NOT NULL DEFAULT 0,
            ema20 REAL NOT NULL,
            ema50 REAL NOT NULL,
            rsi14 REAL NOT NULL,
            adx14 REAL NOT NULL,
            signal_proximity TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            tier TEXT NOT NULL DEFAULT 'CORE'
        );

        CREATE TABLE IF NOT EXISTS monitored_pairs (
            symbol TEXT PRIMARY KEY,
            base_asset TEXT NOT NULL,
            quote_asset TEXT NOT NULL,
            daily_adx REAL NOT NULL,
            intraday_adx REAL NOT NULL DEFAULT 0,
            composite_score REAL NOT NULL DEFAULT 0,
            tier TEXT NOT NULL DEFAULT 'CORE',
            volume_24h REAL NOT NULL,
            rank INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

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

        CREATE TABLE IF NOT EXISTS fx_rates (
            pair TEXT PRIMARY KEY,
            rate REAL NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);

    try {
        const cols = db.prepare("PRAGMA table_info(monitored_market_state)").all() as { name: string }[];
        if (!cols.some(c => c.name === 'tier')) {
            db.exec("ALTER TABLE monitored_market_state ADD COLUMN tier TEXT DEFAULT 'CORE';");
        }
    } catch {}

    try {
        const botCols = db.prepare("PRAGMA table_info(bot_state)").all() as { name: string }[];
        if (!botCols.some(c => c.name === 'circuit_breaker_limit')) {
            db.exec("ALTER TABLE bot_state ADD COLUMN circuit_breaker_limit REAL DEFAULT 0.05;");
        }
    } catch {}

    const hasState = db.prepare("SELECT id FROM system_state WHERE id = 1").get();
    if (!hasState) {
        const nowIso = new Date().toISOString();
        db.prepare(`
            INSERT INTO system_state (id, status, status_changed_at, last_heartbeat_at, error_component, pending_command)
            VALUES (1, 'RUNNING', ?, ?, NULL, 'NONE')
        `).run(nowIso, nowIso);
    }
}

// -------------------------------------------------------------
// Type Definitions strictly adhering to Design Doc (@Madueke)
// -------------------------------------------------------------

export interface SystemStateInfo {
    status: 'RUNNING' | 'PAUSED' | 'ERROR';
    statusChangedAt: string;
    lastHeartbeatAt: string;
    errorComponent: string | null;
    pendingCommand: string;
    isStale: boolean;
    timeSinceStateChange: string;
    lastHeartbeatFormatted: string;
    isCircuitBreakerHalted?: boolean;
    lockoutUntil?: number;
}

export interface MetricSummary {
    todayPnl: number;
    todayPnlPercent: number;
    totalEquity: number;
    availableBuyingPower: number;
    marginUsed: number;
    initialCapital: number;
    winRate: number;
    maxDrawdown: number;
    circuitBreakerLimit: number;
    circuitBreakerLimitPct: number;
    activePositionsCount: number;
    totalPositionsNotional: number;
    totalTradesCount: number;
}

export interface PositionItem {
    symbol: string;
    broker: string;
    side: 'LONG' | 'SHORT';
    amount: number;
    entryPrice: number;
    currentPrice: number;
    trailingStop: number;
    atr: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    notional: number;
    entryTime: number;
    holdingDuration: string;
}

export interface OrderItem {
    id: number;
    orderId: string;
    symbol: string;
    broker: string;
    side: 'LONG' | 'SHORT';
    orderSide: string; // 'BUY' | 'SELL'
    type: string;      // 'ENTRY' | 'TRAILING_STOP' | 'EMA_CROSS' | 'KILL_SWITCH'
    price: number;
    amount: number;
    fee: number;
    pnl: number;
    pnlPercent: number;
    timestamp: number;
    timeFormatted: string;
    status: 'FILLED' | 'REJECTED' | 'HALTED';
    reason?: string;
    signalPrice?: number;
    fillPrice?: number;
    slippage?: number;
    fundingPnl?: number;
}

export interface AlertItem {
    id: number;
    timestamp: string;
    timeFormatted: string;
    type: 'STATE_CHANGE' | 'ALERT' | 'ORDER' | 'ERROR';
    message: string;
    cause: string | null;
    dismissed: boolean;
}

export interface EquityPoint {
    timestamp: number;
    timeFormatted: string;
    equity: number;
}

export interface CandlePoint {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface MonitoredMarketItem {
    symbol: string;
    price: number;
    change24h: number;
    ema20: number;
    ema50: number;
    rsi14: number;
    adx14: number;
    signalProximity: string;
    updatedAt: number;
    tier?: 'CORE' | 'SATELLITE';
    candles: CandlePoint[];
}

export interface InstitutionalDashboardData {
    systemState: SystemStateInfo;
    metrics: MetricSummary;
    equityHistory: {
        '24H': EquityPoint[];
        '7D': EquityPoint[];
        '30D': EquityPoint[];
        'ALL': EquityPoint[];
    };
    positions: PositionItem[];
    orders: OrderItem[];
    alerts: AlertItem[];
    activityLog: AlertItem[];
    monitoredMarkets: MonitoredMarketItem[];
    lastUpdated: number;
}

function formatDuration(ms: number): string {
    const totalSecs = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
}

function formatTz(timestamp: number | string): string {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '00:00:00 UTC';
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const mins = String(d.getUTCMinutes()).padStart(2, '0');
    const secs = String(d.getUTCSeconds()).padStart(2, '0');
    return `${hours}:${mins}:${secs} UTC`;
}

export function getDashboardOverview(): InstitutionalDashboardData {
    const db = getDatabase();
    const now = Date.now();

    // 1. System State & Staleness Evaluation
    let sysRow = db.prepare("SELECT * FROM system_state WHERE id = 1").get() as any;
    if (!sysRow) {
        const nowIso = new Date().toISOString();
        db.prepare(`
            INSERT INTO system_state (id, status, status_changed_at, last_heartbeat_at, error_component, pending_command)
            VALUES (1, 'RUNNING', ?, ?, NULL, 'NONE')
        `).run(nowIso, nowIso);
        sysRow = {
            status: 'RUNNING',
            status_changed_at: nowIso,
            last_heartbeat_at: nowIso,
            error_component: null,
            pending_command: 'NONE'
        };
    }

    const lastHeartbeatMs = new Date(sysRow.last_heartbeat_at).getTime();
    const isStale = (now - lastHeartbeatMs) > 30000; // > 30s is stale

    const stateChangedMs = new Date(sysRow.status_changed_at).getTime();
    const timeSinceStateChange = formatDuration(now - stateChangedMs);

    // 2. Bot State / Capital & Circuit Breaker Lockout
    let initialCapital = 10000;
    let currentCapital = 10000;
    let isCircuitBreakerHalted = false;
    let lockoutUntil = 0;
    try {
        const botStateRow = db.prepare('SELECT capital, initial_capital, circuit_breaker_halted, lockout_until FROM bot_state WHERE id = 1').get() as any;
        if (botStateRow) {
            initialCapital = Number(botStateRow.initial_capital || 10000);
            currentCapital = Number(botStateRow.capital || 10000);
            lockoutUntil = Number(botStateRow.lockout_until || 0);
            isCircuitBreakerHalted = Boolean(botStateRow.circuit_breaker_halted) || (lockoutUntil > now);
        }
    } catch {}

    const systemState: SystemStateInfo = {
        status: (sysRow.status || 'RUNNING') as 'RUNNING' | 'PAUSED' | 'ERROR',
        statusChangedAt: sysRow.status_changed_at,
        lastHeartbeatAt: sysRow.last_heartbeat_at,
        errorComponent: sysRow.error_component,
        pendingCommand: sysRow.pending_command || 'NONE',
        isStale,
        timeSinceStateChange,
        lastHeartbeatFormatted: formatTz(sysRow.last_heartbeat_at),
        isCircuitBreakerHalted,
        lockoutUntil
    };

    // 3. Active Positions (STRICTLY sorted by position notional size DESCENDING)
    let rawPositions: any[] = [];
    try {
        rawPositions = db.prepare('SELECT * FROM active_positions').all() as any[];
    } catch {}

    let totalUnrealizedPnl = 0;
    let totalPositionsNotional = 0;

    const positions: PositionItem[] = rawPositions.map(p => {
        const amount = Number(p.amount);
        const curPrice = Number(p.current_price);
        const entryPrice = Number(p.entry_price);
        const notional = amount * curPrice;
        const side: 'LONG' | 'SHORT' = p.side === 'SHORT' ? 'SHORT' : 'LONG';
        const fee = notional * 0.00075;
        let pnl = side === 'SHORT' ? (entryPrice - curPrice) * amount : (curPrice - entryPrice) * amount;
        pnl -= fee;
        const pnlPercent = (entryPrice * amount) > 0 ? (pnl / (entryPrice * amount)) * 100 : 0;

        totalUnrealizedPnl += pnl;
        totalPositionsNotional += notional;

        const durationMs = now - Number(p.entry_time);

        return {
            symbol: p.symbol,
            broker: p.broker || 'BYBIT',
            side,
            amount,
            entryPrice,
            currentPrice: curPrice,
            trailingStop: Number(p.trailing_stop),
            atr: Number(p.atr || 0),
            unrealizedPnl: pnl,
            unrealizedPnlPercent: pnlPercent,
            notional,
            entryTime: Number(p.entry_time),
            holdingDuration: formatDuration(durationMs)
        };
    });

    // Strictly sort by notional size descending (largest first)
    positions.sort((a, b) => b.notional - a.notional);

    // 4. Trade History / Orders (Sorted newest first)
    let rawTrades: any[] = [];
    try {
        rawTrades = db.prepare('SELECT * FROM paper_trades ORDER BY timestamp DESC, id DESC LIMIT 100').all() as any[];
    } catch {}

    let winningTrades = 0;
    let losingTrades = 0;
    let totalRealizedPnlToday = 0;

    // Start of today UTC
    const startOfTodayUtc = new Date();
    startOfTodayUtc.setUTCHours(0, 0, 0, 0);
    const startOfTodayMs = startOfTodayUtc.getTime();

    const orders: OrderItem[] = rawTrades.map(t => {
        const pnl = Number(t.pnl || 0);
        const timestamp = Number(t.timestamp);
        const isClosedExit = t.type !== 'ENTRY';

        if (isClosedExit) {
            if (pnl > 0) winningTrades++;
            else if (pnl < 0) losingTrades++;

            if (timestamp >= startOfTodayMs) {
                totalRealizedPnlToday += pnl;
            }
        }

        let reason: string | undefined = undefined;
        if (t.type === 'TRAILING_STOP') {
            reason = '1.5x ATR dynamic trailing stop ratchet breached';
        } else if (t.type === 'EMA_CROSS') {
            reason = 'Reverse EMA 20/50 crossover confirmed';
        } else if (t.type === 'KILL_SWITCH') {
            reason = 'Manual emergency kill switch executed by operator';
        }

        return {
            id: Number(t.id),
            orderId: t.order_id,
            symbol: t.symbol,
            broker: t.broker || 'BYBIT',
            side: (t.direction === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT',
            orderSide: t.side,
            type: t.type,
            price: Number(t.price),
            amount: Number(t.amount),
            fee: Number(t.fee || 0),
            pnl,
            pnlPercent: Number(t.pnl_percent || 0),
            timestamp,
            timeFormatted: formatTz(timestamp),
            status: 'FILLED',
            reason,
            signalPrice: t.signal_price !== null && t.signal_price !== undefined ? Number(t.signal_price) : undefined,
            fillPrice: t.fill_price !== null && t.fill_price !== undefined ? Number(t.fill_price) : undefined,
            slippage: t.slippage !== null && t.slippage !== undefined ? Number(t.slippage) : undefined,
            fundingPnl: t.funding_pnl !== null && t.funding_pnl !== undefined ? Number(t.funding_pnl) : 0
        };
    });

    const totalClosedTrades = winningTrades + losingTrades;
    const winRate = totalClosedTrades > 0 ? (winningTrades / totalClosedTrades) * 100 : 0;

    // Cumulative Realized P&L from all closed paper trades
    let totalRealizedPnlAll = 0;
    try {
        const pnlRow = db.prepare("SELECT COALESCE(SUM(pnl), 0) as totalPnl FROM paper_trades WHERE type != 'ENTRY'").get() as any;
        totalRealizedPnlAll = Number(pnlRow?.totalPnl || 0);
    } catch {}

    // Perpetual Margin Accounting (10x leverage)
    // Available Buying Power = Initial Capital + Realized PnL - (Margin Used by Open Trades)
    // Total Equity = Initial Capital + Realized PnL + Unrealized PnL
    const leverage = 10;
    const marginUsed = totalPositionsNotional / leverage;
    const availableBuyingPower = initialCapital + totalRealizedPnlAll - marginUsed;
    const totalEquity = initialCapital + totalRealizedPnlAll + totalUnrealizedPnl;

    // Today's total P&L = Realized closed today + current Unrealized
    const todayPnl = totalRealizedPnlToday + totalUnrealizedPnl;
    const todayPnlPercent = initialCapital > 0 ? (todayPnl / initialCapital) * 100 : 0;

    // 24h Drawdown calculation from daily losses
    let maxDrawdown = 0;
    try {
        const cutoff24h = now - 24 * 60 * 60 * 1000;
        const lossRow = db.prepare('SELECT COALESCE(SUM(amount), 0) as sumLoss FROM daily_losses WHERE timestamp >= ?').get(cutoff24h) as any;
        const sumLoss = Number(lossRow?.sumLoss || 0);
        maxDrawdown = initialCapital > 0 ? (sumLoss / initialCapital) * 100 : 0;
    } catch {}

    // Dynamic Circuit Breaker Limit from bot_state
    let circuitBreakerLimit = 0.05;
    try {
        const botRow = db.prepare('SELECT circuit_breaker_limit FROM bot_state WHERE id = 1').get() as any;
        if (botRow && typeof botRow.circuit_breaker_limit === 'number' && botRow.circuit_breaker_limit > 0) {
            circuitBreakerLimit = botRow.circuit_breaker_limit;
        }
    } catch {}
    const circuitBreakerLimitPct = Number((circuitBreakerLimit * 100).toFixed(1));

    const metrics: MetricSummary = {
        todayPnl,
        todayPnlPercent,
        totalEquity,
        availableBuyingPower,
        marginUsed,
        initialCapital,
        winRate,
        maxDrawdown,
        circuitBreakerLimit,
        circuitBreakerLimitPct,
        activePositionsCount: positions.length,
        totalPositionsNotional,
        totalTradesCount: totalClosedTrades
    };

    // 5. Equity History Points for Periods (24H, 7D, 30D, ALL)
    // Compute cumulative equity trajectory from trades
    const closedTradesAsc = rawTrades.filter(t => t.type !== 'ENTRY').reverse();
    let rollingBal = initialCapital;
    const tradePoints: { timestamp: number; equity: number }[] = [];
    tradePoints.push({ timestamp: now - 30 * 24 * 3600 * 1000, equity: initialCapital });

    for (const tr of closedTradesAsc) {
        rollingBal += Number(tr.pnl || 0);
        tradePoints.push({ timestamp: Number(tr.timestamp), equity: rollingBal });
    }
    tradePoints.push({ timestamp: now, equity: totalEquity });

    const filterPeriod = (periodMs: number): EquityPoint[] => {
        const start = periodMs === 0 ? 0 : now - periodMs;
        const filtered = tradePoints.filter(p => p.timestamp >= start);
        if (filtered.length === 0) {
            return [
                { timestamp: now - 3600000, timeFormatted: formatTz(now - 3600000), equity: totalEquity },
                { timestamp: now, timeFormatted: formatTz(now), equity: totalEquity }
            ];
        }
        return filtered.map(p => ({
            timestamp: p.timestamp,
            timeFormatted: formatTz(p.timestamp),
            equity: Number(p.equity.toFixed(2))
        }));
    };

    const equityHistory = {
        '24H': filterPeriod(24 * 3600 * 1000),
        '7D': filterPeriod(7 * 24 * 3600 * 1000),
        '30D': filterPeriod(30 * 24 * 3600 * 1000),
        'ALL': filterPeriod(0)
    };

    // 6. Alerts & Activity Log
    let rawAlerts: any[] = [];
    try {
        rawAlerts = db.prepare(`
            SELECT * FROM activity_log 
            ORDER BY id DESC 
            LIMIT 50
        `).all() as any[];
    } catch {}

    const activityLog: AlertItem[] = rawAlerts.map(a => ({
        id: Number(a.id),
        timestamp: a.timestamp,
        timeFormatted: formatTz(a.timestamp),
        type: a.type,
        message: a.message,
        cause: a.cause,
        dismissed: Boolean(a.dismissed)
    }));

    const alerts = activityLog.filter(a => !a.dismissed && (a.type === 'ALERT' || a.type === 'ERROR'));

    // 7. Monitored Markets & Recent 100 Candles
    const monitoredMarkets: MonitoredMarketItem[] = [];
    try {
        const marketRows = db.prepare('SELECT * FROM monitored_market_state ORDER BY symbol ASC').all() as any[];
        let pairRows: { symbol: string; tier?: string; rank?: number }[] = [];
        try {
            pairRows = db.prepare('SELECT symbol, tier, rank FROM monitored_pairs ORDER BY rank ASC').all() as any[];
        } catch {}

        const pairTierMap = new Map<string, 'CORE' | 'SATELLITE'>();
        pairRows.forEach(p => {
            if (p.tier === 'CORE' || p.tier === 'SATELLITE') {
                pairTierMap.set(p.symbol, p.tier);
            }
        });

        // Collect unique symbols preserving rank order from monitored_pairs first, then any extra marketRows
        const symbolSet = new Set<string>();
        pairRows.forEach(p => symbolSet.add(p.symbol));
        marketRows.forEach(r => symbolSet.add(r.symbol));

        if (symbolSet.size === 0) {
            [
                'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'SUI/USDT',
                'XRP/USDT', 'DOGE/USDT', 'AVAX/USDT', 'LINK/USDT'
            ].forEach(s => symbolSet.add(s));
        }

        const symbolsToFetch = Array.from(symbolSet);

        const coreSet = new Set([
            'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'SUI/USDT',
            'XRP/USDT', 'DOGE/USDT', 'AVAX/USDT', 'LINK/USDT'
        ]);

        const candleStmt = db.prepare(`
            SELECT timestamp, open, high, low, close, volume
            FROM candles
            WHERE symbol = ?
            ORDER BY timestamp DESC
            LIMIT 100
        `);

        for (const symbol of symbolsToFetch) {
            const mRow = marketRows.find(r => r.symbol === symbol);
            const rawCandles = (candleStmt.all(symbol) as any[]).reverse();
            const lastCandle = rawCandles[rawCandles.length - 1];
            const price = mRow ? Number(mRow.price) : (lastCandle ? Number(lastCandle.close) : 0);
            const tier = (mRow?.tier || pairTierMap.get(symbol) || (coreSet.has(symbol) ? 'CORE' : 'SATELLITE')) as 'CORE' | 'SATELLITE';

            monitoredMarkets.push({
                symbol,
                price,
                change24h: mRow ? Number(mRow.change_24h) : 0,
                ema20: mRow ? Number(mRow.ema20) : (lastCandle ? Number(lastCandle.close) : 0),
                ema50: mRow ? Number(mRow.ema50) : (lastCandle ? Number(lastCandle.close) : 0),
                rsi14: mRow ? Number(mRow.rsi14) : 50,
                adx14: mRow ? Number(mRow.adx14) : 20,
                signalProximity: mRow ? mRow.signal_proximity : 'Monitoring market structure',
                updatedAt: mRow ? Number(mRow.updated_at) : (lastCandle ? Number(lastCandle.timestamp) : now),
                tier,
                candles: rawCandles.map(c => ({
                    timestamp: Number(c.timestamp),
                    open: Number(c.open),
                    high: Number(c.high),
                    low: Number(c.low),
                    close: Number(c.close),
                    volume: Number(c.volume)
                }))
            });
        }
    } catch {}

    return {
        systemState,
        metrics,
        equityHistory,
        positions,
        orders,
        alerts,
        activityLog,
        monitoredMarkets,
        lastUpdated: now
    };
}

// -------------------------------------------------------------
// FX Rate Store
// -------------------------------------------------------------

export function getFxRate(pair: string = 'USD_NGN'): { pair: string; rate: number; updated_at: number } | null {
    const db = getDatabase();
    try {
        const row = db.prepare("SELECT * FROM fx_rates WHERE pair = ?").get(pair) as { pair: string; rate: number; updated_at: number } | undefined;
        return row || null;
    } catch {
        return null;
    }
}

export function setFxRate(pair: string, rate: number): void {
    const db = getDatabase();
    const now = Date.now();
    try {
        db.prepare(`
            INSERT INTO fx_rates (pair, rate, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(pair) DO UPDATE SET
                rate = excluded.rate,
                updated_at = excluded.updated_at
        `).run(pair, rate, now);
    } catch {}
}

// -------------------------------------------------------------
// Operator Control Actions
// -------------------------------------------------------------

export function setCircuitBreakerLimit(limit: number): { success: boolean; message: string; limit: number; limitPct: number } {
    const db = getDatabase();
    let decimalLimit = 0.05;
    if (typeof limit === 'number' && limit > 0) {
        decimalLimit = limit > 1.0 ? limit / 100 : limit;
    }
    // Clamp between 0.01 (1.0%) and 0.10 (10.0%)
    decimalLimit = Math.min(0.10, Math.max(0.01, decimalLimit));

    db.prepare(`
        UPDATE bot_state
        SET circuit_breaker_limit = ?,
            updated_at = ?
        WHERE id = 1
    `).run(decimalLimit, Date.now());

    const pct = Number((decimalLimit * 100).toFixed(1));
    const nowIso = new Date().toISOString();
    db.prepare(`
        INSERT INTO activity_log (timestamp, type, message, cause, dismissed)
        VALUES (?, 'STATE_CHANGE', ?, 'Operator adjusted circuit breaker slider in dashboard', 0)
    `).run(nowIso, `24h Circuit Breaker limit updated to ${pct}%`);

    return {
        success: true,
        message: `Circuit breaker limit successfully set to ${pct}%.`,
        limit: decimalLimit,
        limitPct: pct
    };
}

export function handleOperatorAction(
    action: 'PAUSE' | 'RESUME' | 'KILL_SWITCH' | 'DISMISS_ALERT' | 'SET_CIRCUIT_BREAKER' | 'RESET_CIRCUIT_BREAKER',
    alertId?: number,
    payload?: any
): { success: boolean; message: string; limit?: number; limitPct?: number } {
    const db = getDatabase();
    const nowIso = new Date().toISOString();

    if (action === 'SET_CIRCUIT_BREAKER') {
        const val = typeof payload === 'number' ? payload : (typeof alertId === 'number' ? alertId : 5.0);
        return setCircuitBreakerLimit(val);
    }

    if (action === 'PAUSE') {
        db.prepare(`
            UPDATE system_state
            SET status = 'PAUSED',
                pending_command = 'PAUSE',
                status_changed_at = ?,
                last_heartbeat_at = ?
            WHERE id = 1
        `).run(nowIso, nowIso);

        db.prepare(`
            INSERT INTO activity_log (timestamp, type, message, cause, dismissed)
            VALUES (?, 'STATE_CHANGE', 'Bot is paused. No new orders will be placed.', 'Operator clicked Pause in dashboard', 0)
        `).run(nowIso);

        return { success: true, message: 'Bot paused successfully.' };
    }

    if (action === 'RESUME') {
        const botState = db.prepare('SELECT circuit_breaker_halted, lockout_until FROM bot_state WHERE id = 1').get() as any;
        const isLockedOut = botState && Number(botState.lockout_until) > Date.now();

        db.prepare(`
            UPDATE system_state
            SET status = 'RUNNING',
                pending_command = 'RESUME',
                status_changed_at = ?,
                last_heartbeat_at = ?
            WHERE id = 1
        `).run(nowIso, nowIso);

        if (isLockedOut) {
            db.prepare(`
                INSERT INTO activity_log (timestamp, type, message, cause, dismissed)
                VALUES (?, 'ALERT', 'Bot resumed manual pause, but circuit breaker lockout remains active until ' || ?, 'Operator clicked Resume while in circuit breaker lockout', 0)
            `).run(nowIso, new Date(Number(botState.lockout_until)).toISOString());

            return {
                success: true,
                message: `Bot unpaused, but circuit breaker lockout remains active until ${new Date(Number(botState.lockout_until)).toLocaleTimeString()}. Use explicit Reset Breaker to clear lockout.`
            };
        }

        db.prepare(`
            INSERT INTO activity_log (timestamp, type, message, cause, dismissed)
            VALUES (?, 'STATE_CHANGE', 'Bot resumed normal automated execution.', 'Operator clicked Resume in dashboard', 0)
        `).run(nowIso);

        return { success: true, message: 'Bot resumed successfully.' };
    }

    if (action === 'RESET_CIRCUIT_BREAKER') {
        // Explicit circuit breaker reset: clears 24h loss cache and lockout without touching trade history
        db.prepare('DELETE FROM daily_losses').run();
        db.prepare(`
            UPDATE bot_state
            SET circuit_breaker_halted = 0,
                lockout_until = 0,
                updated_at = ?
            WHERE id = 1
        `).run(Date.now());

        db.prepare(`
            UPDATE system_state
            SET status = 'RUNNING',
                pending_command = 'NONE',
                error_component = NULL,
                status_changed_at = ?,
                last_heartbeat_at = ?
            WHERE id = 1
        `).run(nowIso, nowIso);

        db.prepare(`
            INSERT INTO activity_log (timestamp, type, message, cause, dismissed)
            VALUES (?, 'STATE_CHANGE', 'Circuit breaker manually reset by operator.', 'Operator confirmed circuit breaker reset', 0)
        `).run(nowIso);

        return {
            success: true,
            message: 'Circuit breaker lockout cleared and 24h loss cache reset. Trade history strictly preserved.'
        };
    }

    if (action === 'KILL_SWITCH') {
        return db.transaction(() => {
            const positions = db.prepare('SELECT * FROM active_positions').all() as any[];
            let closedCount = 0;
            let totalRealizedPnl = 0;
            const now = Date.now();

            const insertTradeStmt = db.prepare(`
                INSERT INTO paper_trades (order_id, symbol, side, type, price, amount, fee, pnl, pnl_percent, timestamp, direction, execution_mode, broker)
                VALUES (?, ?, ?, 'KILL_SWITCH', ?, ?, ?, ?, ?, ?, ?, 'LIVE_FORWARD', ?)
            `);

            for (const pos of positions) {
                const exitPrice = Number(pos.current_price);
                const amount = Number(pos.amount);
                const notional = amount * exitPrice;
                const fee = notional * 0.00075;
                const side = pos.side === 'SHORT' ? 'SHORT' : 'LONG';
                let rawPnl = side === 'SHORT'
                    ? (Number(pos.entry_price) - exitPrice) * amount
                    : (exitPrice - Number(pos.entry_price)) * amount;
                const netPnl = rawPnl - fee;
                const pnlPercent = (Number(pos.entry_price) * amount) > 0 ? (netPnl / (Number(pos.entry_price) * amount)) * 100 : 0;
                const closeSide = side === 'SHORT' ? 'BUY' : 'SELL';
                const orderId = `KS-${pos.symbol.replace(/[^A-Za-z0-9]/g, '')}-${Date.now().toString().slice(-4)}`;

                insertTradeStmt.run(
                    orderId,
                    pos.symbol,
                    closeSide,
                    exitPrice,
                    amount,
                    fee,
                    netPnl,
                    pnlPercent,
                    now,
                    side,
                    pos.broker || 'BYBIT'
                );

                totalRealizedPnl += netPnl;
                closedCount++;
            }

            db.prepare('DELETE FROM active_positions').run();

            db.prepare(`
                UPDATE system_state
                SET status = 'PAUSED',
                    pending_command = 'KILL_SWITCH',
                    status_changed_at = ?,
                    last_heartbeat_at = ?
                WHERE id = 1
            `).run(nowIso, nowIso);

            db.prepare(`
                INSERT INTO activity_log (timestamp, type, message, cause, dismissed)
                VALUES (?, 'STATE_CHANGE', ?, 'Emergency kill switch triggered from dashboard', 0)
            `).run(
                nowIso,
                `Kill switch executed by operator: closed ${closedCount} open positions ($${totalRealizedPnl.toFixed(2)} realized P&L) and paused bot.`
            );

            return {
                success: true,
                message: `Kill switch executed: closed ${closedCount} positions.`
            };
        })();
    }

    if (action === 'DISMISS_ALERT' && typeof alertId === 'number') {
        db.prepare('UPDATE activity_log SET dismissed = 1 WHERE id = ?').run(alertId);
        return { success: true, message: `Alert ${alertId} dismissed.` };
    }

    return { success: false, message: 'Invalid action.' };
}

export const fetchDashboardData = getDashboardOverview;
export type DashboardData = InstitutionalDashboardData;
export type MetricsSummary = MetricSummary;

export interface CandleDataPoint {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    emaFast?: number;
    emaSlow?: number;
}

export interface EngineReasoningItem {
    symbol: string;
    action: 'BUY' | 'SELL' | 'HOLD';
    direction: 'LONG' | 'SHORT' | null;
    isEntry: boolean;
    reason: string;
    trendStatus: 'trending' | 'choppy';
    trendWord: 'upward' | 'downward';
    momentumWord: string;
    currentPrice: number;
    currentAtr: number;
    currentRsi: number;
    currentAdx: number;
    hasActivePosition: boolean;
    activePositionSide?: 'LONG' | 'SHORT';
    activePositionPnl?: number;
}

export interface TradeWAccountMetrics {
    balance: number;
    equity: number;
    freeMargin: number;
    margin: number;
    marginLevel: number;
    leverage: number;
    currency: string;
    server: string;
    platform: string;
    activeCfdCount: number;
    connected: boolean;
    lastUpdated: number;
}

export interface ActivePositionRecord {
    symbol: string;
    side: 'LONG' | 'SHORT';
    amount: number;
    entryPrice: number;
    currentPrice: number;
    highestPrice: number;
    lowestPrice: number;
    trailingStop: number;
    stopDistance: number;
    stopDistancePercent: number;
    atr: number;
    pnl: number;
    pnlPercent: number;
    entryTime: number;
    holdingDuration: string;
    broker: string;
}

export interface TradeRecord {
    id: number;
    orderId: string;
    symbol: string;
    side: string;
    type: string;
    price: number;
    amount: number;
    fee: number;
    pnl: number;
    pnlPercent: number;
    timestamp: number;
    dateStr: string;
    status: 'WIN' | 'LOSS' | 'ENTRY';
    direction: 'LONG' | 'SHORT';
    executionMode: 'LIVE_FORWARD' | 'BACKTEST_MOCK';
    broker: string;
}

