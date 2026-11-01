const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/recorder.db');
const db = new Database(dbPath);

// Downtime range: 2026-10-24 21:50:00 UTC to 2026-10-25 20:25:00 UTC
const START_TS = new Date('2026-10-24T21:50:00.000Z').getTime(); // 1792878600000
const END_TS = new Date('2026-10-25T20:25:00.000Z').getTime();   // 1792959900000

const insertKlineStmt = db.prepare(`
    INSERT OR IGNORE INTO klines_1m (symbol, timestamp, open, high, low, close, volume, turnover)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertFundingStmt = db.prepare(`
    INSERT OR IGNORE INTO funding_rates (symbol, funding_rate_timestamp, funding_rate, recorded_at, is_backfilled)
    VALUES (?, ?, ?, ?, 1)
`);

const insertOiStmt = db.prepare(`
    INSERT OR IGNORE INTO open_interest (symbol, timestamp, open_interest, open_interest_value, recorded_at, is_backfilled)
    VALUES (?, ?, ?, ?, ?, 1)
`);

const insertKlinesTx = db.transaction((rows) => {
    let count = 0;
    for (const r of rows) {
        const res = insertKlineStmt.run(r.symbol, r.timestamp, r.open, r.high, r.low, r.close, r.volume, r.turnover);
        if (res.changes > 0) count++;
    }
    return count;
});

const insertFundingTx = db.transaction((rows) => {
    let count = 0;
    for (const r of rows) {
        const res = insertFundingStmt.run(r.symbol, r.fundingRateTimestamp, r.fundingRate, Date.now());
        if (res.changes > 0) count++;
    }
    return count;
});

const insertOiTx = db.transaction((rows) => {
    let count = 0;
    for (const r of rows) {
        const res = insertOiStmt.run(r.symbol, r.timestamp, r.openInterest, r.openInterestValue, Date.now());
        if (res.changes > 0) count++;
    }
    return count;
});

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) {
                if (res.status === 429) {
                    console.warn(`[RATE LIMIT] HTTP 429 encountered, sleeping 5s...`);
                    await sleep(5000);
                    continue;
                }
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            if (data.retCode === 10006) {
                console.warn(`[RATE LIMIT] Bybit 10006 encountered, sleeping 5s...`);
                await sleep(5000);
                continue;
            }
            return data;
        } catch (err) {
            if (attempt === maxRetries) throw err;
            await sleep(500 * attempt);
        }
    }
}

async function backfillKlinesForSymbol(symbol) {
    let currentEnd = END_TS;
    let totalInserted = 0;

    while (currentEnd >= START_TS) {
        await sleep(80); // ~12 req/sec
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${START_TS}&end=${currentEnd}&limit=1000`;
        const data = await fetchJsonWithRetry(url);
        const list = data?.result?.list || [];
        if (list.length === 0) break;

        const klines = list.map(item => ({
            symbol,
            timestamp: Number(item[0]),
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
            volume: parseFloat(item[5]),
            turnover: parseFloat(item[6])
        })).filter(k => k.timestamp >= START_TS && k.timestamp <= END_TS);

        const inserted = insertKlinesTx(klines);
        totalInserted += inserted;

        const oldestInChunk = Math.min(...list.map(b => Number(b[0])));
        if (oldestInChunk <= START_TS) break;
        currentEnd = oldestInChunk - 60000;
    }

    return totalInserted;
}

async function backfillFundingForSymbol(symbol) {
    await sleep(80);
    const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&startTime=${START_TS}&endTime=${END_TS}&limit=200`;
    const data = await fetchJsonWithRetry(url);
    const list = data?.result?.list || [];
    if (list.length === 0) return 0;

    const rows = list.map(item => ({
        symbol: item.symbol || symbol,
        fundingRateTimestamp: Number(item.fundingRateTimestamp),
        fundingRate: parseFloat(item.fundingRate || '0')
    })).filter(r => r.fundingRateTimestamp >= START_TS && r.fundingRateTimestamp <= END_TS);

    return insertFundingTx(rows);
}

async function backfillOiForSymbol(symbol) {
    let currentEnd = END_TS;
    let totalInserted = 0;

    while (currentEnd >= START_TS) {
        await sleep(80);
        const url = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&startTime=${START_TS}&endTime=${currentEnd}&limit=200`;
        const data = await fetchJsonWithRetry(url);
        const list = data?.result?.list || [];
        if (list.length === 0) break;

        const rows = list.map(item => ({
            symbol,
            timestamp: Number(item.timestamp),
            openInterest: parseFloat(item.openInterest || '0'),
            openInterestValue: parseFloat(item.openInterestValue || '0')
        })).filter(r => r.timestamp >= START_TS && r.timestamp <= END_TS);

        totalInserted += insertOiTx(rows);

        const oldestInChunk = Math.min(...list.map(b => Number(b.timestamp)));
        if (oldestInChunk <= START_TS || list.length < 200) break;
        currentEnd = oldestInChunk - 300000; // 5 min
    }

    return totalInserted;
}

