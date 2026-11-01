import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../utils/logger';

const log = createLogger('db');

let canonicalDbPath: string | null = null;

export function getCanonicalDbPath(): string {
    if (canonicalDbPath) return canonicalDbPath;

    const candidates = [
        path.resolve(process.cwd(), 'data/market_data.db'),
        path.resolve(process.cwd(), '../data/market_data.db'),
        path.resolve(__dirname, '../../data/market_data.db'),
        path.resolve(__dirname, '../../../data/market_data.db')
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            canonicalDbPath = p;
            return canonicalDbPath;
        }
    }

    const defaultPath = path.resolve(process.cwd(), 'data/market_data.db');
    const dir = path.dirname(defaultPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    canonicalDbPath = defaultPath;
    return canonicalDbPath;
}

let dbInstance: Database.Database | null = null;

export function getDatabase(options: { readonly?: boolean } = {}): Database.Database {
    if (dbInstance && (!options.readonly || dbInstance.readonly)) {
        return dbInstance;
    }

    const dbPath = getCanonicalDbPath();
    dbInstance = new Database(dbPath, { readonly: options.readonly ?? false });

    // Enable WAL mode & performance pragmas for write-enabled connections
    if (!options.readonly) {
        try {
            dbInstance.pragma('journal_mode = WAL');
            dbInstance.pragma('synchronous = NORMAL');
            dbInstance.pragma('busy_timeout = 5000');
        } catch (err) {
            log.warn({ err }, 'Could not set SQLite WAL pragmas');
        }
        initSchema(dbInstance);
    }

    return dbInstance;
}

export const db = getDatabase();

