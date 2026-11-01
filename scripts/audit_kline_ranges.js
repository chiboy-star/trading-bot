const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../data/recorder.db'), { readonly: true });

function findMissingRanges(symbol) {
    const rows = db.prepare(`
        SELECT timestamp FROM klines_1m WHERE symbol = ? ORDER BY timestamp ASC
    `).all(symbol);

    if (rows.length === 0) return { symbol, firstBar: null, lastBar: null, totalStored: 0, missingRanges: [] };

    const firstBar = rows[0].timestamp;
    const lastBar = rows[rows.length - 1].timestamp;
    const timestamps = new Set(rows.map(r => r.timestamp));

    const missingRanges = [];
    let currentStart = null;
    let prevMissing = null;

    for (let t = firstBar; t <= lastBar; t += 60000) {
        if (!timestamps.has(t)) {
            if (currentStart === null) {
                currentStart = t;
            }
            prevMissing = t;
        } else {
            if (currentStart !== null) {
                missingRanges.push({
                    startTs: currentStart,
                    endTs: prevMissing,
                    startIso: new Date(currentStart).toISOString(),
                    endIso: new Date(prevMissing).toISOString(),
                    durationMinutes: Math.round((prevMissing - currentStart) / 60000) + 1
                });
                currentStart = null;
                prevMissing = null;
            }
        }
    }

    if (currentStart !== null) {
        missingRanges.push({
            startTs: currentStart,
            endTs: prevMissing,
            startIso: new Date(currentStart).toISOString(),
            endIso: new Date(prevMissing).toISOString(),
            durationMinutes: Math.round((prevMissing - currentStart) / 60000) + 1
        });
    }

    return {
        symbol,
        firstBar: new Date(firstBar).toISOString(),
        lastBar: new Date(lastBar).toISOString(),
        totalStored: rows.length,
        expectedBars: Math.round((lastBar - firstBar) / 60000) + 1,
        missingRanges
    };
}

console.log('=== BTCUSDT ===');
console.log(JSON.stringify(findMissingRanges('BTCUSDT'), null, 2));

console.log('=== ETHUSDT ===');
console.log(JSON.stringify(findMissingRanges('ETHUSDT'), null, 2));

console.log('=== 1000PEPEUSDT ===');
console.log(JSON.stringify(findMissingRanges('1000PEPEUSDT'), null, 2));

// Check distribution of total stored counts across all symbols
const countDist = db.prepare(`
    SELECT cnt, count(*) as symbol_count
    FROM (
        SELECT symbol, count(*) as cnt FROM klines_1m GROUP BY symbol
    )
    GROUP BY cnt
    ORDER BY symbol_count DESC
    LIMIT 15
`).all();
console.log('=== STORED BAR COUNT CLUSTERS ACROSS ALL SYMBOLS ===');
console.log(JSON.stringify(countDist, null, 2));

db.close();
