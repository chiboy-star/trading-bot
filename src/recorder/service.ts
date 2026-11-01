import { RecorderDB } from './db';
import { BybitPublicClient } from './bybit_client';
import { BybitPublicWSClient } from './ws_client';
import { GapFiller } from './gap_filler';
import { QualityReporter } from './quality_report';
import { ContractSnapshot, ListingEvent, RecorderHeartbeat } from './types';
import { createLogger } from '../utils/logger';
import { sendDiscordAlert } from '../services/notifier';
import fs from 'fs';

const log = createLogger('recorder-service');

export interface RecorderServiceConfig {
    dbPath?: string;
    primaryRestHost?: string;
    fallbackRestHost?: string;
    primaryWsUrl?: string;
    fallbackWsUrl?: string;
    snapshotIntervalMs?: number; // default: 1 hour (3,600,000ms)
    tickerPollIntervalMs?: number; // default: 1 minute (60,000ms)
    heartbeatCheckIntervalMs?: number; // default: 1 minute (60,000ms)
    staleDataThresholdMs?: number; // default: 5 minutes (300,000ms)
    wsShardCapacity?: number; // default: 100 topics per WS connection
}

export class RecorderService {
    public readonly db: RecorderDB;
    public readonly client: BybitPublicClient;
    public readonly wsClient: BybitPublicWSClient;
    public readonly gapFiller: GapFiller;
    public readonly reporter: QualityReporter;

    private config: Required<RecorderServiceConfig>;
    private isRunning: boolean = false;
    private snapshotTimer: any = null;
    private tickerTimer: any = null;
    private heartbeatTimer: any = null;
    private klineQueueTimer: any = null;

    private lastDataTime: number = Date.now();
    private activeContracts: Map<string, ContractSnapshot> = new Map();
    private recentListings: Set<string> = new Set();
    private staleAlertTriggered: boolean = false;
    private klineCycleIndex: number = 0;
    private isPollingKlinesBatch: boolean = false;

    // Outage and DNS Resilience Tracking
    private wsOutageStart: number | null = null;
    private restOutageStart: number | null = null;
    private dnsFailuresCount24h: number = 0;
    private lastDnsFailureTime: number = 0;
    private lastKlineTimestamp: Map<string, number> = new Map();

    constructor(
        config: RecorderServiceConfig = {},
        db?: RecorderDB,
        client?: BybitPublicClient,
        wsClient?: BybitPublicWSClient
    ) {
        this.config = {
            dbPath: config.dbPath || '',
            primaryRestHost: config.primaryRestHost || 'https://api.bybit.com',
            fallbackRestHost: config.fallbackRestHost || 'https://api.bytick.com',
            primaryWsUrl: config.primaryWsUrl || 'wss://stream.bybit.com/v5/public/linear',
            fallbackWsUrl: config.fallbackWsUrl || 'wss://stream.bytick.com/v5/public/linear',
            snapshotIntervalMs: config.snapshotIntervalMs || 3600000, // 1 hour
            tickerPollIntervalMs: config.tickerPollIntervalMs || 60000, // 1 min
            heartbeatCheckIntervalMs: config.heartbeatCheckIntervalMs || 60000, // 1 min
            staleDataThresholdMs: config.staleDataThresholdMs || 300000, // 5 min
            wsShardCapacity: config.wsShardCapacity || 100 // 100 topics per shard
        };

        this.db = db || new RecorderDB(this.config.dbPath || undefined);
        this.client = client || new BybitPublicClient({
            primaryHost: this.config.primaryRestHost,
            fallbackHost: this.config.fallbackRestHost,
            rateLimitDelayMs: 60
        });
        this.wsClient = wsClient || new BybitPublicWSClient({
            primaryUrl: this.config.primaryWsUrl,
            fallbackUrl: this.config.fallbackWsUrl,
            shardCapacity: this.config.wsShardCapacity
        });
        this.gapFiller = new GapFiller(this.client, this.db);
        this.reporter = new QualityReporter(this.db);

        // Wire REST request telemetry to SQLite database table
        this.client.onRequestMetric = (ts, ep, ok, errCode) => {
            this.db.recordRestMetric(ts, ep, ok, errCode);
        };

        // RESTART PROTECTION: Load existing active contracts from SQLite snapshot on startup
        this.loadActiveContractsFromDb();

        this.setupWsHandlers();
    }

