import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'data/market_data.db');
console.log(`Connecting to database at: ${dbPath}`);

const db = new Database(dbPath);

try {
    db.exec(`ALTER TABLE bot_state ADD COLUMN circuit_breaker_limit REAL DEFAULT 0.05;`);
} catch {
    // Column already exists
}

// 1. Wipe daily losses and past trade caches
db.prepare('DELETE FROM daily_losses').run();
db.prepare('DELETE FROM active_positions').run();
db.prepare('DELETE FROM paper_trades').run();

// 2. Reset bot_state to $10,000 clean slate and disengage circuit breaker
const now = Date.now();
db.prepare(`
    UPDATE bot_state
    SET capital = 10000,
        initial_capital = 10000,
        circuit_breaker_halted = 0,
        lockout_until = 0,
        circuit_breaker_limit = 0.05,
        updated_at = ?
    WHERE id = 1
`).run(now);

// 3. Ensure system_state is RUNNING and pending_command cleared
db.prepare(`
    UPDATE system_state
    SET status = 'RUNNING',
        pending_command = 'NONE',
        error_component = NULL
    WHERE id = 1
`).run();

console.log('✅ Equity history & 24h drawdown caches successfully reset.');
console.log('Bot state:', db.prepare('SELECT * FROM bot_state WHERE id = 1').get());
console.log('System state:', db.prepare('SELECT * FROM system_state WHERE id = 1').get());
console.log('Daily losses count:', db.prepare('SELECT count(*) as count FROM daily_losses').get());

db.close();
