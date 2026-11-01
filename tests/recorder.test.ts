import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RecorderDB } from '../src/recorder/db';
import { GapFiller } from '../src/recorder/gap_filler';
import { QualityReporter } from '../src/recorder/quality_report';
import { BybitPublicClient } from '../src/recorder/bybit_client';
import { RecorderService } from '../src/recorder/service';
import { ContractSnapshot, Kline1m, LiquidationRecord, OrderbookSnapshot, ListingEvent } from '../src/recorder/types';

describe('Bybit Market Data Recorder Suite', () => {
    let db: RecorderDB;

    beforeEach(() => {
        // Use in-memory SQLite database for test isolation
        db = new RecorderDB(':memory:');
    });

    afterEach(() => {
        db.close();
    });

    describe('1. Schema & Deduplication on Restart', () => {
        it('should insert contract snapshots and dedupe identical snapshot timestamps', () => {
            const timestamp = 1700000000000;
            const snapshot1: ContractSnapshot = {
                snapshotTimestamp: timestamp,
                symbol: 'BTCUSDT',
                baseCoin: 'BTC',
                quoteCoin: 'USDT',
                status: 'Trading',
                contractType: 'LinearPerpetual',
                launchTime: 1585141200000,
                deliveryTime: 0,
                tickSize: 0.1,
                minOrderQty: 0.001,
                maxOrderQty: 100,
                qtyStep: 0.001,
                fundingInterval: 480
            };

            db.insertSnapshots([snapshot1]);
            expect(db.getTableCounts().contract_snapshots).toBe(1);

            // Re-insert exact same snapshot (simulating service restart / rerun)
            db.insertSnapshots([snapshot1]);
            expect(db.getTableCounts().contract_snapshots).toBe(1); // Deduplicated!

            // Next hour snapshot
            const snapshot2: ContractSnapshot = {
                ...snapshot1,
                snapshotTimestamp: timestamp + 3600000
            };
            db.insertSnapshots([snapshot2]);
            expect(db.getTableCounts().contract_snapshots).toBe(2);
        });

        it('should insert 1m klines and ignore duplicates on restart', () => {
            const klines: Kline1m[] = [
                {
                    symbol: 'BTCUSDT',
                    timestamp: 1700000060000,
                    open: 80000,
                    high: 80100,
                    low: 79950,
                    close: 80050,
                    volume: 15.5,
                    turnover: 1240000
                },
                {
                    symbol: 'BTCUSDT',
                    timestamp: 1700000120000,
                    open: 80050,
                    high: 80200,
                    low: 80000,
                    close: 80150,
                    volume: 20.1,
                    turnover: 1610000
                }
            ];

            const inserted1 = db.insertKlines(klines);
            expect(inserted1).toBe(2);
            expect(db.getTableCounts().klines_1m).toBe(2);

            // Re-insert on restart: should return 0 new inserts
            const inserted2 = db.insertKlines(klines);
            expect(inserted2).toBe(0);
            expect(db.getTableCounts().klines_1m).toBe(2);
        });

        it('should record funding rates and open interest without duplicates', () => {
            const fr = [
                { symbol: 'BTCUSDT', fundingRateTimestamp: 1700000000000, fundingRate: 0.0001, recordedAt: 1700000000000 }
            ];
            db.insertFundingRates(fr);
            db.insertFundingRates(fr);
            expect(db.getTableCounts().funding_rates).toBe(1);

            const oi = [
                { symbol: 'BTCUSDT', timestamp: 1700000000000, openInterest: 50000, openInterestValue: 4000000000, recordedAt: 1700000000000 }
            ];
            db.insertOpenInterest(oi);
            db.insertOpenInterest(oi);
            expect(db.getTableCounts().open_interest).toBe(1);
        });

        it('should strictly reject UPDATE and DELETE on append-only tables via SQLite triggers', () => {
            const rawDb = db.getRawDb();
            const timestamp = 1700000000000;
            db.insertSnapshots([{
                snapshotTimestamp: timestamp,
                symbol: 'BTCUSDT',
                baseCoin: 'BTC',
                quoteCoin: 'USDT',
                status: 'Trading',
                contractType: 'LinearPerpetual',
                launchTime: 1585141200000,
                deliveryTime: 0,
                tickSize: 0.1,
                minOrderQty: 0.001,
                maxOrderQty: 100,
                qtyStep: 0.001,
                fundingInterval: 480
            }]);

            db.insertKlines([{
                symbol: 'BTCUSDT',
                timestamp: timestamp,
                open: 80000,
                high: 80100,
                low: 79900,
                close: 80050,
                volume: 10,
                turnover: 800000
            }]);

            // Attempting to UPDATE on contract_snapshots must throw
            expect(() => {
                rawDb.prepare("UPDATE contract_snapshots SET status = 'Delisted' WHERE symbol = 'BTCUSDT'").run();
            }).toThrow(/Mutation forbidden: table contract_snapshots is append-only/);

            // Attempting to DELETE from contract_snapshots must throw
            expect(() => {
                rawDb.prepare("DELETE FROM contract_snapshots WHERE symbol = 'BTCUSDT'").run();
            }).toThrow(/Deletion forbidden: table contract_snapshots is append-only/);

            // Attempting to UPDATE on klines_1m must throw
            expect(() => {
                rawDb.prepare("UPDATE klines_1m SET close = 99999 WHERE symbol = 'BTCUSDT'").run();
            }).toThrow(/Mutation forbidden: table klines_1m is append-only/);

            // Attempting to DELETE from klines_1m must throw
            expect(() => {
                rawDb.prepare("DELETE FROM klines_1m WHERE symbol = 'BTCUSDT'").run();
            }).toThrow(/Deletion forbidden: table klines_1m is append-only/);
        });
    });

    describe('2. Listing & Delisting Lifecycle Events', () => {
        it('should record listing and delisting events with details and timestamps', () => {
            const events: ListingEvent[] = [
                {
                    detectedAt: 1700000000000,
                    symbol: 'NEWCOINUSDT',
                    eventType: 'LISTING',
                    prevStatus: null,
                    newStatus: 'Trading',
                    launchTime: 1700000000000,
                    details: 'New linear contract listed'
                },
                {
                    detectedAt: 1700003600000,
                    symbol: 'DEADCOINUSDT',
                    eventType: 'DELISTING',
                    prevStatus: 'Trading',
                    newStatus: 'Delisted',
                    launchTime: 1600000000000,
                    details: 'Delisted from exchange'
                }
            ];

            db.insertListingEvents(events);
            const recorded = db.getListingEvents();
            expect(recorded.length).toBe(2);
            expect(recorded[0].symbol).toBe('DEADCOINUSDT');
            expect(recorded[0].eventType).toBe('DELISTING');
            expect(recorded[1].symbol).toBe('NEWCOINUSDT');
            expect(recorded[1].eventType).toBe('LISTING');
        });
    });

    describe('3. Order-Book & Liquidation Storage', () => {
        it('should record orderbook snapshots with top 25 depth and price sanity', () => {
            const snapshot: OrderbookSnapshot = {
                symbol: 'BTCUSDT',
                timestamp: 1700000000000,
                depth: 25,
                bids: [[80000, 1.5], [79990, 2.0]],
                asks: [[80010, 0.8], [80020, 3.2]],
                bestBid: 80000,
                bestAsk: 80010,
                spread: 10,
                midPrice: 80005,
                recordedAt: 1700000000100
            };

            db.insertOrderbookSnapshots([snapshot]);
            expect(db.getTableCounts().orderbook_snapshots).toBe(1);

            // Validate math sanity
            expect(snapshot.bestBid).toBeLessThan(snapshot.bestAsk);
            expect(snapshot.spread).toBeGreaterThan(0);
            expect(snapshot.midPrice).toBe((snapshot.bestBid + snapshot.bestAsk) / 2);
        });

        it('should record liquidations with deduplication', () => {
            const liq: LiquidationRecord = {
                symbol: 'ETHUSDT',
                side: 'Sell',
                price: 3200.5,
                size: 15.0,
                timestamp: 1700000000000,
                recordedAt: 1700000000050
            };

            db.insertLiquidations([liq]);
            db.insertLiquidations([liq]); // Duplicate
            expect(db.getTableCounts().liquidations).toBe(1);
        });
    });

    describe('4. Gap Detection & Resolution', () => {
        it('should detect timestamp gaps in 1m klines', () => {
            // Insert candles with a 3-minute gap between t0 and t3
            const t0 = 1700000000000;
            const t3 = t0 + 4 * 60000; // skipped t1, t2, t3 -> 3 missing candles
            const klines: Kline1m[] = [
                { symbol: 'BTCUSDT', timestamp: t0, open: 80000, high: 80010, low: 79990, close: 80000, volume: 1, turnover: 80000 },
                { symbol: 'BTCUSDT', timestamp: t3, open: 80050, high: 80060, low: 80040, close: 80050, volume: 1, turnover: 80050 }
            ];
            db.insertKlines(klines);

            const gapFiller = new GapFiller(new BybitPublicClient(), db);
            const gaps = gapFiller.detectKlineGaps('BTCUSDT', t0, t3);

            expect(gaps.length).toBe(1);
            expect(gaps[0].missingCount).toBe(3);
            expect(gaps[0].gapStart).toBe(t0 + 60000);
            expect(gaps[0].gapEnd).toBe(t3 - 60000);
        });

        it('should record and resolve data gaps in database', () => {
            const gapId = db.recordGap({
                symbol: 'SOLUSDT',
                dataType: 'kline_1m',
                gapStart: 1700000060000,
                gapEnd: 1700000180000,
                missingCount: 2,
                detectedAt: Date.now()
            });

            const unresolvedBefore = db.getUnresolvedGaps('SOLUSDT');
            expect(unresolvedBefore.length).toBe(1);
            expect(unresolvedBefore[0].id).toBe(gapId);

            db.resolveGap(gapId);

            const unresolvedAfter = db.getUnresolvedGaps('SOLUSDT');
            expect(unresolvedAfter.length).toBe(0);
        });
    });

    describe('5. Data Quality Reporting', () => {
        it('should generate a comprehensive 24-hour report and format markdown', async () => {
            // Seed some data
            const now = Date.now();
            db.insertSnapshots([{
                snapshotTimestamp: now,
                symbol: 'BTCUSDT',
                baseCoin: 'BTC',
                quoteCoin: 'USDT',
                status: 'Trading',
                contractType: 'LinearPerpetual',
                launchTime: now - 86400000,
                deliveryTime: 0,
                tickSize: 0.1,
                minOrderQty: 0.001,
                maxOrderQty: 100,
                qtyStep: 0.001,
                fundingInterval: 480
            }]);

            db.insertKlines([{
                symbol: 'BTCUSDT',
                timestamp: now - 60000,
                open: 80000,
                high: 80050,
                low: 79950,
                close: 80020,
                volume: 5,
                turnover: 400000
            }]);

            db.insertHeartbeat({
                timestamp: now,
                activeSymbolsCount: 1,
                status: 'HEALTHY',
                lastDataTimestamp: now,
                details: 'Test heartbeat'
            });

            const reporter = new QualityReporter(db);
            const report = await reporter.generateReport(24);

            expect(report.counts.contractSnapshots).toBe(1);
            expect(report.counts.klines1m).toBe(1);
            expect(report.counts.heartbeats).toBe(1);
            expect(report.freshness.isStale).toBe(false);
            expect(report.diskUsageProjection.dailyEstimatedMb).toBeGreaterThan(0);

            const markdown = reporter.formatMarkdownReport(report);
            expect(markdown).toContain('Bybit Market Data Recorder - 24-Hour Data Quality Report');
            expect(markdown).toContain('Storage & Record Totals');
            expect(markdown).toContain('Listing & Delisting Lifecycle Tracking');
            expect(markdown).toContain('Gap Detection & Data Continuity');
        });
    });

    describe('6. Startup Self-Check & Loud Failure on Missing Triggers', () => {
        it('should pass startup self-check on database with all triggers intact', async () => {
            const service = new RecorderService({ dbPath: ':memory:' });
            // Mock REST API client to avoid live network call in unit test
            (service as any).client.fetchJson = async () => ({ timeSecond: '1700000000' });

            const check = await service.runStartupSelfCheck();
            expect(check.passed).toBe(true);
            expect(check.checks.database.ok).toBe(true);
            expect(check.checks.database.message).toContain('append-only triggers enforced=true');
        });

        it('should fail startup self-check and refuse to start if triggers are missing', async () => {
            const service = new RecorderService({ dbPath: ':memory:' });
            (service as any).client.fetchJson = async () => ({ timeSecond: '1700000000' });

            // Deliberately drop an append-only trigger
            const rawDb = (service as any).db.getRawDb();
            rawDb.prepare('DROP TRIGGER abort_update_contract_snapshots').run();

            const check = await service.runStartupSelfCheck();
            expect(check.passed).toBe(false);
            expect(check.checks.database.ok).toBe(false);
            expect(check.checks.database.message).toContain('append-only triggers enforced=false');

            // Must throw loudly and refuse to start
            await expect(service.start()).rejects.toThrow(/Recorder startup self-check failed.*append-only triggers enforced=false/);
        });
    });
});
