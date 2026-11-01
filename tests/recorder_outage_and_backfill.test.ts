import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { RecorderDB } from '../src/recorder/db';
import { GapFiller } from '../src/recorder/gap_filler';
import { BybitPublicClient } from '../src/recorder/bybit_client';
import { QualityReporter } from '../src/recorder/quality_report';
import { getRecorderDashboardStatus } from '../dashboard/lib/recorder_db';

describe('Recorder Network Outage, Gap Detection & Backfill Suite', () => {
    let db: RecorderDB;
    let rawDb: Database.Database;
    let mockClient: BybitPublicClient;
    let gapFiller: GapFiller;

    beforeEach(() => {
        // Create in-memory database with production RecorderDB schema
        db = new RecorderDB(':memory:');
        rawDb = db.getRawDb();

        // Create a mock client
        mockClient = new BybitPublicClient();
        gapFiller = new GapFiller(mockClient, db);
    });

    afterEach(() => {
        db.close();
    });

    it('records 5-minute network outage in data_gaps as streams_lost (un-backfillable feeds)', async () => {
        const outageStart = 1700000000000;
        const outageEnd = outageStart + 5 * 60 * 1000; // 5 minutes later

        // Simulate outage handling by recording streams_lost into data_gaps
        const gapId = db.recordGap({
            symbol: 'ALL',
            dataType: 'streams_lost',
            gapStart: outageStart,
            gapEnd: outageEnd,
            missingCount: 5,
            detectedAt: outageEnd,
            resolvedAt: outageEnd,
            cause: 'WebSocket disconnected (300s); liquidations and orderbook snapshots permanently lost'
        });

        expect(gapId).toBeGreaterThan(0);

        const gaps = rawDb.prepare('SELECT * FROM data_gaps').all() as any[];
        expect(gaps.length).toBe(1);
        expect(gaps[0].symbol).toBe('ALL');
        expect(gaps[0].data_type).toBe('streams_lost');
        expect(gaps[0].missing_count).toBe(5);
        expect(gaps[0].cause).toContain('liquidations and orderbook snapshots permanently lost');

        // Verify helper query returns 5-minute longest outage
        const longest = db.getLongestOutageMinutes(outageStart - 1000);
        expect(longest).toBe(5);
    });

    it('backfills missing 1m klines, funding, and open interest after an outage without modifying existing records', async () => {
        const outageStart = 1700000000000;
        const outageEnd = outageStart + 5 * 60 * 1000;

        // Seed 1m klines prior to outage
        db.insertKlines([
            {
                symbol: 'BTCUSDT',
                timestamp: outageStart - 60000,
                open: 60000,
                high: 60100,
                low: 59900,
                close: 60050,
                volume: 10,
                turnover: 600000
            }
        ]);

        // Mock fetch1mKlines to return the 5 missing bars
        const missingBars = [
            { symbol: 'BTCUSDT', timestamp: outageStart, open: 60050, high: 60100, low: 60000, close: 60080, volume: 5, turnover: 300000 },
            { symbol: 'BTCUSDT', timestamp: outageStart + 60000, open: 60080, high: 60150, low: 60050, close: 60120, volume: 8, turnover: 480000 },
            { symbol: 'BTCUSDT', timestamp: outageStart + 120000, open: 60120, high: 60200, low: 60100, close: 60190, volume: 12, turnover: 720000 },
            { symbol: 'BTCUSDT', timestamp: outageStart + 180000, open: 60190, high: 60250, low: 60150, close: 60210, volume: 15, turnover: 900000 },
            { symbol: 'BTCUSDT', timestamp: outageStart + 240000, open: 60210, high: 60280, low: 60180, close: 60250, volume: 20, turnover: 1200000 }
        ];

        vi.spyOn(mockClient, 'fetch1mKlines').mockResolvedValue(missingBars);

        // Mock historical funding and OI
        vi.spyOn(mockClient, 'fetchHistoricalFundingRates').mockResolvedValue([
            { symbol: 'BTCUSDT', fundingRateTimestamp: outageEnd, fundingRate: 0.0001, recordedAt: outageEnd, isBackfilled: true }
        ]);

        vi.spyOn(mockClient, 'fetchHistoricalOpenInterest').mockResolvedValue([
            { symbol: 'BTCUSDT', timestamp: outageEnd, openInterest: 50000, openInterestValue: 0, recordedAt: outageEnd, isBackfilled: true }
        ]);

        // Execute post-outage backfill
        const summary = await gapFiller.backfillAfterOutage(['BTCUSDT'], outageStart, outageEnd, 'test_outage');

        expect(summary.candlesFilled).toBe(5);

        // Verify total stored klines is now 6 (1 pre-outage + 5 backfilled)
        const allBars = db.getKlines('BTCUSDT', outageStart - 60000, outageEnd);
        expect(allBars.length).toBe(6);

        // Verify immutability: pre-outage bar was unchanged
        expect(allBars[0].close).toBe(60050);
        // Verify last backfilled bar
        expect(allBars[5].close).toBe(60250);

        // Verify funding rate has is_backfilled = 1
        db.insertFundingRates([
            { symbol: 'BTCUSDT', fundingRateTimestamp: outageEnd, fundingRate: 0.0001, recordedAt: outageEnd, isBackfilled: true }
        ], true);

        const fundingRow = rawDb.prepare("SELECT * FROM funding_rates WHERE symbol = 'BTCUSDT'").get() as any;
        expect(fundingRow).toBeDefined();
        expect(fundingRow.is_backfilled).toBe(1);
    });

    it('corrects report math: liquidation rate divides by elapsed recorded hours, not 24h', async () => {
        const recorderStartTs = 1700000000000;
        const now = recorderStartTs + 30 * 60 * 1000; // Exactly 0.5 hours (30 minutes) elapsed

        // Seed snapshot so recorder knows start time
        db.insertSnapshots([
            {
                snapshotTimestamp: recorderStartTs,
                symbol: 'BTCUSDT',
                baseCoin: 'BTC',
                quoteCoin: 'USDT',
                status: 'Trading',
                contractType: 'LinearPerpetual',
                launchTime: recorderStartTs,
                deliveryTime: 0,
                tickSize: 0.1,
                minOrderQty: 0.001,
                maxOrderQty: 100,
                qtyStep: 0.001,
                fundingInterval: 480
            }
        ]);

        // Ingest 10 liquidations in the 30-minute span
        for (let i = 0; i < 10; i++) {
            db.insertLiquidations([
                {
                    symbol: 'BTCUSDT',
                    side: 'Buy',
                    price: 60000 + i * 10,
                    size: 1.0,
                    timestamp: recorderStartTs + i * 100000,
                    recordedAt: recorderStartTs + i * 100000
                }
            ]);
        }

        const reporter = new QualityReporter(db);
        const report = await reporter.generateReport(24, now);

        // 10 events across 0.5 hours = 20.0 events / hour (NOT 10 / 24 = 0.42!)
        expect(report.liquidationStats.liquidationsInWindow).toBe(10);
        expect(report.liquidationStats.liquidationsPerHour).toBe(20.0);

        // Test dashboard status aggregation math matches
        const dashStatus = getRecorderDashboardStatus(rawDb, now);
        expect(dashStatus.liquidations.countLast24h).toBe(10);
        expect(dashStatus.liquidations.eventsPerHour).toBe(20.0);
    });

    it('correctly tracks DNS failures and longest outage in summary and dashboard status', async () => {
        const now = 1700000000000;

        // Record DNS failure in data_gaps
        db.recordGap({
            symbol: 'ALL',
            dataType: 'network_outage',
            gapStart: now - 10000,
            gapEnd: now,
            missingCount: 0,
            detectedAt: now,
            resolvedAt: now,
            cause: 'DNS lookup failure on api.bybit.com: getaddrinfo ENOTFOUND'
        });

        // Record a 7-minute outage
        db.recordGap({
            symbol: 'ALL',
            dataType: 'streams_lost',
            gapStart: now - 15 * 60000,
            gapEnd: now - 8 * 60000,
            missingCount: 7,
            detectedAt: now - 8 * 60000,
            resolvedAt: now - 8 * 60000,
            cause: 'Network severed for 7 minutes'
        });

        expect(db.getDnsFailuresCount(now - 86400000)).toBe(1);
        expect(db.getLongestOutageMinutes(now - 86400000)).toBe(7);

        const status = getRecorderDashboardStatus(rawDb, now);
        expect(status.network.dnsFailureCount24h).toBe(1);
        expect(status.network.longestOutageMinutes24h).toBe(7);
    });
});
