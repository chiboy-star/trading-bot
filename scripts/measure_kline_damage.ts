import Database from 'better-sqlite3';
import { BybitPublicClient } from '../src/recorder/bybit_client';

async function measureDamage() {
    const db = new Database('data/recorder.db', { readonly: true });
    const client = new BybitPublicClient({ rateLimitDelayMs: 60 });

    const symbols = [
        'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BCHUSDT', 'BNTUSDT',
        'BOMEUSDT', 'COREUSDT', 'COSTUSDT', 'CPUSDT', 'CRMUSDT',
        'CRVUSDT', 'CTCUSDT', 'CTRUSDT', 'CVNAUSDT', 'CYPHUSDT',
        'ASTERUSDT', 'ATHUSDT', 'AVAAIUSDT', 'AVAXUSDT', 'ARMUSDT',
        '1000XECUSDT', 'AAOIUSDT', 'AIXBTUSDT', 'APRUSDT', 'AAPLUSDT',
        'ACTUSDT', 'CHILLGUYUSDT', 'CHRUSDT', 'BSBUSDT', 'BUSDT'
    ];

    console.log(`Starting kline mismatch audit across ${symbols.length} symbols...`);

    let totalCompared = 0;
    let totalMismatch = 0;
    let openMismatch = 0;
    let highMismatch = 0;
    let lowMismatch = 0;
    let closeMismatch = 0;
    let volumeMismatch = 0;

    const perSymbolStats: Array<{
        symbol: string;
        compared: number;
        mismatched: number;
        rate: string;
    }> = [];

    const now = Date.now();
    const lastClosedMinute = Math.floor(now / 60000) * 60000 - 60000;

    for (const symbol of symbols) {
        try {
            // Fetch 200 recent bars from Bybit REST
            const restBars = await client.fetch1mKlines(symbol, 200, undefined, lastClosedMinute);
            // Exclude any still forming
            const closedRestBars = restBars.filter(b => b.timestamp + 60000 <= now);

            let symCompared = 0;
            let symMismatch = 0;

            for (const restBar of closedRestBars) {
                const storedBar = db.prepare(`
                    SELECT open, high, low, close, volume 
                    FROM klines_1m 
                    WHERE symbol = ? AND timestamp = ?
                `).get(symbol, restBar.timestamp) as { open: number; high: number; low: number; close: number; volume: number } | undefined;

                if (!storedBar) continue;

                symCompared++;
                totalCompared++;

                const eps = 1e-5;
                const oDiff = Math.abs(storedBar.open - restBar.open);
                const hDiff = Math.abs(storedBar.high - restBar.high);
                const lDiff = Math.abs(storedBar.low - restBar.low);
                const cDiff = Math.abs(storedBar.close - restBar.close);
                const vDiff = Math.abs(storedBar.volume - restBar.volume);

                const isMismatched = (oDiff > eps || hDiff > eps || lDiff > eps || cDiff > eps || vDiff > 1e-3);
                if (isMismatched) {
                    symMismatch++;
                    totalMismatch++;
                    if (oDiff > eps) openMismatch++;
                    if (hDiff > eps) highMismatch++;
                    if (lDiff > eps) lowMismatch++;
                    if (cDiff > eps) closeMismatch++;
                    if (vDiff > 1e-3) volumeMismatch++;
                }
            }

            perSymbolStats.push({
                symbol,
                compared: symCompared,
                mismatched: symMismatch,
                rate: symCompared > 0 ? ((symMismatch / symCompared) * 100).toFixed(2) + '%' : '0.00%'
            });
        } catch (err: any) {
            console.error(`Error auditing ${symbol}:`, err?.message);
        }
    }

    db.close();

    console.log('\n=============================================================');
    console.log('KLINE DAMAGE AUDIT REPORT (STORED VS REST HISTORICAL BARS)');
    console.log('=============================================================');
    console.log(`Total Bars Compared: ${totalCompared}`);
    console.log(`Total Mismatched Bars: ${totalMismatch} (${totalCompared > 0 ? ((totalMismatch / totalCompared) * 100).toFixed(2) : '0.00'}%)`);
    console.log(`  Open Price Mismatches:   ${openMismatch} (${totalCompared > 0 ? ((openMismatch / totalCompared) * 100).toFixed(2) : '0.00'}%)`);
    console.log(`  High Price Mismatches:   ${highMismatch} (${totalCompared > 0 ? ((highMismatch / totalCompared) * 100).toFixed(2) : '0.00'}%)`);
    console.log(`  Low Price Mismatches:    ${lowMismatch} (${totalCompared > 0 ? ((lowMismatch / totalCompared) * 100).toFixed(2) : '0.00'}%)`);
    console.log(`  Close Price Mismatches:  ${closeMismatch} (${totalCompared > 0 ? ((closeMismatch / totalCompared) * 100).toFixed(2) : '0.00'}%)`);
    console.log(`  Volume Mismatches:       ${volumeMismatch} (${totalCompared > 0 ? ((volumeMismatch / totalCompared) * 100).toFixed(2) : '0.00'}%)`);
    console.log('\nPer-Symbol Summary (Sample):');
    console.table(perSymbolStats.slice(0, 15));
}

measureDamage().catch(err => {
    console.error('Fatal error in measureDamage:', err);
    process.exit(1);
});

