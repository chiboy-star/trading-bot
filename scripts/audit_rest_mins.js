const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../data/recorder.db'), { readonly: true });

const tStart = new Date('2026-10-27T10:27:00.000Z').getTime();
const tEnd = new Date('2026-10-27T10:37:00.000Z').getTime();

const reqs = db.prepare(`
    SELECT window_5s, datetime(window_5s/1000, 'unixepoch') as iso, endpoint, request_count, errors_10006, errors_429, success_count
    FROM rest_request_metrics
    WHERE window_5s >= ? AND window_5s <= ?
    ORDER BY window_5s ASC
`).all(tStart, tEnd);

// Group by minute
const byMin = {};
for (const r of reqs) {
    const min = r.iso.slice(0, 16);
    if (!byMin[min]) byMin[min] = { total: 0, kline: 0, tickers: 0, snap: 0, err10006: 0, err429: 0 };
    byMin[min].total += r.request_count;
    if (r.endpoint.includes('kline')) byMin[min].kline += r.request_count;
    if (r.endpoint.includes('ticker')) byMin[min].tickers += r.request_count;
    if (r.endpoint.includes('instrument')) byMin[min].snap += r.request_count;
    byMin[min].err10006 += r.errors_10006;
    byMin[min].err429 += r.errors_429;
}
console.log('REST requests by minute:', JSON.stringify(byMin, null, 2));

db.close();
