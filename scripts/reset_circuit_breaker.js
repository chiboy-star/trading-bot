const Database = require('better-sqlite3');
const path = require('path');

const args = process.argv.slice(2);
const isConfirmed = args.includes('--confirm');

if (!isConfirmed) {
    console.error('⚠️  WARNING: Resetting the circuit breaker clears 24h rolling loss records and lockout status.');
    console.error('To confirm and execute this operator reset, run:');
    console.error('   node scripts/reset_circuit_breaker.js --confirm\n');
    process.exit(1);
}

const dbPath = path.resolve(process.cwd(), 'data/market_data.db');
console.log(`Connecting to database at: ${dbPath}`);

const db = new Database(dbPath);

try {
    db.exec(`ALTER TABLE bot_state ADD COLUMN circuit_breaker_limit REAL DEFAULT 0.05;`);
} catch {
    // Column already exists
}

// 1. Clear daily losses rolling window (NEVER delete paper_trades or active_positions)
const deletedLosses = db.prepare('DELETE FROM daily_losses').run();

// 2. Disengage circuit breaker halt & lockout in bot_state while preserving realized capital
const now = Date.now();
db.prepare(`
    UPDATE bot_state
    SET circuit_breaker_halted = 0,
        lockout_until = 0,
        updated_at = ?
    WHERE id = 1
`).run(now);

// 3. Set system_state to RUNNING
const nowIso = new Date().toISOString();
db.prepare(`
    UPDATE system_state
    SET status = 'RUNNING',
        pending_command = 'NONE',
        error_component = NULL,
        status_changed_at = ?,
        last_heartbeat_at = ?
    WHERE id = 1
`).run(nowIso, nowIso);

// 4. Log audit event
try {
    db.prepare(`
        INSERT INTO activity_log (timestamp, type, message, cause, dismissed)
        VALUES (?, 'STATE_CHANGE', 'Circuit breaker reset executed by operator via CLI script', 'Operator ran reset_circuit_breaker.js --confirm', 0)
    `).run(nowIso);
} catch {}

console.log('✅ Circuit breaker halt disengaged and 24h loss cache cleared.');
console.log('⚠️  Trade history (paper_trades) and active positions were strictly preserved.');
console.log('Bot state:', db.prepare('SELECT id, capital, circuit_breaker_halted, lockout_until, circuit_breaker_limit FROM bot_state WHERE id = 1').get());
console.log('Daily losses purged:', deletedLosses.changes);

db.close();
