import { BybitPublicClient } from '../src/recorder/bybit_client';
import { RecorderDB } from '../src/recorder/db';
import { GapFiller } from '../src/recorder/gap_filler';
import * as path from 'path';

async function main() {
    const dbPath = path.resolve(process.cwd(), 'data/recorder.db');
    console.log(`[GapFiller] Opening database at ${dbPath}...`);
    const db = new RecorderDB(dbPath);
    const client = new BybitPublicClient({ rateLimitDelayMs: 60 });
    const filler = new GapFiller(client, db);

    const rawDb = db.getRawDb();
    const beforeCount = rawDb.prepare(`
        SELECT COUNT(*) as count FROM data_gaps WHERE resolved_at IS NULL AND data_type = 'kline_1m'
    `).get() as { count: number };
    console.log(`[GapFiller] Initial open kline_1m gaps: ${beforeCount.count}`);

    // If gaps are present, resolve them
    const result = await filler.resolveOpenKlineGaps();

    console.log('\n[GapFiller] Execution Summary:');
    console.log(`  Gaps resolved: ${result.resolvedCount}`);
    console.log(`  Candles inserted: ${result.candlesFilled}`);
    console.log(`  Remaining open gaps: ${result.remainingGaps}`);

    db.close();
}

main().catch(err => {
    console.error('[GapFiller] Fatal error:', err);
    process.exit(1);
});