    private setupWsHandlers(): void {
        this.wsClient.onLiquidation = (record) => {
            this.lastDataTime = Date.now();
            this.db.insertLiquidations([record]);
        };

        this.wsClient.onOrderbook = (snapshot) => {
            this.lastDataTime = Date.now();
            this.db.insertOrderbookSnapshots([snapshot]);
        };

        this.wsClient.onStatus = (status) => {
            log.info({ status }, 'WebSocket aggregate connection status updated');

            if (status === 'RECONNECTING' || status === 'DISCONNECTED') {
                if (!this.wsOutageStart) {
                    this.wsOutageStart = Date.now();
                    log.warn({ status, start: new Date(this.wsOutageStart).toISOString() }, '[OUTAGE] WebSocket disconnect/reconnect outage detected');
                }
            } else if (status === 'CONNECTED') {
                if (this.wsOutageStart) {
                    const outageEnd = Date.now();
                    const duration = outageEnd - this.wsOutageStart;
                    const durationMinutes = Math.max(1, Math.round(duration / 60000));
                    log.warn({ durationSeconds: Math.round(duration / 1000) }, '[OK] WebSocket connection restored; recording streams_lost in data_gaps');

                    // Record streams_lost into data_gaps
                    this.db.recordGap({
                        symbol: 'ALL',
                        dataType: 'streams_lost',
                        gapStart: this.wsOutageStart,
                        gapEnd: outageEnd,
                        missingCount: durationMinutes,
                        detectedAt: outageEnd,
                        resolvedAt: outageEnd,
                        cause: `WebSocket disconnected/reconnecting (${Math.round(duration / 1000)}s); liquidations and orderbook snapshots permanently lost`
                    });

                    const outageStart = this.wsOutageStart;
                    this.wsOutageStart = null;

                    // Trigger immediate post-outage backfill for klines, funding, and open interest
                    const symbols = Array.from(this.activeContracts.keys());
                    this.gapFiller.backfillAfterOutage(symbols, outageStart, outageEnd, 'ws_disconnect').catch(err => {
                        log.error({ err: err?.message || err }, 'Post-outage backfill error');
                    });
                }
            }
        };

        // Listen for DNS failures from REST client
        this.client.onDnsFailure = (hostname, err) => {
            this.dnsFailuresCount24h++;
            this.lastDnsFailureTime = Date.now();
            this.db.recordGap({
                symbol: 'ALL',
                dataType: 'network_outage',
                gapStart: Date.now(),
                gapEnd: Date.now(),
                missingCount: 0,
                detectedAt: Date.now(),
                resolvedAt: Date.now(),
                cause: `DNS lookup failure on ${hostname}: ${err?.message || err}`
            });
            log.error({ hostname, err: err?.message, totalDnsFailures: this.dnsFailuresCount24h }, '[ALERT] DNS failure logged');
        };

        // Listen for HTTP 403 bans and log to data_gaps
        this.client.onBanDetected = (lockoutUntil, cause) => {
            const now = Date.now();
            const durationMinutes = Math.max(1, Math.round((lockoutUntil - now) / 60000));
            this.db.recordGap({
                symbol: 'ALL',
                dataType: 'streams_lost',
                gapStart: now,
                gapEnd: lockoutUntil,
                missingCount: durationMinutes,
                detectedAt: now,
                cause: 'HTTP_403_BAN'
            });
            log.fatal({ lockoutUntil: new Date(lockoutUntil).toISOString(), durationMinutes }, '[BAN] HTTP 403 Ban recorded in data_gaps table');
        };
    }

