import { RecorderDB } from '../src/recorder/db';
import { BybitPublicClient } from '../src/recorder/bybit_client';
import { Kline1m } from '../src/recorder/types';

async function main() {
    console.log('=== POPULATE KLINES_1M_FINAL (BULK REST HISTORY PAGINATION) ===');
    const startTime = Date.now();
    const db = new RecorderDB();
    const client = new BybitPublicClient({ rateLimitDelayMs: 200, requestTimeoutMs: 20000 }); // <= 5 req/s

    const rawDb = db.getRawDb();
    const symbolsRows = rawDb.prepare(`
        SELECT DISTINCT symbol FROM contract_snapshots ORDER BY symbol ASC
    `).all() as { symbol: string }[];

    const allSymbols = symbolsRows.length > 0 
        ? symbolsRows.map(r => r.symbol) 
        : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

    // Prioritize major contracts first
    const prioritySymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const otherSymbols = allSymbols.filter(s => !prioritySymbols.includes(s));
    const orderedSymbols = [...prioritySymbols, ...otherSymbols];

    const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const isAll = process.argv.slice(2).includes('--all');
    const targetSymbols = args.length > 0 ? args : isAll ? orderedSymbols : prioritySymbols;

    let totalBarsInserted = 0;
    let totalRequests = 0;
    const now = Date.now();
    const lastClosedMinute = Math.floor(now / 60000) * 60000 - 60000;
    const sevenDaysAgo = lastClosedMinute - 7 * 24 * 3600 * 1000;

    console.log(`Populating history for ${targetSymbols.length} contracts (last 7 days)...`);

    for (const symbol of targetSymbols) {
        if (client.isBanActive()) {
            console.warn('Circuit breaker active, pausing.');
            break;
        }

        const latestInFinal = db.getLatestKlineFinalTimestamp(symbol);
        const startTs = latestInFinal ? latestInFinal + 60000 : sevenDaysAgo;

        if (startTs >= lastClosedMinute) {
            console.log(`[${symbol}] Already up to date (latest: ${new Date(startTs).toISOString()})`);
            continue;
        }

        console.log(`[${symbol}] Paginating closed 1m bars from ${new Date(startTs).toISOString()} to ${new Date(lastClosedMinute).toISOString()}...`);

        let cursor = startTs;
        let symbolBarsInserted = 0;

        while (cursor < lastClosedMinute) {
            totalRequests++;
            const chunkEnd = Math.min(lastClosedMinute, cursor + 1000 * 60 * 1000);
            let page: Kline1m[] = [];

            try {
                page = await client.fetch1mKlines(symbol, 1000, cursor, chunkEnd);
            } catch (err: any) {
                console.error(`[${symbol}] Fetch error: ${err.message}`);
                break;
            }

            // Filter strictly closed bars
            const closedBars = page.filter(b => b.timestamp <= lastClosedMinute);
            if (closedBars.length > 0) {
                const inserted = db.insertKlinesFinal(closedBars);
                symbolBarsInserted += inserted;
                totalBarsInserted += inserted;
            }

            if (page.length === 0) {
                cursor = chunkEnd + 60000;
            } else {
                const maxTs = Math.max(...page.map(b => b.timestamp));
                if (maxTs <= cursor) {
                    cursor += 1000 * 60 * 1000;
                } else {
                    cursor = maxTs + 60000;
                }
            }

            // Rate throttle: 200ms spacing (<= 5 req/s)
            await new Promise(r => setTimeout(r, 200));
        }

        console.log(`[${symbol}] Finished: ${symbolBarsInserted} closed bars inserted into klines_1m_final.`);
    }

    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`
===================================================
POPULATION COMPLETE
Total Bars Inserted: ${totalBarsInserted}
Total REST Requests: ${totalRequests}
Time Taken: ${elapsedSeconds}s
===================================================
    `);

    db.close();
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error in populate_klines_1m_final:', err);
        process.exit(1);
    });
}
