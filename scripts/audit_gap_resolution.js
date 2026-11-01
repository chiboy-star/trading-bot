const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../data/recorder.db'), { readonly: true });

const tStart = new Date('2026-10-27T10:25:00.000Z').getTime();
const tEnd = new Date('2026-10-27T10:40:00.000Z').getTime();

const gapSample = db.prepare(`
    SELECT id, symbol, data_type, datetime(gap_start/1000, 'unixepoch') as start_iso, datetime(gap_end/1000, 'unixepoch') as end_iso, missing_count, resolved_at, cause
    FROM data_gaps
    WHERE detected_at >= ? AND detected_at <= ? AND data_type = 'kline_1m'
    LIMIT 20
`).all(tStart, tEnd);
console.log('Sample gaps:', JSON.stringify(gapSample, null, 2));

const resolvedStats = db.prepare(`
    SELECT count(*) as total, count(resolved_at) as resolved, count(*) - count(resolved_at) as open
    FROM data_gaps
    WHERE detected_at >= ? AND detected_at <= ? AND data_type = 'kline_1m'
`).get(tStart, tEnd);
console.log('Resolved stats:', JSON.stringify(resolvedStats, null, 2));

// Check klines table around 10:28 - 10:35 for BTCUSDT, ETHUSDT, and a few sample symbols from gapSample
const sampleSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', gapSample[0].symbol, gapSample[1].symbol];
for (const s of sampleSymbols) {
    const bars = db.prepare(`
        SELECT datetime(timestamp/1000, 'unixepoch') as iso, open, high, low, close, volume
        FROM klines_1m
        WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
    `).all(s, new Date('2026-10-27T10:25:00.000Z').getTime(), new Date('2026-10-27T10:38:00.000Z').getTime());
    console.log(`Bars for ${s}:`, bars.length, 'bars');
}

db.close();