    /**
     * Startup self-check:
     * Verifies network reachability, SQLite WAL pragmas, append-only trigger enforcement, and disk access.
     */
    public async runStartupSelfCheck(): Promise<{
        passed: boolean;
        checks: Record<string, { ok: boolean; message: string }>;
    }> {
        log.info('Running recorder startup self-check...');
        const checks: Record<string, { ok: boolean; message: string }> = {};

        // 1. Network Connectivity to Bybit REST
        try {
            const timeResult = await this.client['fetchJson']('/v5/market/time');
            checks['rest_api'] = {
                ok: true,
                message: `REST API reachable, server time: ${timeResult?.timeSecond || 'OK'}`
            };
        } catch (err: any) {
            checks['rest_api'] = { ok: false, message: `REST API unreachable: ${err.message}` };
        }

        // 2. SQLite Journal Mode and Append-Only Triggers Enforced
        try {
            const rawDb = this.db.getRawDb();
            const journalRow = rawDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
            const isWal = journalRow?.journal_mode === 'wal' || journalRow?.journal_mode === 'memory';

            // Verify all 17 append-only immutability triggers exist in sqlite_master
            const triggerRows = rawDb.prepare(`
                SELECT name FROM sqlite_master WHERE type = 'trigger'
            `).all() as { name: string }[];
            const triggerNames = new Set(triggerRows.map(r => r.name));

            const requiredTriggers = [
                'abort_update_contract_snapshots', 'abort_delete_contract_snapshots',
                'abort_update_listing_events', 'abort_delete_listing_events',
                'abort_update_klines_1m', 'abort_delete_klines_1m',
                'abort_update_funding_rates', 'abort_delete_funding_rates',
                'abort_update_open_interest', 'abort_delete_open_interest',
                'abort_update_liquidations', 'abort_delete_liquidations',
                'abort_update_orderbook_snapshots', 'abort_delete_orderbook_snapshots',
                'abort_update_recorder_heartbeats', 'abort_delete_recorder_heartbeats',
                'abort_delete_data_gaps'
            ];
            const allTriggersPresent = requiredTriggers.every(name => triggerNames.has(name));

            // Verify triggers actively block UPDATE and DELETE
            let updateBlocked = false;
            let deleteBlocked = false;

            rawDb.exec('BEGIN TRANSACTION');
            try {
                rawDb.prepare(`
                    INSERT INTO recorder_heartbeats (timestamp, active_symbols_count, status, last_data_timestamp, details)
                    VALUES (9999999999999, 1, 'HEALTHY', 9999999999999, '__SELF_CHECK__')
                `).run();

                try {
                    rawDb.prepare(`
                        UPDATE recorder_heartbeats SET status = 'STALE' WHERE details = '__SELF_CHECK__'
                    `).run();
                } catch {
                    updateBlocked = true;
                }

                try {
                    rawDb.prepare(`
                        DELETE FROM recorder_heartbeats WHERE details = '__SELF_CHECK__'
                    `).run();
                } catch {
                    deleteBlocked = true;
                }
            } finally {
                rawDb.exec('ROLLBACK');
            }

            const triggersActive = allTriggersPresent && updateBlocked && deleteBlocked;
            checks['database'] = {
                ok: isWal && triggersActive,
                message: `SQLite journal_mode=${journalRow?.journal_mode}, append-only triggers enforced=${triggersActive} (${triggerNames.size}/17 registered, updateBlock=${updateBlocked}, deleteBlock=${deleteBlocked})`
            };
        } catch (err: any) {
            checks['database'] = { ok: false, message: `Database check failed: ${err.message}` };
        }

        // 3. Disk Storage / Path Writable
        try {
            const dbDir = this.db.dbPath ? require('path').dirname(this.db.dbPath) : '.';
            if (fs.existsSync(dbDir)) {
                checks['disk_storage'] = { ok: true, message: `Storage accessible at ${this.db.dbPath}` };
            } else {
                checks['disk_storage'] = { ok: false, message: `Storage directory does not exist: ${dbDir}` };
            }
        } catch (err: any) {
            checks['disk_storage'] = { ok: false, message: `Storage check failed: ${err.message}` };
        }

        const passed = Object.values(checks).every(c => c.ok);
        log.info({ passed, checks }, 'Startup self-check completed');
        return { passed, checks };
    }

    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDataTime = Date.now();
        log.info('Starting Bybit Market Data Recorder Service (Full Universe Mode)...');

