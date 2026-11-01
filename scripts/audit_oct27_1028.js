const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../data/recorder.db'), { readonly: true });

const tStart = new Date('2026-10-27T10:20:00.000Z').getTime();
const tEnd = new Date('2026-10-27T10:45:00.000Z').getTime();

console.log('=== HEARTBEATS 10:20 - 10:45 UTC ===');
const heartbeats = db.prepare(`
    SELECT timestamp, datetime(timestamp/1000, 'unixepoch') as iso, active_symbols_count, status, last_data_timestamp, details
    FROM recorder_heartbeats
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
`).all(tStart, tEnd);
console.log(JSON.stringify(heartbeats, null, 2));

console.log('=== DATA GAPS 10:20 - 10:45 UTC ===');
const gaps = db.prepare(`
    SELECT id, symbol, data_type, datetime(gap_start/1000, 'unixepoch') as start_iso, datetime(gap_end/1000, 'unixepoch') as end_iso, missing_count, datetime(detected_at/1000, 'unixepoch') as det_iso, cause
    FROM data_gaps
    WHERE (gap_start <= ? AND gap_end >= ?) OR (detected_at >= ? AND detected_at <= ?)
`).all(tEnd, tStart, tStart, tEnd);
console.log(JSON.stringify(gaps, null, 2));

console.log('=== KLINE COUNT PER MINUTE 10:20 - 10:40 UTC ===');
const klineCounts = db.prepare(`
    SELECT timestamp, datetime(timestamp/1000, 'unixepoch') as iso, count(*) as cnt
    FROM klines_1m
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY timestamp
    ORDER BY timestamp ASC
`).all(tStart, tEnd);
console.log(JSON.stringify(klineCounts, null, 2));

console.log('=== REST METRICS 10:20 - 10:45 UTC ===');
try {
    const metrics = db.prepare(`
        SELECT window_5s, datetime(window_5s/1000, 'unixepoch') as iso, endpoint, request_count, errors_10006, errors_429, success_count
        FROM rest_request_metrics
        WHERE window_5s >= ? AND window_5s <= ?
        ORDER BY window_5s ASC
    `).all(tStart, tEnd);
    console.log('Metrics count:', metrics.length);
    console.log(JSON.stringify(metrics.slice(0, 20), null, 2));
} catch (e) {
    console.log('Metrics error:', e.message);
}

db.close();
