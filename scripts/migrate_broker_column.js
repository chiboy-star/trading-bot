const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/market_data.db');
const db = new Database(dbPath);

console.log('Running database migration for broker column and Trade W MT4/MT5 support...');

// 1. Migrate paper_trades
const tradeCols = db.prepare('PRAGMA table_info(paper_trades)').all().map(c => c.name);
if (!tradeCols.includes('broker')) {
    db.exec("ALTER TABLE paper_trades ADD COLUMN broker TEXT DEFAULT 'BYBIT';");
    console.log('[OK] Added broker column to paper_trades');
} else {
    console.log('[INFO] broker column already exists in paper_trades');
}

// Ensure existing trades default to BYBIT
const updateTrades = db.prepare("UPDATE paper_trades SET broker = 'BYBIT' WHERE broker IS NULL OR broker = ''").run();
console.log(`[OK] Updated ${updateTrades.changes} existing paper_trades to broker = 'BYBIT'`);

// 2. Migrate active_positions
const posCols = db.prepare('PRAGMA table_info(active_positions)').all().map(c => c.name);
if (!posCols.includes('broker')) {
    db.exec("ALTER TABLE active_positions ADD COLUMN broker TEXT DEFAULT 'BYBIT';");
    console.log('[OK] Added broker column to active_positions');
} else {
    console.log('[INFO] broker column already exists in active_positions');
}

// 3. Create tradew_account table for MT4/MT5 metrics
db.exec(`
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
        connected INTEGER DEFAULT 1,
        updated_at INTEGER NOT NULL
    );
`);
console.log('[OK] Ensured tradew_account table exists');

// Seed default initial MT4/MT5 state if not existing
const existingAccount = db.prepare('SELECT id FROM tradew_account WHERE id = 1').get();
if (!existingAccount) {
    db.prepare(`
        INSERT INTO tradew_account (id, balance, equity, free_margin, margin, margin_level, leverage, currency, server, platform, active_cfd_count, connected, updated_at)
        VALUES (1, 10000.00, 10000.00, 10000.00, 0.00, 0.00, 100, 'USD', 'TradeW-MT5Live', 'MT5', 0, 1, ?)
    `).run(Date.now());
    console.log('[OK] Seeded initial tradew_account state ($10,000 USD balance, 1:100 leverage)');
}

// Verification
const tradeCount = db.prepare('SELECT count(*) as count, broker FROM paper_trades GROUP BY broker').all();
console.log('Trade counts by broker:', tradeCount);
console.log('Migration completed successfully.');