        // Run self-check and refuse to start if it fails
        const selfCheck = await this.runStartupSelfCheck();
        if (!selfCheck.passed) {
            this.isRunning = false;
            const failures = Object.entries(selfCheck.checks)
                .filter(([_, c]) => !c.ok)
                .map(([k, c]) => `${k}: ${c.message}`)
                .join('; ');
            log.fatal({ failures }, '[FATAL] Recorder startup self-check failed! Refusing to start recording.');
            throw new Error(`Recorder startup self-check failed: ${failures}`);
        }

        // 1. Initial snapshot of all linear contracts & detect listings/delistings
        try {
            await this.takeContractSnapshot();
        } catch (err: any) {
            log.error({ err }, 'Initial contract snapshot failed');
        }

        // 2. Identify contracts within first 72h of listing
        this.updateRecentListings();

        // 3. Configure Sharded WS: ALL active linear contracts subscribed to liquidations!
        const obSymbols = this.getDepthTrackedSymbols();
        const allLinearSymbols = Array.from(this.activeContracts.keys());
        this.wsClient.setTrackedSymbols(obSymbols, allLinearSymbols);
        this.wsClient.start();

        // 4. Initial poll for tickers & funding
        await this.pollTickers();

        // 5. Launch Comprehensive Startup Backfill asynchronously in the background (chunked & throttled)
        const symbols = Array.from(this.activeContracts.keys());
        log.info({ count: symbols.length }, 'Launching background startup backfill across all active contracts...');
        this.gapFiller.backfillStartupGaps(symbols).then(fillSummary => {
            log.info(fillSummary, 'Background startup backfill completed successfully');
        }).catch(err => {
            log.error({ err: err?.message || err }, 'Background startup backfill encountered error');
        });

        // 6. Run continuous kline poller for ALL 808 contracts (in rotating batches)
        this.startContinuousKlinePoller();