function initSchema(database: Database.Database): void {
    // 1. Create base tables
    database.exec(`
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

        CREATE TABLE IF NOT EXISTS daily_losses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            amount REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tradew_account (
            id INTEGER PRIMARY KEY,
            balance REAL NOT NULL,
            equity REAL NOT NULL,
            free_margin REAL NOT NULL,
            margin REAL DEFAULT 0,
            margin_level REAL DEFAULT 0,
            leverage INTEGER DEFAULT 100,
            currency TEXT DEFAULT 'USD',
            server TEXT DEFAULT 'TradeW-MT5Live',
            platform TEXT DEFAULT 'MT5',
            active_cfd_count INTEGER DEFAULT 0,
            connected INTEGER DEFAULT 0,
            updated_at INTEGER NOT NULL
        );

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

    // Ensure system_state has initial row
    const row = database.prepare("SELECT id FROM system_state WHERE id = 1").get();
    if (!row) {
        const nowIso = new Date().toISOString();
        database.prepare(`
            INSERT INTO system_state (id, status, status_changed_at, last_heartbeat_at, error_component, pending_command)
            VALUES (1, 'RUNNING', ?, ?, NULL, 'NONE')
        `).run(nowIso, nowIso);
    }

    // 2. Safe Auto-Migration for paper_trades columns
    try {
        const tradeCols = database.prepare("PRAGMA table_info(paper_trades)").all() as { name: string }[];
        const colNames = new Set(tradeCols.map(c => c.name));
        if (!colNames.has('pnl')) database.exec("ALTER TABLE paper_trades ADD COLUMN pnl REAL DEFAULT 0;");
        if (!colNames.has('pnl_percent')) database.exec("ALTER TABLE paper_trades ADD COLUMN pnl_percent REAL DEFAULT 0;");
        if (!colNames.has('direction')) database.exec("ALTER TABLE paper_trades ADD COLUMN direction TEXT DEFAULT 'LONG';");
        if (!colNames.has('execution_mode')) database.exec("ALTER TABLE paper_trades ADD COLUMN execution_mode TEXT DEFAULT 'LIVE_FORWARD';");
        if (!colNames.has('broker')) database.exec("ALTER TABLE paper_trades ADD COLUMN broker TEXT DEFAULT 'BYBIT';");
        if (!colNames.has('setup_type')) database.exec("ALTER TABLE paper_trades ADD COLUMN setup_type TEXT DEFAULT 'EMA_CROSSOVER';");
        if (!colNames.has('signal_price')) database.exec("ALTER TABLE paper_trades ADD COLUMN signal_price REAL DEFAULT NULL;");
        if (!colNames.has('fill_price')) database.exec("ALTER TABLE paper_trades ADD COLUMN fill_price REAL DEFAULT NULL;");
        if (!colNames.has('slippage')) database.exec("ALTER TABLE paper_trades ADD COLUMN slippage REAL DEFAULT 0;");
        if (!colNames.has('funding_pnl')) database.exec("ALTER TABLE paper_trades ADD COLUMN funding_pnl REAL DEFAULT 0;");
    } catch (e) {
        log.warn({ e }, 'Safe column migration check for paper_trades had warning');
    }

    // 3. Safe Auto-Migration for active_positions: Composite Primary Key (symbol, broker)
    try {
        const tableExists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='active_positions'").get();
        if (!tableExists) {
            database.exec(`
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
                    PRIMARY KEY (symbol, broker)
                );
            `);
            log.info('Initialized active_positions table with composite primary key (symbol, broker)');
        } else {
            const posCols = database.prepare("PRAGMA table_info(active_positions)").all() as { name: string; pk: number }[];
            const colNames = new Set(posCols.map(c => c.name));
            if (!colNames.has('lowest_price')) {
                database.exec("ALTER TABLE active_positions ADD COLUMN lowest_price REAL DEFAULT 0;");
            }
            if (!colNames.has('broker')) {
                database.exec("ALTER TABLE active_positions ADD COLUMN broker TEXT DEFAULT 'BYBIT';");
            }
            if (!colNames.has('setup_type')) {
                database.exec("ALTER TABLE active_positions ADD COLUMN setup_type TEXT DEFAULT 'EMA_CROSSOVER';");
            }
            if (!colNames.has('signal_price')) {
                database.exec("ALTER TABLE active_positions ADD COLUMN signal_price REAL DEFAULT NULL;");
            }
            if (!colNames.has('accumulated_funding')) {
                database.exec("ALTER TABLE active_positions ADD COLUMN accumulated_funding REAL DEFAULT 0;");
            }

            const pkCols = posCols.filter(c => c.pk > 0).map(c => c.name);
            const isCompositePk = pkCols.includes('symbol') && pkCols.includes('broker') && pkCols.length === 2;

            if (!isCompositePk) {
                log.info('Migrating active_positions to composite primary key (symbol, broker)...');
                database.transaction(() => {
                    database.exec(`
                        CREATE TABLE IF NOT EXISTS active_positions_v2 (
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

                        INSERT OR IGNORE INTO active_positions_v2 (
                            symbol, broker, side, amount, entry_price, current_price, highest_price,
                            lowest_price, trailing_stop, atr, pnl, pnl_percent, entry_time, updated_at
                        )
                        SELECT
                            symbol,
                            COALESCE(broker, 'BYBIT'),
                            COALESCE(side, 'LONG'),
                            amount,
                            entry_price,
                            current_price,
                            highest_price,
                            COALESCE(lowest_price, 0),
                            trailing_stop,
                            atr,
                            COALESCE(pnl, 0),
                            COALESCE(pnl_percent, 0),
                            entry_time,
                            updated_at
                        FROM active_positions;

                        DROP TABLE active_positions;
                        ALTER TABLE active_positions_v2 RENAME TO active_positions;
                    `);
                })();
                log.info('Successfully migrated active_positions to composite primary key (symbol, broker)');
            }
        }
    } catch (err) {
        log.error({ err }, 'Error checking/migrating active_positions schema');
    }

    // 4. Safe Auto-Migration for monitored_pairs columns
    try {
        const pairCols = database.prepare("PRAGMA table_info(monitored_pairs)").all() as { name: string }[];
        const colNames = new Set(pairCols.map(c => c.name));
        if (!colNames.has('intraday_adx')) database.exec("ALTER TABLE monitored_pairs ADD COLUMN intraday_adx REAL DEFAULT 0;");
        if (!colNames.has('composite_score')) database.exec("ALTER TABLE monitored_pairs ADD COLUMN composite_score REAL DEFAULT 0;");
        if (!colNames.has('tier')) database.exec("ALTER TABLE monitored_pairs ADD COLUMN tier TEXT DEFAULT 'CORE';");
    } catch (e) {
        log.warn({ e }, 'Safe column migration check for monitored_pairs had warning');
    }

    // 5. Safe Auto-Migration for monitored_market_state columns
    try {
        const marketCols = database.prepare("PRAGMA table_info(monitored_market_state)").all() as { name: string }[];
        const colNames = new Set(marketCols.map(c => c.name));
        if (!colNames.has('tier')) database.exec("ALTER TABLE monitored_market_state ADD COLUMN tier TEXT DEFAULT 'CORE';");
    } catch (e) {
        log.warn({ e }, 'Safe column migration check for monitored_market_state had warning');
    }

    // 6. Safe Auto-Migration for bot_state columns
    try {
        const botCols = database.prepare("PRAGMA table_info(bot_state)").all() as { name: string }[];
        const colNames = new Set(botCols.map(c => c.name));
        if (!colNames.has('circuit_breaker_limit')) database.exec("ALTER TABLE bot_state ADD COLUMN circuit_breaker_limit REAL DEFAULT 0.05;");
    } catch (e) {
        log.warn({ e }, 'Safe column migration check for bot_state had warning');
    }
}

// -------------------------------------------------------------
// System State & Operator Control Bridge
// -------------------------------------------------------------

export type SystemStatus = 'RUNNING' | 'PAUSED' | 'ERROR';
export type PendingCommand = 'NONE' | 'PAUSE' | 'RESUME' | 'KILL_SWITCH';
export type ActivityType = 'STATE_CHANGE' | 'ALERT' | 'ORDER' | 'ERROR';

export interface SystemStateRecord {
    id: number;
    status: SystemStatus;
    status_changed_at: string;
    last_heartbeat_at: string;
    error_component: string | null;
    pending_command: PendingCommand;
}

export interface ActivityLogRecord {
    id: number;
    timestamp: string;
    type: ActivityType;
    message: string;
    cause: string | null;
    dismissed: number;
}

export function updateHeartbeat(database: Database.Database = db): void {
    const nowIso = new Date().toISOString();
    database.prepare(`
        UPDATE system_state
        SET last_heartbeat_at = ?
        WHERE id = 1
    `).run(nowIso);
}

export function getSystemState(database: Database.Database = db): SystemStateRecord {
    const state = database.prepare("SELECT * FROM system_state WHERE id = 1").get() as SystemStateRecord | undefined;
    if (!state) {
        const nowIso = new Date().toISOString();
        database.prepare(`
            INSERT INTO system_state (id, status, status_changed_at, last_heartbeat_at, error_component, pending_command)
            VALUES (1, 'RUNNING', ?, ?, NULL, 'NONE')
        `).run(nowIso, nowIso);
        return {
            id: 1,
            status: 'RUNNING',
            status_changed_at: nowIso,
            last_heartbeat_at: nowIso,
            error_component: null,
            pending_command: 'NONE'
        };
    }
    return state;
}

export function setSystemStatus(
    status: SystemStatus,
    errorComponent: string | null = null,
    cause?: string,
    database: Database.Database = db
): void {
    const nowIso = new Date().toISOString();
    database.prepare(`
        UPDATE system_state
        SET status = ?,
            status_changed_at = ?,
            error_component = ?,
            last_heartbeat_at = ?
        WHERE id = 1
    `).run(status, nowIso, errorComponent, nowIso);

    logActivity('STATE_CHANGE', `System status transitioned to ${status}`, cause, database);
}

export function setPendingCommand(command: PendingCommand, database: Database.Database = db): void {
    database.prepare(`
        UPDATE system_state
        SET pending_command = ?
        WHERE id = 1
    `).run(command);
}

export function clearPendingCommand(database: Database.Database = db): void {
    database.prepare(`
        UPDATE system_state
        SET pending_command = 'NONE'
        WHERE id = 1
    `).run();
}

export function logActivity(
    type: ActivityType,
    message: string,
    cause?: string | null,
    database: Database.Database = db
): number {
    const nowIso = new Date().toISOString();
    const result = database.prepare(`
        INSERT INTO activity_log (timestamp, type, message, cause, dismissed)
        VALUES (?, ?, ?, ?, 0)
    `).run(nowIso, type, message, cause || null);

    return Number(result.lastInsertRowid);
}

export function getActiveAlerts(database: Database.Database = db): ActivityLogRecord[] {
    return database.prepare(`
        SELECT * FROM activity_log
        WHERE dismissed = 0 AND (type = 'ALERT' OR type = 'ERROR')
        ORDER BY id DESC
    `).all() as ActivityLogRecord[];
}

export function dismissAlert(alertId: number, database: Database.Database = db): boolean {
    const res = database.prepare(`
        UPDATE activity_log
        SET dismissed = 1
        WHERE id = ?
    `).run(alertId);
    return res.changes > 0;
}

export function marketClosePositions(broker?: string, database: Database.Database = db): { closedCount: number; totalRealizedPnl: number } {
    return database.transaction(() => {
        const query = broker
            ? database.prepare("SELECT * FROM active_positions WHERE broker = ?")
            : database.prepare("SELECT * FROM active_positions");
        const positions = (broker ? query.all(broker) : query.all()) as any[];

        let closedCount = 0;
        let totalRealizedPnl = 0;
        const now = Date.now();

        const insertTradeStmt = database.prepare(`
            INSERT INTO paper_trades (order_id, symbol, side, type, price, amount, fee, pnl, pnl_percent, timestamp, direction, execution_mode, broker, setup_type)
            VALUES (?, ?, ?, 'KILL_SWITCH', ?, ?, ?, ?, ?, ?, ?, 'LIVE_FORWARD', ?, ?)
        `);

        for (const pos of positions) {
            const exitPrice = pos.current_price;
            const notional = pos.amount * exitPrice;
            const fee = notional * 0.00075;
            let rawPnl = 0;
            if (pos.side === 'SHORT') {
                rawPnl = (pos.entry_price - exitPrice) * pos.amount;
            } else {
                rawPnl = (exitPrice - pos.entry_price) * pos.amount;
            }
            const netPnl = rawPnl - fee;
            const pnlPercent = (netPnl / (pos.amount * pos.entry_price)) * 100;
            const closeSide = pos.side === 'SHORT' ? 'BUY' : 'SELL';
            const orderId = `KS-${pos.symbol.replace(/[^A-Za-z0-9]/g, '')}-${Date.now().toString().slice(-4)}`;

            insertTradeStmt.run(
                orderId,
                pos.symbol,
                closeSide,
                exitPrice,
                pos.amount,
                fee,
                netPnl,
                pnlPercent,
                now,
                pos.side,
                pos.broker || 'BYBIT',
                pos.setup_type || 'EMA_CROSSOVER'
            );

            totalRealizedPnl += netPnl;
            closedCount++;
        }

        if (broker) {
            database.prepare("DELETE FROM active_positions WHERE broker = ?").run(broker);
        } else {
            database.prepare("DELETE FROM active_positions").run();
        }

        // Set status to PAUSED and reset pending command
        const nowIso = new Date().toISOString();
        database.prepare(`
            UPDATE system_state
            SET status = 'PAUSED',
                status_changed_at = ?,
                pending_command = 'NONE',
                last_heartbeat_at = ?
            WHERE id = 1
        `).run(nowIso, nowIso);

        logActivity(
            'STATE_CHANGE',
            `Kill switch executed: closed ${closedCount} open positions with realized P&L $${totalRealizedPnl.toFixed(2)}`,
            'Kill switch executed by operator',
            database
        );

        return { closedCount, totalRealizedPnl };
    })();
}

// -------------------------------------------------------------
// Account Equity & Buying Power Accounting (Perpetual Margin)
// -------------------------------------------------------------

export interface AccountEquitySummary {
    initialCapital: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalEquity: number;
    marginUsed: number;
    availableBuyingPower: number;
    leverage: number;
}

export function calculateAccountEquity(
    database: Database.Database = db,
    leverage: number = 10,
    broker: string = 'BYBIT'
): AccountEquitySummary {
    let initialCapital = 10000;
    try {
        const botStateRow = database.prepare('SELECT initial_capital FROM bot_state WHERE id = 1').get() as any;
        if (botStateRow && botStateRow.initial_capital) {
            initialCapital = Number(botStateRow.initial_capital);
        }
    } catch {}

    let realizedPnl = 0;
    try {
        const pnlRow = database.prepare("SELECT COALESCE(SUM(pnl), 0) as totalPnl FROM paper_trades WHERE type != 'ENTRY'").get() as any;
        realizedPnl = Number(pnlRow?.totalPnl || 0);
    } catch {}

    let totalPositionsNotional = 0;
    let unrealizedPnl = 0;
    try {
        const positions = database.prepare("SELECT side, amount, entry_price, current_price FROM active_positions WHERE broker = ?").all(broker) as any[];
        for (const p of positions) {
            const amount = Number(p.amount);
            const entryPrice = Number(p.entry_price);
            const currentPrice = Number(p.current_price || entryPrice);
            const notional = amount * currentPrice;
            totalPositionsNotional += notional;

            const fee = notional * 0.00075;
            let pnl = p.side === 'SHORT'
                ? (entryPrice - currentPrice) * amount
                : (currentPrice - entryPrice) * amount;
            pnl -= fee;
            unrealizedPnl += pnl;
        }
    } catch {}

    const marginUsed = totalPositionsNotional / leverage;
    const availableBuyingPower = initialCapital + realizedPnl - marginUsed;
    const totalEquity = initialCapital + realizedPnl + unrealizedPnl;

    return {
        initialCapital,
        realizedPnl,
        unrealizedPnl,
        totalEquity,
        marginUsed,
        availableBuyingPower,
        leverage
    };
}

// -------------------------------------------------------------
// Live Monitored Market State
// -------------------------------------------------------------

export interface MonitoredMarketStateRecord {
    symbol: string;
    price: number;
    change_24h: number;
    ema20: number;
    ema50: number;
    rsi14: number;
    adx14: number;
    signal_proximity: string;
    updated_at: number;
    tier?: 'CORE' | 'SATELLITE';
}

export function upsertMonitoredMarketState(
    state: Omit<MonitoredMarketStateRecord, 'updated_at'> & { updated_at?: number },
    database: Database.Database = db
): void {
    const updatedAt = state.updated_at ?? Date.now();
    const tier = state.tier || 'CORE';
    database.prepare(`
        INSERT INTO monitored_market_state (symbol, price, change_24h, ema20, ema50, rsi14, adx14, signal_proximity, updated_at, tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
            price = excluded.price,
            change_24h = excluded.change_24h,
            ema20 = excluded.ema20,
            ema50 = excluded.ema50,
            rsi14 = excluded.rsi14,
            adx14 = excluded.adx14,
            signal_proximity = excluded.signal_proximity,
            updated_at = excluded.updated_at,
            tier = excluded.tier
    `).run(
        state.symbol,
        state.price,
        state.change_24h,
        state.ema20,
        state.ema50,
        state.rsi14,
        state.adx14,
        state.signal_proximity,
        updatedAt,
        tier
    );
}

export function getMonitoredMarketStates(database: Database.Database = db): MonitoredMarketStateRecord[] {
    return database.prepare("SELECT * FROM monitored_market_state ORDER BY symbol ASC").all() as MonitoredMarketStateRecord[];
}

// -------------------------------------------------------------
// Adaptive Strategy Performance
// -------------------------------------------------------------

export interface StrategyPerformanceRecord {
    setup_type: string;
    symbol: string;
    trades_count: number;
    wins_count: number;
    losses_count: number;
    win_rate: number;
    expectancy: number;
    risk_multiplier: number;
    last_adjusted_at: number;
}

export function getStrategyPerformance(setupType?: string, symbol?: string, database: Database.Database = db): StrategyPerformanceRecord[] {
    if (setupType && symbol) {
        return database.prepare("SELECT * FROM strategy_performance WHERE setup_type = ? AND symbol = ?").all(setupType, symbol) as StrategyPerformanceRecord[];
    } else if (setupType) {
        return database.prepare("SELECT * FROM strategy_performance WHERE setup_type = ?").all(setupType) as StrategyPerformanceRecord[];
    }
    return database.prepare("SELECT * FROM strategy_performance ORDER BY setup_type ASC, symbol ASC").all() as StrategyPerformanceRecord[];
}

export function upsertStrategyPerformance(
    record: StrategyPerformanceRecord,
    database: Database.Database = db
): void {
    database.prepare(`
        INSERT INTO strategy_performance (setup_type, symbol, trades_count, wins_count, losses_count, win_rate, expectancy, risk_multiplier, last_adjusted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(setup_type, symbol) DO UPDATE SET
            trades_count = excluded.trades_count,
            wins_count = excluded.wins_count,
            losses_count = excluded.losses_count,
            win_rate = excluded.win_rate,
            expectancy = excluded.expectancy,
            risk_multiplier = excluded.risk_multiplier,
            last_adjusted_at = excluded.last_adjusted_at
    `).run(
        record.setup_type,
        record.symbol,
        record.trades_count,
        record.wins_count,
        record.losses_count,
        record.win_rate,
        record.expectancy,
        record.risk_multiplier,
        record.last_adjusted_at
    );
}

// -------------------------------------------------------------
// FX Rate Store
// -------------------------------------------------------------

export function getFxRate(pair: string = 'USDT_NGN', database: Database.Database = db): { pair: string; rate: number; updated_at: number } | null {
    const row = database.prepare("SELECT * FROM fx_rates WHERE pair = ?").get(pair) as { pair: string; rate: number; updated_at: number } | undefined;
    return row || null;
}

export function setFxRate(pair: string, rate: number, database: Database.Database = db): void {
    const now = Date.now();
    database.prepare(`
        INSERT INTO fx_rates (pair, rate, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(pair) DO UPDATE SET
            rate = excluded.rate,
            updated_at = excluded.updated_at
    `).run(pair, rate, now);
}

export function closeDb(): void {
    if (dbInstance) {
        try {
            log.info('Flushing and closing SQLite connection cleanly...');
            dbInstance.close();
            dbInstance = null;
        } catch (err) {
            log.error({ err }, 'Error closing database connection');
        }
    }
}

export default db;
