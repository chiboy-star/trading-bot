const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/market_data.db');
const db = new Database(dbPath);

const cols = db.prepare('PRAGMA table_info(paper_trades)').all().map(c => c.name);
if (!cols.includes('execution_mode')) {
    db.exec("ALTER TABLE paper_trades ADD COLUMN execution_mode TEXT DEFAULT 'LIVE_FORWARD';");
    console.log('Added execution_mode column');
} else {
    console.log('execution_mode column already exists');
}

const updateResult = db.prepare("UPDATE paper_trades SET execution_mode = 'BACKTEST_MOCK'").run();
console.log('Updated existing rows count:', updateResult.changes);

const countLive = db.prepare("SELECT count(*) as count FROM paper_trades WHERE execution_mode = 'LIVE_FORWARD'").get();
const countMock = db.prepare("SELECT count(*) as count FROM paper_trades WHERE execution_mode = 'BACKTEST_MOCK'").get();
console.log('Live Forward count:', countLive.count);
console.log('Backtest Mock count:', countMock.count);

const sample = db.prepare("SELECT id, order_id, symbol, side, execution_mode FROM paper_trades LIMIT 3").all();
console.log('Sample rows:', sample);