        // 7. Schedule recurring loops
        this.snapshotTimer = setInterval(() => this.takeContractSnapshot(), this.config.snapshotIntervalMs);
        this.tickerTimer = setInterval(() => this.pollTickers(), this.config.tickerPollIntervalMs);
        this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), this.config.heartbeatCheckIntervalMs);

        // Record initial heartbeat
        this.db.insertHeartbeat({
            timestamp: Date.now(),
            activeSymbolsCount: this.activeContracts.size,
            status: 'HEALTHY',
            lastDataTimestamp: this.lastDataTime,
            details: `Recorder initialized: ${this.activeContracts.size} linear contracts across ${this.wsClient.getShardsCount()} WS shards`
        });

        log.info('Bybit Market Data Recorder is running successfully.');
    }

    public async stop(): Promise<void> {
        if (!this.isRunning) return;
        this.isRunning = false;
        log.info('Gracefully stopping Bybit Market Data Recorder Service...');

        if (this.snapshotTimer) clearInterval(this.snapshotTimer);
        if (this.tickerTimer) clearInterval(this.tickerTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.klineQueueTimer) clearInterval(this.klineQueueTimer);

        this.wsClient.stop();

        this.db.insertHeartbeat({
            timestamp: Date.now(),
            activeSymbolsCount: this.activeContracts.size,
            status: 'HEALTHY',
            lastDataTimestamp: this.lastDataTime,
            details: 'Recorder gracefully shut down'
        });

        this.db.close();
    }

    /**
     * Snapshot all linear instruments, detecting listings and delistings.
     */
    public async takeContractSnapshot(): Promise<void> {
        const snapshotTs = Date.now();
        log.info('Fetching instruments snapshot from Bybit REST API...');

        const currentContracts = await this.client.fetchAllLinearContracts(snapshotTs);
        if (currentContracts.length === 0) {
            log.warn('Instruments snapshot returned 0 contracts, aborting snapshot persist.');
            return;
        }

        this.db.insertSnapshots(currentContracts);
        this.lastDataTime = Date.now();

        const currentSymbolMap = new Map<string, ContractSnapshot>();
        for (const c of currentContracts) {
            currentSymbolMap.set(c.symbol, c);
        }

        // COLD-START PROTECTION:
        // If this.activeContracts is empty (first ever run on fresh DB), establish baseline
        // and do not create false listing events for pre-existing contracts.
        if (this.activeContracts.size === 0) {
            log.info({ totalContracts: currentContracts.length }, 'Cold start initial snapshot captured. Initializing active contracts baseline (no false listing events emitted).');
            this.activeContracts = currentSymbolMap;
            this.updateRecentListings();
            return;
        }

        const events: ListingEvent[] = [];

        // Check for new listings
        for (const [sym, contract] of currentSymbolMap.entries()) {
            if (!this.activeContracts.has(sym)) {
                const event: ListingEvent = {
                    symbol: sym,
                    eventType: 'LISTING',
                    prevStatus: null,
                    newStatus: contract.status || 'Trading',
                    detectedAt: snapshotTs,
                    launchTime: contract.launchTime || null,
                    details: `New linear contract detected: ${sym} (Base: ${contract.baseCoin}, Tick: ${contract.tickSize})`
                };
                events.push(event);
                log.info({ symbol: sym }, '[NEW_LISTING] NEW CONTRACT LISTING DETECTED');

                // Trigger immediate backfill for new listing from its first minute
                if (contract.launchTime > 0) {
                    this.backfillNewListingFromFirstMinute(sym, contract.launchTime);
                }
            }
        }

        // Check for delistings
        for (const [sym, contract] of this.activeContracts.entries()) {
            if (!currentSymbolMap.has(sym)) {
                const event: ListingEvent = {
                    symbol: sym,
                    eventType: 'DELISTING',
                    prevStatus: contract.status || 'Trading',
                    newStatus: 'Delisted',
                    detectedAt: snapshotTs,
                    launchTime: contract.launchTime || null,
                    details: `Contract delisted or removed from active linear instruments: ${sym}`
                };
                events.push(event);
                log.warn({ symbol: sym }, '[DELISTING] CONTRACT DELISTING DETECTED');
            }
        }

        if (events.length > 0) {
            this.db.insertListingEvents(events);
            this.updateRecentListings();

            // Dynamically add new listing topics without tearing down existing WS connections
            const listingEvents = events.filter(e => e.eventType === 'LISTING');
            for (const le of listingEvents) {
                const isWithin72h = le.launchTime ? (Date.now() - le.launchTime <= 72 * 3600 * 1000) : true;
                this.wsClient.addNewListing(le.symbol, isWithin72h);
            }
        }

        this.activeContracts = currentSymbolMap;

        log.info({
            snapshotTs,
            totalContracts: currentContracts.length,
            eventsDetected: events.length
        }, 'Hourly contract snapshot completed successfully');
    }

    /**
     * Loads active contracts from the most recent database snapshot to prevent false listing events on restart.
     */
    public loadActiveContractsFromDb(): void {
        const latestTs = this.db.getLatestSnapshotTimestamp();
        if (latestTs) {
            const snapshots = this.db.getSnapshotsByTimestamp(latestTs);
            for (const s of snapshots) {
                this.activeContracts.set(s.symbol, s);
            }
            log.info({ count: this.activeContracts.size, snapshotTs: latestTs }, 'Restored active contracts from previous database snapshot (restart protection active)');
        }
    }

    private async backfillNewListingFromFirstMinute(symbol: string, launchTime: number): Promise<void> {
        try {
            const startTs = Math.max(launchTime, Date.now() - 72 * 3600 * 1000);
            const klines = await this.client.fetch1mKlines(symbol, 200, startTs);
            if (klines.length > 0) {
                this.db.insertKlines(klines);
                log.info({ symbol, count: klines.length }, 'New listing backfilled from first minute');
            }
        } catch (err: any) {
            log.warn({ symbol, err: err.message }, 'Failed to backfill new listing first minute');
        }
    }

    private updateRecentListings(): void {
        const now = Date.now();
        const seventyTwoHoursMs = 72 * 3600 * 1000;
        this.recentListings.clear();

        for (const [sym, contract] of this.activeContracts.entries()) {
            if (contract.launchTime > 0 && (now - contract.launchTime) < seventyTwoHoursMs) {
                this.recentListings.add(sym);
            }
        }

        log.info({ recentListingCount: this.recentListings.size }, 'Active listings within 72h window updated');
    }

    public getDepthTrackedSymbols(): string[] {
        const set = new Set<string>(['BTCUSDT', 'ETHUSDT']);
        for (const sym of this.recentListings) {
            set.add(sym);
        }
        return Array.from(set);
    }

    /**
     * Batch poll funding rates and open interest for ALL linear contracts in 1 request.
     */
    public async pollTickers(): Promise<void> {
        try {
            const recordedAt = Date.now();
            const { fundingRates, openInterests } = await this.client.fetchAllTickers(recordedAt);

            if (fundingRates.length > 0) {
                this.db.insertFundingRates(fundingRates);
                this.lastDataTime = Date.now();
            }
            if (openInterests.length > 0) {
                this.db.insertOpenInterest(openInterests);
                this.lastDataTime = Date.now();
            }

            // If a previous REST outage was in progress, record its resolution in data_gaps
            if (this.restOutageStart) {
                const outageEnd = Date.now();
                const durationMinutes = Math.max(1, Math.round((outageEnd - this.restOutageStart) / 60000));
                this.db.recordGap({
                    symbol: 'ALL',
                    dataType: 'network_outage',
                    gapStart: this.restOutageStart,
                    gapEnd: outageEnd,
                    missingCount: durationMinutes,
                    detectedAt: outageEnd,
                    resolvedAt: outageEnd,
                    cause: 'REST poll tickers outage resolved'
                });
                this.restOutageStart = null;
            }

            log.info({
                fundingRatesCount: fundingRates.length,
                openInterestsCount: openInterests.length
            }, 'Tickers & Funding Rates recorded for all active contracts');
        } catch (err: any) {
            if (!this.restOutageStart) {
                this.restOutageStart = Date.now();
            }
            log.error({ err: err?.message || err }, 'Failed to poll tickers');
        }
    }

    /**
     * Continuous 1-minute klines poller for ALL 811 listed contracts:
     * Ingests 1m klines in rotating batches of 8 symbols every 1.0 second (~8-10 req/s),
     * cycling through all contracts smoothly with 80ms spacing per call.
     * Capped well below Bybit rate limits and eliminates burst spikes.
     */
    private startContinuousKlinePoller(): void {
        const batchSize = 8;
        const batchIntervalMs = 1000;

        this.klineQueueTimer = setInterval(async () => {
            if (!this.isRunning || this.isPollingKlinesBatch) return;
            const symbols = Array.from(this.activeContracts.keys());
            if (symbols.length === 0) return;

            this.isPollingKlinesBatch = true;
            try {
                const startIdx = this.klineCycleIndex % symbols.length;
                const batch = symbols.slice(startIdx, startIdx + batchSize);
                this.klineCycleIndex += batch.length;

                const now = Date.now();
                for (const sym of batch) {
                    if (!this.isRunning) break;
                    try {
                        const lastTs = this.lastKlineTimestamp.get(sym) || this.db.getLatestKlineTimestamp(sym) || (now - 60000);
                        const elapsedMinutes = Math.max(1, Math.ceil((now - lastTs) / 60000));
                        // Dynamic limit capped at 60 to prevent large request payloads
                        const limit = Math.min(60, Math.max(5, elapsedMinutes + 2));

                        const klines = await this.client.fetch1mKlines(sym, limit);
                        if (klines.length > 0) {
                            this.db.insertKlines(klines);
                            const latest = klines[klines.length - 1].timestamp;
                            this.lastKlineTimestamp.set(sym, latest);
                            this.lastDataTime = Date.now();

                            // Detect internal kline gaps
                            if (lastTs > 0 && klines[0].timestamp - lastTs > 120000) {
                                const missing = Math.floor((klines[0].timestamp - lastTs) / 60000) - 1;
                                this.db.recordGap({
                                    symbol: sym,
                                    dataType: 'kline_1m',
                                    gapStart: lastTs + 60000,
                                    gapEnd: klines[0].timestamp - 60000,
                                    missingCount: missing,
                                    detectedAt: now,
                                    cause: 'kline_rotation_lag'
                                });
                            }
                        }
                    } catch (err: any) {
                        log.warn({ symbol: sym, err: err?.message || err }, 'Failed to fetch klines for symbol in batch');
                    }
                    // Pace requests evenly with 80ms delay to eliminate micro-bursts
                    await new Promise(r => setTimeout(r, 80));
                }
            } finally {
                this.isPollingKlinesBatch = false;
            }
        }, batchIntervalMs);
    }

    private checkHeartbeat(): void {
        const now = Date.now();
        const silenceDurationMs = now - this.lastDataTime;
        const silenceSeconds = Math.round(silenceDurationMs / 1000);

        let status: 'HEALTHY' | 'DEGRADED' | 'STALE' = 'HEALTHY';
        let details = `Healthy recording: silence ${silenceSeconds}s`;

        if (this.wsOutageStart || this.restOutageStart) {
            status = 'DEGRADED';
            const dur = Math.round((now - (this.wsOutageStart || this.restOutageStart || now)) / 1000);
            details = `Active network/WS outage in progress: ${dur}s duration. DNS failures: ${this.dnsFailuresCount24h}`;
        } else if (silenceDurationMs > this.config.staleDataThresholdMs) {
            status = 'STALE';
            const silenceMinutes = Math.round(silenceDurationMs / 60000);
            details = `Silence alert: ${silenceMinutes} minutes without data. DNS failures: ${this.dnsFailuresCount24h}`;
            log.error({ silenceMinutes }, '[ALERT] STALE DATA ALERT: No recorder data received!');

            if (!this.staleAlertTriggered) {
                this.staleAlertTriggered = true;
                sendDiscordAlert({
                    title: `[RECORDER HEARTBEAT WARNING] Data Stale`,
                    description: `No market data received from Bybit for **${silenceMinutes} minutes**.\nTriggering reconnect on all WS shards.`,
                    color: 15158332,
                    fields: [
                        { name: "Silence Duration", value: `${silenceMinutes} mins`, inline: true },
                        { name: "Status", value: "STALE", inline: true }
                    ],
                    timestamp: new Date(now).toISOString()
                }).catch(() => {});
            }

            this.wsClient.stop();
            this.wsClient.start();
        } else if (silenceSeconds > 30) {
            status = 'DEGRADED';
            details = `Elevated latency: silence ${silenceSeconds}s. DNS failures: ${this.dnsFailuresCount24h}`;
        } else if (this.dnsFailuresCount24h > 0) {
            details = `Healthy recording: silence ${silenceSeconds}s (${this.dnsFailuresCount24h} DNS fallbacks in 24h)`;
        }

        this.db.insertHeartbeat({
            timestamp: now,
            activeSymbolsCount: this.activeContracts.size,
            status,
            lastDataTimestamp: this.lastDataTime,
            details
        });
    }
}
