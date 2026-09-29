import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function getCanonicalDbPath(): string {
    const rootPath = path.resolve(process.cwd(), 'data/market_data.db');
    if (fs.existsSync(rootPath)) return rootPath;
    const parentPath = path.resolve(process.cwd(), '../data/market_data.db');
    if (fs.existsSync(parentPath)) return parentPath;
    return path.resolve(__dirname, '../../data/market_data.db');
}

export const db = new Database(getCanonicalDbPath());

// Schema definition ensuring execution_mode and broker columns exist
db.exec(`
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
        broker TEXT DEFAULT 'OANDA'
    );
`);

try {
    const cols = db.prepare("PRAGMA table_info(paper_trades)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    if (!colNames.includes('broker')) {
        db.exec("ALTER TABLE paper_trades ADD COLUMN broker TEXT DEFAULT 'OANDA';");
    }
} catch (e) {}

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
    console.log(`[FOREX ${executionMode} ${broker}] Logged ${direction} trade on ${symbol}: ${side} ${type} @ ${price}`);
}
