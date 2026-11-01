const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../data/recorder.db'), { readonly: true });

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchKlinesChunk(symbol, startTs, endTs) {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${startTs}&end=${endTs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`Bybit error: ${json.retMsg}`);
    const list = json.result?.list || [];
    return list.map(item => ({
        timestamp: Number(item[0]),
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5]),
        turnover: parseFloat(item[6])
    }));
}

async function fetchAllKlinesInRange(symbol, startTs, endTs) {
    let currentEnd = endTs;
    const allBars = [];
    const seenTs = new Set();

    while (currentEnd >= startTs) {
        await sleep(70); // ~14 req/sec
        const chunk = await fetchKlinesChunk(symbol, startTs, currentEnd);
        if (chunk.length === 0) break;

        let added = 0;
        for (const bar of chunk) {
            if (bar.timestamp >= startTs && bar.timestamp <= endTs && !seenTs.has(bar.timestamp)) {
                seenTs.add(bar.timestamp);
                allBars.push(bar);
                added++;
            }
        }

        const oldestInChunk = Math.min(...chunk.map(b => b.timestamp));
        if (oldestInChunk <= startTs || added === 0) {
            break;
        }
        currentEnd = oldestInChunk - 60000;
    }

    allBars.sort((a, b) => a.timestamp - b.timestamp);
    return allBars;
}

function getMissingRanges(symbol) {
    const rows = db.prepare(`SELECT timestamp FROM klines_1m WHERE symbol = ? ORDER BY timestamp ASC`).all(symbol);
    if (rows.length === 0) return [];

    const firstBar = rows[0].timestamp;
    const lastBar = rows[rows.length - 1].timestamp;
    const timestamps = new Set(rows.map(r => r.timestamp));

    const missingRanges = [];
    let currentStart = null;
    let prevMissing = null;

    for (let t = firstBar; t <= lastBar; t += 60000) {
        if (!timestamps.has(t)) {
            if (currentStart === null) currentStart = t;
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
    return { firstBar, lastBar, totalStored: rows.length, missingRanges };
}

async function auditSymbol(symbol) {
    console.log(`\n================================================================`);
    console.log(`AUDITING KLINE COMPLETENESS FOR: ${symbol}`);
    console.log(`================================================================`);
    const { firstBar, lastBar, totalStored, missingRanges } = getMissingRanges(symbol);
    const expectedBars = Math.round((lastBar - firstBar) / 60000) + 1;
    const coveragePct = ((totalStored / expectedBars) * 100).toFixed(2);

    console.log(`First Bar Stored:   ${new Date(firstBar).toISOString()}`);
    console.log(`Last Bar Stored:    ${new Date(lastBar).toISOString()}`);
    console.log(`Total Stored Bars:  ${totalStored}`);
    console.log(`Expected Bars:      ${expectedBars}`);
    console.log(`Coverage %:         ${coveragePct}%`);
    console.log(`Total Missing Spans: ${missingRanges.length}`);

    let totalMissingMinutes = 0;
    let bybitAvailableBars = 0;
    let zeroVolumeMinutes = 0;

    console.log('\n--- CONTIGUOUS MISSING RANGES & BYBIT REST API COMPARISON ---');
    for (let i = 0; i < missingRanges.length; i++) {
        const range = missingRanges[i];
        totalMissingMinutes += range.durationMinutes;

        // Fetch from Bybit REST API
        let exchangeBars = [];
        try {
            exchangeBars = await fetchAllKlinesInRange(symbol, range.startTs, range.endTs);
        } catch (e) {
            console.error(`Error fetching Bybit klines for range ${range.startIso}:`, e.message);
        }

        const availCount = exchangeBars.length;
        const zeroVolCount = range.durationMinutes - availCount;
        bybitAvailableBars += availCount;
        zeroVolumeMinutes += Math.max(0, zeroVolCount);

        // Print details for spans > 2 minutes or first 5 single-minute drops
        if (range.durationMinutes > 2 || i < 5 || i === missingRanges.length - 1) {
            console.log(`Span #${i + 1}: ${range.startIso} to ${range.endIso} (${range.durationMinutes}m) | Bybit Returned: ${availCount} bars | Zero-Volume: ${zeroVolCount}m`);
        } else if (i === 5) {
            console.log(`... [${missingRanges.length - 6} other spans of 1-2 minutes omitted for brevity] ...`);
        }
    }

    console.log('----------------------------------------------------------------');
    console.log(`SUMMARY FOR ${symbol}:`);
    console.log(`- Total Missing Minutes:         ${totalMissingMinutes}`);
    console.log(`- Available on Bybit (Recoverable): ${bybitAvailableBars} bars (${((bybitAvailableBars / totalMissingMinutes) * 100).toFixed(1)}%)`);
    console.log(`- Confirmed Zero-Volume (No Trades): ${zeroVolumeMinutes} minutes (${((zeroVolumeMinutes / totalMissingMinutes) * 100).toFixed(1)}%)`);
    console.log(`================================================================\n`);

    return {
        symbol,
        firstBar: new Date(firstBar).toISOString(),
        lastBar: new Date(lastBar).toISOString(),
        totalStored,
        expectedBars,
        coveragePct,
        totalMissingMinutes,
        bybitAvailableBars,
        zeroVolumeMinutes,
        missingRangesCount: missingRanges.length
    };
}

async function main() {
    const results = [];
    results.push(await auditSymbol('BTCUSDT'));
    results.push(await auditSymbol('ETHUSDT'));
    results.push(await auditSymbol('1000PEPEUSDT'));

    console.log('\n=== FINAL COMPARATIVE AUDIT TABLE ===');
    console.table(results);
    db.close();
}

main().catch(console.error);
