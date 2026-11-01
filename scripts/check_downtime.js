const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../data/recorder.db'), { readonly: true });
const s = new Date('2026-10-24T21:50:00Z').getTime();
const e = new Date('2026-10-25T20:25:00Z').getTime();

console.log('Min ts:', db.prepare("SELECT datetime(min(timestamp)/1000, 'unixepoch') as m FROM klines_1m WHERE timestamp >= ? AND timestamp <= ?").get(s, e));
console.log('Max ts:', db.prepare("SELECT datetime(max(timestamp)/1000, 'unixepoch') as m FROM klines_1m WHERE timestamp >= ? AND timestamp <= ?").get(s, e));
console.log('BTC in downtime:', db.prepare("SELECT count(*) as cnt FROM klines_1m WHERE symbol = 'BTCUSDT' AND timestamp >= ? AND timestamp <= ?").get(s, e));
console.log('ETH in downtime:', db.prepare("SELECT count(*) as cnt FROM klines_1m WHERE symbol = 'ETHUSDT' AND timestamp >= ? AND timestamp <= ?").get(s, e));
console.log('PEPE in downtime:', db.prepare("SELECT count(*) as cnt FROM klines_1m WHERE symbol = '1000PEPEUSDT' AND timestamp >= ? AND timestamp <= ?").get(s, e));

// How many symbols have bars in this window vs how many have 0 bars?
const symStats = db.prepare(`
    SELECT count(distinct symbol) as with_bars FROM klines_1m WHERE timestamp >= ? AND timestamp <= ?
`).get(s, e);
console.log('Symbols with bars in downtime:', symStats);

const allSyms = db.prepare("SELECT count(distinct symbol) as total FROM contract_snapshots").get();
console.log('Total tracked symbols:', allSyms);

// Check open interest in that downtime
const oiStats = db.prepare("SELECT count(*) as cnt FROM open_interest WHERE timestamp >= ? AND timestamp <= ?").get(s, e);
console.log('OI rows in downtime:', oiStats);

// Check funding in that downtime
const fundingStats = db.prepare("SELECT count(*) as cnt, min(datetime(funding_rate_timestamp/1000, 'unixepoch')) as min_ts, max(datetime(funding_rate_timestamp/1000, 'unixepoch')) as max_ts FROM funding_rates WHERE funding_rate_timestamp >= ? AND funding_rate_timestamp <= ?").get(s, e);
console.log('Funding stats in downtime:', fundingStats);

db.close();
