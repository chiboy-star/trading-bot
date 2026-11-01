import { RecorderService } from './service';
import { QualityReporter } from './quality_report';
import { RecorderDB } from './db';
import { createLogger } from '../utils/logger';

const log = createLogger('recorder-main');

async function main() {
    const args = process.argv.slice(2);
    const isReportOnly = args.includes('--report');
    const isDryRun = args.includes('--dry-run');

    console.log(`
=============================================================
BYBIT MARKET DATA RECORDER (FORWARD-LOOKING UNBIASED DATASET)
=============================================================
Mode: ${isReportOnly ? 'QUALITY REPORT GENERATOR' : isDryRun ? 'DRY-RUN / TEST INGESTION' : 'LONG-RUNNING RECORDER SERVICE'}
Storage: SQLite (data/recorder.db) WAL mode
Endpoints: Bybit Public V5 REST + WebSocket
Liquidation Stream: allLiquidation.{symbol}
Order-book Depth: Top-25 levels (BTC, ETH, and listings <72h)
=============================================================
    `);

    if (isReportOnly) {
        const db = new RecorderDB();
        const { BybitPublicClient } = await import('./bybit_client');
        const client = new BybitPublicClient({ rateLimitDelayMs: 60 });
        const reporter = new QualityReporter(db, client);
        const report = await reporter.generateReport(24);
        console.log(reporter.formatMarkdownReport(report));
        db.close();
        process.exit(0);
    }

    const service = new RecorderService();

    // Signal handlers for graceful shutdown
    let isShuttingDown = false;
    const shutdown = async (signal: string) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log(`\nReceived ${signal}. Performing graceful shutdown...`);
        try {
            await service.stop();
            console.log('Shutdown completed cleanly.');
            process.exit(0);
        } catch (err) {
            console.error('Error during shutdown:', err);
            process.exit(1);
        }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    try {
        await service.start();

        if (isDryRun) {
            console.log('\nDry-run flag detected. Running for 30 seconds to capture initial cycles, then generating report...');
            setTimeout(async () => {
                const report = await service.reporter.generateReport(24);
                console.log('\n--- 24-HOUR DRY-RUN DATA QUALITY REPORT ---');
                console.log(service.reporter.formatMarkdownReport(report));
                await shutdown('DRY_RUN_COMPLETE');
            }, 30000);
        }
    } catch (err: any) {
        log.error({ err }, 'Fatal error starting recorder service');
        await shutdown('ERROR');
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Unhandled fatal error in recorder main:', err);
        process.exit(1);
    });
}
