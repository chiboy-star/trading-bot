const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../data/recorder.db'), { readonly: true });

const tStart = new Date('2026-10-27T10:25:00.000Z').getTime();
const tEnd = new Date('2026-10-27T10:40:00.000Z').getTime();

console.log('=== HEARTBEATS 10:25 - 10:40 UTC ===');
const hbs = db.prepare(`
    SELECT timestamp, datetime(timestamp/1000, 'unixepoch') as iso, active_symbols_count, status, details
    FROM recorder_heartbeats
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
`).all(tStart, tEnd);
console.log(JSON.stringify(hbs, null, 2));

console.log('=== LISTINGS DETECTED 10:25 - 10:40 UTC ===');
const listings = db.prepare(`
    SELECT id, symbol, event_type, datetime(detected_at/1000, 'unixepoch') as det_iso, details
    FROM listing_events
    WHERE detected_at >= ? AND detected_at <= ?
`).all(tStart, tEnd);
console.log(JSON.stringify(listings, null, 2));

console.log('=== SNAPSHOTS 10:25 - 10:40 UTC ===');
const snapshots = db.prepare(`
    SELECT snapshot_timestamp, datetime(snapshot_timestamp/1000, 'unixepoch') as iso, count(*) as cnt
    FROM contract_snapshots
    WHERE snapshot_timestamp >= ? AND snapshot_timestamp <= ?
    GROUP BY snapshot_timestamp
`).all(tStart, tEnd);
console.log(JSON.stringify(snapshots, null, 2));

// Check data_gaps detected around 10:35
const gapSummary = db.prepare(`
    SELECT data_type, count(*), min(datetime(gap_start/1000, 'unixepoch')) as min_start, max(datetime(gap_end/1000, 'unixepoch')) as max_end, cause
    FROM data_gaps
    WHERE detected_at >= ? AND detected_at <= ?
    GROUP BY data_type, cause
`).all(tStart, tEnd);
console.log('=== GAP SUMMARY ===');
console.log(JSON.stringify(gapSummary, null, 2));

db.close();
