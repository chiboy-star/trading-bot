const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../data/recorder.db'), { readonly: true });
const s = new Date('2026-10-24T21:50:00Z').getTime();
const e = new Date('2026-10-25T20:25:00Z').getTime();

const missingSymbols = db.prepare(`
    SELECT DISTINCT symbol 
    FROM contract_snapshots
    WHERE symbol NOT IN (
        SELECT DISTINCT symbol FROM klines_1m WHERE timestamp >= ? AND timestamp <= ?
    )
    ORDER BY symbol ASC
`).all(s, e);

console.log('Symbols completely missing klines in 1400m downtime:', missingSymbols.map(r => r.symbol));
console.log('Count:', missingSymbols.length);

// Also check symbols with partial klines (< 1300 bars) in downtime
const partialSymbols = db.prepare(`
    SELECT symbol, count(*) as cnt 
    FROM klines_1m 
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY symbol
    HAVING cnt < 1300
    ORDER BY cnt ASC
`).all(s, e);
console.log('Symbols with partial klines in downtime (<1300):', partialSymbols);

db.close();
