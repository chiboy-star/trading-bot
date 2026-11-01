const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/recorder.db');
const db = new Database(dbPath);

console.log('Inserting retroactive streams_lost gaps into recorder.db (INSERT ONLY, NO UPDATES OR DELETES)...');

const lastHeartbeat = db.prepare('SELECT timestamp FROM recorder_heartbeats ORDER BY timestamp DESC LIMIT 1').get();
if (!lastHeartbeat) {
    console.error('No heartbeats found in recorder.db!');
    process.exit(1);
}

const now = Date.now();
const outage1Start = new Date('2026-10-24T16:35:00.000Z').getTime(); // 1792859700000
const outage1End = new Date('2026-10-24T16:40:00.000Z').getTime();   // 1792860000000
const outage1Minutes = Math.round((outage1End - outage1Start) / 60000); // 5

const downtime2Start = lastHeartbeat.timestamp; // 1792878656316 (~21:50 UTC Oct 24)
const downtime2End = now;
const downtime2Minutes = Math.round((downtime2End - downtime2Start) / 60000);

const insertStmt = db.prepare(`
    INSERT INTO data_gaps (symbol, data_type, gap_start, gap_end, missing_count, detected_at, resolved_at, cause)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// Execute insert transaction (strictly append-only)
const info1 = insertStmt.run(
    'ALL',
    'streams_lost',
    outage1Start,
    outage1End,
    outage1Minutes,
    now,
    outage1End,
    'Outage 16:35-16:40 UTC Oct 24; streams_lost recorded ex-post (added after the fact)'
);

const info2 = insertStmt.run(
    'ALL',
    'streams_lost',
    downtime2Start,
    downtime2End,
    downtime2Minutes,
    now,
    null,
    `HTTP_403_BAN downtime from last stored heartbeat (${new Date(downtime2Start).toISOString()}); streams_lost recorded ex-post (added after the fact)`
);

console.log(`Inserted gap 1 (16:35-16:40 UTC Oct 24): row id ${info1.lastInsertRowid}`);
console.log(`Inserted gap 2 (downtime since ${new Date(downtime2Start).toISOString()}): row id ${info2.lastInsertRowid}`);

const rows = db.prepare('SELECT * FROM data_gaps WHERE id IN (?, ?)').all(info1.lastInsertRowid, info2.lastInsertRowid);
console.log('Verified inserted rows:\n', rows);
