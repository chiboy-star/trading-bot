import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { RecorderDB } from '../src/recorder/db';
import { RecorderService } from '../src/recorder/service';
import { BybitPublicClient } from '../src/recorder/bybit_client';
import { isCryptoPerp, ContractSnapshot, classifyContract } from '../src/recorder/types';
import { globalRestRateLimiter } from '../src/recorder/rate_limiter';

const makeSnapshot = (
    symbol: string,
    launchTime: number,
    ts: number = Date.now(),
    symbolType: string = ''
): ContractSnapshot => ({
    snapshotTimestamp: ts,
    symbol,
    baseCoin: symbol.replace('USDT', ''),
    quoteCoin: 'USDT',
    status: 'Trading',
    contractType: 'LinearPerpetual',
    launchTime,
    deliveryTime: 0,
    tickSize: 0.01,
    minOrderQty: 0.001,
    maxOrderQty: 1000,
    qtyStep: 0.001,
    fundingInterval: 480,
    rawJson: JSON.stringify({ symbolType })
});

const makeMockWsClient = () => ({
    setTrackedSymbols: vi.fn(),
    addNewListing: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    isHealthy: vi.fn().mockReturnValue(true),
    getShardsStatus: vi.fn().mockReturnValue([])
} as any);

describe('Recorder Fixes & Verification Suite', () => {
    let db: RecorderDB;
    let rawDb: Database.Database;

    beforeEach(() => {
        db = new RecorderDB(':memory:');
        rawDb = db.getRawDb();
    });

    afterEach(() => {
        try {
            db.close();
        } catch {
            // ignore
        }
    });

    describe('Requirement 1: Cold-Start and Restart Listing Events Fix', () => {
        it('cold-start baseline must never emit listing events for existing universe', async () => {
            const mockClient = {
                fetchAllLinearContracts: vi.fn().mockImplementation(async (ts: number = Date.now()) => [
                    makeSnapshot('BTCUSDT', 1600000000000, ts),
                    makeSnapshot('ETHUSDT', 1600000000000, ts),
                    makeSnapshot('SOLUSDT', 1600000000000, ts),
                ]),
                subscribeOrderbook: vi.fn(),
                subscribeLiquidations: vi.fn(),
                fetchAllTickers: vi.fn().mockResolvedValue({ fundingRates: [], openInterests: [] }),
                onRateLimitMetrics: vi.fn(),
                requestTimestamps: []
            } as unknown as BybitPublicClient;

            const service = new RecorderService({
                dbPath: ':memory:',
                snapshotIntervalMs: 100000,
                tickerPollIntervalMs: 100000
            }, db, mockClient, makeMockWsClient());

            // Trigger snapshot on cold start
            await service.takeContractSnapshot();

            // Listing events must be exactly 0
            const events = db.getListingEvents();
            expect(events.length).toBe(0);

            // Snapshots should be recorded
            const snapshots = rawDb.prepare('SELECT COUNT(*) as cnt FROM contract_snapshots').get() as { cnt: number };
            expect(snapshots.cnt).toBe(3);
        });

        it('service restart must load active contracts from DB and never log existing contracts as new listings', async () => {
            // Seed DB with existing snapshot representing prior run
            const priorSnapshotTs = 1792858680000;
            db.insertSnapshots([
                makeSnapshot('BTCUSDT', 1600000000000, priorSnapshotTs),
                makeSnapshot('ETHUSDT', 1600000000000, priorSnapshotTs)
            ]);

            const mockClient = {
                fetchAllLinearContracts: vi.fn().mockImplementation(async (ts: number = Date.now()) => [
                    makeSnapshot('BTCUSDT', 1600000000000, ts),
                    makeSnapshot('ETHUSDT', 1600000000000, ts),
                ]),
                subscribeOrderbook: vi.fn(),
                subscribeLiquidations: vi.fn(),
                fetchAllTickers: vi.fn().mockResolvedValue({ fundingRates: [], openInterests: [] }),
                onRateLimitMetrics: vi.fn(),
                requestTimestamps: []
            } as unknown as BybitPublicClient;

            // Instantiate service (which executes loadActiveContractsFromDb in constructor)
            const service = new RecorderService({
                dbPath: ':memory:',
                snapshotIntervalMs: 100000,
            }, db, mockClient, makeMockWsClient());

            // Execute snapshot after restart
            await service.takeContractSnapshot();

            // 0 listing events created
            const events = db.getListingEvents();
            expect(events.length).toBe(0);
        });

        it('valid_listing_events view filters out pre-snapshot launches and late detections (>60m)', () => {
            const firstSnapshotTs = 1792858680000; // 2026-10-24 16:18:00 UTC

            // 1. Pre-snapshot launch (e.g. 2024 contract logged on restart)
            db.insertListingEvents([{
                symbol: 'OLDUSDT',
                eventType: 'LISTING',
                prevStatus: null,
                newStatus: 'Trading',
                launchTime: 1700000000000, // Year 2023
                detectedAt: firstSnapshotTs + 10000,
                details: 'Pre-existing contract false listing'
            }]);

            // 2. Post-snapshot launch, but detected 35h after launch (>60m)
            const lateLaunchTime = firstSnapshotTs + 3600000;
            db.insertListingEvents([{
                symbol: 'LATEUSDT',
                eventType: 'LISTING',
                prevStatus: null,
                newStatus: 'Trading',
                launchTime: lateLaunchTime,
                detectedAt: lateLaunchTime + 35 * 3600 * 1000, // 35 hours later
                details: 'Late detected listing'
            }]);

            // 3. Genuine new listing: launched after first snapshot, detected within 15 minutes (<60m)
            const validLaunchTime = firstSnapshotTs + 7200000;
            db.insertListingEvents([{
                symbol: 'NEWGENUINEUSDT',
                eventType: 'LISTING',
                prevStatus: null,
                newStatus: 'Trading',
                launchTime: validLaunchTime,
                detectedAt: validLaunchTime + 15 * 60 * 1000, // 15 mins later
                details: 'Genuine new listing'
            }]);

            // All events in base table = 3
            const allEvents = db.getListingEvents();
            expect(allEvents.length).toBe(3);

            // Valid events in view = exactly 1
            const validEvents = db.getValidListingEvents();
            expect(validEvents.length).toBe(1);
            expect(validEvents[0].symbol).toBe('NEWGENUINEUSDT');
            expect(validEvents[0].launchTime).toBe(validLaunchTime);
        });
    });

    describe('Requirement 2 & 3: Crypto-Only Filter & H-A Eligibility Logic', () => {
        it('isCryptoPerp correctly classifies crypto vs non-crypto perpetuals', () => {
            // Standard crypto
            expect(isCryptoPerp({ symbol: 'BTCUSDT', symbolType: '' })).toBe(true);
            expect(isCryptoPerp({ symbol: 'ETHUSDT' })).toBe(true);
            expect(isCryptoPerp({ symbol: 'DOGEUSDT', symbolType: 'innovation' })).toBe(true);

            // Non-crypto assets
            expect(isCryptoPerp({ symbol: 'AAPLUSDT', symbolType: 'stock' })).toBe(false);
            expect(isCryptoPerp({ symbol: 'NVDAUSDT', symbolType: 'stock' })).toBe(false);
            expect(isCryptoPerp({ symbol: 'SPYUSDT', symbolType: 'ETF' })).toBe(false);
            expect(isCryptoPerp({ symbol: 'QQQUSDT', symbolType: 'ETF' })).toBe(false);
            expect(isCryptoPerp({ symbol: 'GOLDUSDT', symbolType: 'commodity' })).toBe(false);
            expect(isCryptoPerp({ symbol: 'EURUSDT', symbolType: 'forex' })).toBe(false);
            expect(isCryptoPerp({ symbol: 'BAUSDT', symbolType: 'stock' })).toBe(false);
            expect(isCryptoPerp({ symbol: 'MDTSTOCKUSDT', symbolType: 'stock' })).toBe(false);
        });

        it('disqualifies contracts without orderbook depth coverage between launch+1h and launch+6h', () => {
            const firstSnapshotTs = 1792858680000;
            const launchTime = firstSnapshotTs + 10000;
            const detectedAt = launchTime + 10 * 60 * 1000; // detected 10m post launch (valid event)

            db.insertListingEvents([{
                symbol: 'TESTNEWUSDT',
                eventType: 'LISTING',
                prevStatus: null,
                newStatus: 'Trading',
                launchTime,
                detectedAt,
                details: 'Valid listing event'
            }]);

            // Store baseline initial snapshot and snapshot for new contract
            db.insertSnapshots([
                makeSnapshot('BTCUSDT', 1600000000000, firstSnapshotTs, ''),
                makeSnapshot('TESTNEWUSDT', launchTime, detectedAt, '')
            ]);

            // Scenario: Zero depth snapshots between launch+1h (3600s) and launch+6h (21600s)
            // Depth only recorded at launch+7h
            db.insertOrderbookSnapshots([{
                symbol: 'TESTNEWUSDT',
                timestamp: launchTime + 7 * 3600 * 1000,
                recordedAt: launchTime + 7 * 3600 * 1000,
                depth: 50,
                bids: [[100, 10]],
                asks: [[101, 10]],
                bestBid: 100,
                bestAsk: 101,
                spread: 1,
                midPrice: 100.5
            }]);

            const validEvents = db.getValidListingEvents();
            expect(validEvents.length).toBe(1);

            // Check H-A eligibility query logic: depth count between launch+1h and launch+6h must be > 0
            const checkDepth = rawDb.prepare(`
                SELECT COUNT(*) as depthCount
                FROM orderbook_snapshots
                WHERE symbol = ? AND recorded_at >= ? AND recorded_at <= ?
            `).get('TESTNEWUSDT', launchTime + 3600000, launchTime + 6 * 3600000) as { depthCount: number };

            expect(checkDepth.depthCount).toBe(0); // Ineligible!
        });
    });

    describe('Requirement 4: Rate Limiting & Error 10006 Backoff Behavior', () => {
        it('tracks requests in 5-second windows', () => {
            globalRestRateLimiter.reset();
            const res = globalRestRateLimiter.getRequestsPer5sWindows(3600000);
            expect(res.windows5sCount).toBeGreaterThan(0);
            expect(typeof res.peak5sRequests).toBe('number');
            expect(typeof res.avg5sRequests).toBe('number');
        });

        it('records real REST metrics and errors per 5s window and endpoint in DB', () => {
            const now = Date.now();
            db.recordRestMetric(now, '/v5/market/tickers', true);
            db.recordRestMetric(now, '/v5/market/tickers', true);
            db.recordRestMetric(now, '/v5/market/kline', false, 10006);
            db.recordRestMetric(now, '/v5/market/kline', false, 429);

            const metrics = db.getRestMetricsPastHour(now);
            expect(metrics.totalRequests).toBe(4);
            expect(metrics.errors10006).toBe(1);
            expect(metrics.errors429).toBe(1);
            expect(metrics.peak5sRequests).toBe(4);
            expect(metrics.windowDistribution.length).toBe(1);
            expect(metrics.windowDistribution[0].byEndpoint['/v5/market/tickers']).toBe(2);
            expect(metrics.windowDistribution[0].byEndpoint['/v5/market/kline']).toBe(2);
        });
    });

    describe('Requirement 3 & 5: Crypto Classifier UNKNOWN Safety & Gap Separation', () => {
        it('flags unknown symbolType as UNKNOWN and never treats it as crypto', () => {
            const unk1 = classifyContract('MYSTERYUSDT', JSON.stringify({ symbolType: 'exotic_future' }));
            expect(unk1.assetClass).toBe('UNKNOWN');
            expect(unk1.isCrypto).toBe(false);
            expect(unk1.isUnknown).toBe(true);

            // Never silently treated as crypto by isCryptoPerp
            expect(isCryptoPerp('MYSTERYUSDT', JSON.stringify({ symbolType: 'exotic_future' }))).toBe(false);

            // Valid crypto
            const crypto1 = classifyContract('BTCUSDT', JSON.stringify({ symbolType: '' }));
            expect(crypto1.assetClass).toBe('CRYPTO');
            expect(crypto1.isCrypto).toBe(true);
            expect(crypto1.isUnknown).toBe(false);

            // Innovation crypto
            const inno = classifyContract('MEMEUSDT', JSON.stringify({ symbolType: 'innovation' }));
            expect(inno.assetClass).toBe('CRYPTO');
            expect(inno.isCrypto).toBe(true);
            expect(inno.isUnknown).toBe(false);

            // Stock
            const stock = classifyContract('NVDAUSDT', JSON.stringify({ symbolType: 'stock' }));
            expect(stock.assetClass).toBe('STOCK');
            expect(stock.isCrypto).toBe(false);

            // ETF
            const etf = classifyContract('SPYUSDT', JSON.stringify({ symbolType: 'ETF' }));
            expect(etf.assetClass).toBe('ETF');
            expect(etf.isCrypto).toBe(false);

            // Commodity
            const gold = classifyContract('XAUUSDT', JSON.stringify({ symbolType: 'commodity' }));
            expect(gold.assetClass).toBe('COMMODITY');
            expect(gold.isCrypto).toBe(false);

            // Forex
            const fx = classifyContract('EURUSDT', JSON.stringify({ symbolType: 'forex' }));
            expect(fx.assetClass).toBe('FOREX');
            expect(fx.isCrypto).toBe(false);
        });

        it('separates unrecoverable stream gaps from open/recoverable candle gaps', () => {
            const now = Date.now();
            // Insert unrecoverable stream gap (streams_lost: liquidations/orderbook)
            db.recordGap({
                symbol: 'ALL',
                dataType: 'streams_lost',
                gapStart: now - 10000,
                gapEnd: now,
                missingCount: 1,
                detectedAt: now,
                cause: 'WebSocket disconnect; liquidations and orderbook lost'
            });

            // Insert open recoverable gap (kline_1m)
            db.recordGap({
                symbol: 'BTCUSDT',
                dataType: 'kline_1m',
                gapStart: now - 300000,
                gapEnd: now,
                missingCount: 5,
                detectedAt: now,
                cause: 'Missing 1m bars'
            });

            const unres = db.getUnresolvedGaps();
            expect(unres.length).toBe(2);

            // Test query classifying categories
            const unrecGaps = rawDb.prepare(`
                SELECT COUNT(*) as cnt FROM data_gaps
                WHERE data_type = 'streams_lost' OR data_type LIKE '%stream%' OR data_type LIKE '%liq%' OR data_type LIKE '%orderbook%'
            `).get() as { cnt: number };
            expect(unrecGaps.cnt).toBe(1);

            const openRecGaps = rawDb.prepare(`
                SELECT COUNT(*) as cnt FROM data_gaps
                WHERE resolved_at IS NULL AND data_type NOT IN ('streams_lost') AND data_type NOT LIKE '%stream%' AND data_type NOT LIKE '%liq%' AND data_type NOT LIKE '%orderbook%'
            `).get() as { cnt: number };
            expect(openRecGaps.cnt).toBe(1);
        });
    });

    describe('Requirement 6: Dynamic WebSocket Subscription Without Dropping Shards', () => {
        it('adding a listing subscribes dynamically via addNewListing and NEVER tears down WS connections', async () => {
            const initialSnapshotTs = 1792858680000;
            // Existing universe in DB
            db.insertSnapshots([
                makeSnapshot('BTCUSDT', 1600000000000, initialSnapshotTs),
                makeSnapshot('ETHUSDT', 1600000000000, initialSnapshotTs)
            ]);

            const mockWs = makeMockWsClient();
            const mockClient = {
                fetchAllLinearContracts: vi.fn().mockImplementation(async (ts: number = Date.now()) => [
                    makeSnapshot('BTCUSDT', 1600000000000, ts),
                    makeSnapshot('ETHUSDT', 1600000000000, ts),
                    // New listing appears
                    makeSnapshot('NEWCOINUSDT', Date.now() - 60000, ts)
                ]),
                subscribeOrderbook: vi.fn(),
                subscribeLiquidations: vi.fn(),
                fetchAllTickers: vi.fn().mockResolvedValue({ fundingRates: [], openInterests: [] }),
                onRateLimitMetrics: vi.fn(),
                requestTimestamps: []
            } as unknown as BybitPublicClient;

            const service = new RecorderService({
                dbPath: ':memory:',
                snapshotIntervalMs: 100000,
                tickerPollIntervalMs: 100000
            }, db, mockClient, mockWs);

            // Seed active contracts from DB
            service.loadActiveContractsFromDb();

            // Trigger snapshot where new listing is detected
            await service.takeContractSnapshot();

            // Assertions:
            // 1. addNewListing was called dynamically for NEWCOINUSDT
            expect(mockWs.addNewListing).toHaveBeenCalledWith('NEWCOINUSDT', true);

            // 2. setTrackedSymbols was NOT called (which would have torn down all shards)
            expect(mockWs.setTrackedSymbols).not.toHaveBeenCalled();

            // 3. stop was NOT called
            expect(mockWs.stop).not.toHaveBeenCalled();
        });
    });
});