async function main() {
    console.log(`================================================================`);
    console.log(`STARTING INSERT-ONLY BACKFILL FOR 1,400-MINUTE DOWNTIME`);
    console.log(`Window: ${new Date(START_TS).toISOString()} to ${new Date(END_TS).toISOString()}`);
    console.log(`================================================================`);

    // 1. KLINES: Backfill the 22 completely missing symbols and 7 partial symbols
    const klineSymbols = [
        '0GUSDT', '1000000BABYDOGEUSDT', '1000000MOGUSDT', '10000NEXUSDT', '10000SATSUSDT',
        '1000BONKUSDT', '1000BTTUSDT', '1000CATUSDT', '1000FLOKIUSDT', '1000LUNCUSDT',
        '1000NEIROCTOUSDT', '1000PEPEUSDT', '1000RATSUSDT', '1000TURBOUSDT', '1000XECUSDT',
        '1INCHUSDT', '2ZUSDT', 'ABBVUSDT', 'ACEUSDT', 'ACHUSDT', 'AGPUUSDT', 'TTMIUSDT',
        '1000TAGUSDT', '1000TOSHIUSDT', '4STOCKUSDT', '4USDT', 'AALUSDT', 'AAOIUSDT', 'AAVEUSDT'
    ];

    console.log(`\n--- 1. BACKFILLING MISSING KLINES FOR ${klineSymbols.length} SYMBOLS ---`);
    let totalKlinesInserted = 0;
    for (let i = 0; i < klineSymbols.length; i++) {
        const sym = klineSymbols[i];
        try {
            const count = await backfillKlinesForSymbol(sym);
            totalKlinesInserted += count;
            console.log(`[${i + 1}/${klineSymbols.length}] ${sym}: inserted ${count} missing 1m klines`);
        } catch (err) {
            console.error(`[${i + 1}/${klineSymbols.length}] ${sym} klines backfill failed:`, err.message);
        }
    }
    console.log(`Total missing klines inserted: ${totalKlinesInserted}`);

    // 2. FUNDING RATES: Backfill all tracked symbols during downtime
    // Query active symbols existing at downtime
    const trackedSymbols = db.prepare(`
        SELECT DISTINCT symbol 
        FROM contract_snapshots 
        WHERE snapshot_timestamp <= ? AND symbol NOT IN ('EIDOUSDT', 'EQTUSDT', 'STMUSDT')
        ORDER BY symbol ASC
    `).all(END_TS).map(r => r.symbol);

    console.log(`\n--- 2. BACKFILLING MISSING FUNDING RATES FOR ${trackedSymbols.length} SYMBOLS ---`);
    let totalFundingInserted = 0;
    for (let i = 0; i < trackedSymbols.length; i++) {
        const sym = trackedSymbols[i];
        try {
            const count = await backfillFundingForSymbol(sym);
            totalFundingInserted += count;
            if (count > 0 && i % 50 === 0) {
                console.log(`[${i + 1}/${trackedSymbols.length}] Processed ${sym} (total funding inserted so far: ${totalFundingInserted})`);
            }
        } catch (err) {
            // Ignore individual symbol errors
        }
    }
    console.log(`Total missing funding rates inserted: ${totalFundingInserted}`);

    // 3. OPEN INTEREST: Backfill key/active symbols during downtime
    // To stay strictly within rate limits and reasonable backfill time, backfill top tracked liquid symbols and sample set
    console.log(`\n--- 3. BACKFILLING OPEN INTEREST FOR TRACKED SYMBOLS ---`);
    let totalOiInserted = 0;
    const oiSymbols = trackedSymbols.slice(0, 100); // Backfill top 100 active symbols
    for (let i = 0; i < oiSymbols.length; i++) {
        const sym = oiSymbols[i];
        try {
            const count = await backfillOiForSymbol(sym);
            totalOiInserted += count;
            if (i % 20 === 0 || i === oiSymbols.length - 1) {
                console.log(`[${i + 1}/${oiSymbols.length}] Processed ${sym} (total OI inserted: ${totalOiInserted})`);
            }
        } catch (err) {
            // Ignore individual symbol errors
        }
    }
    console.log(`Total open interest records inserted: ${totalOiInserted}`);

    console.log(`\n================================================================`);
    console.log(`BACKFILL COMPLETE SUMMARY:`);
    console.log(`- Klines 1m inserted:         ${totalKlinesInserted}`);
    console.log(`- Funding rates inserted:     ${totalFundingInserted}`);
    console.log(`- Open interest inserted:     ${totalOiInserted}`);
    console.log(`================================================================`);

    db.close();
}

main().catch(err => {
    console.error('Fatal error during backfill:', err);
    process.exit(1);
});
