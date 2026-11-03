import { RecorderDB } from './db';
import { BybitPublicClient } from './bybit_client';
import { BybitPublicWSClient } from './ws_client';
import { GapFiller } from './gap_filler';
import { QualityReporter } from './quality_report';
import { ContractSnapshot, ListingEvent, RecorderHeartbeat, DataEpoch } from './types';
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
    healthcheckUrl?: string;
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
    private restRetryTimer: any = null;

    // Per-stream freshness timestamps
    private lastDataTime: number = Date.now();
    private lastKlineTime: number = 0;
    private lastLiquidationEventTime: number = 0;
    private lastOrderbookTime: number = 0;
    private lastTickerTime: number = 0;

    private activeContracts: Map<string, ContractSnapshot> = new Map();
    private recentListings: Set<string> = new Set();
    private staleAlertTriggered: boolean = false;
    private klineCycleIndex: number = 0;
    private isPollingKlinesBatch: boolean = false;

    // Outage and DNS Resilience Tracking (sliding 24h window)
    private activeOutageGapId: number | null = null;
    private activeOutageStart: number | null = null;
    private isRestDegraded: boolean = false;
    private dnsFailureTimestamps: number[] = [];
    private lastKlineTimestamp: Map<string, number> = new Map();
    private consecutiveSnapshotFailures: number = 0;

    // Single-flight backfill mutex
    private isBackfilling: boolean = false;
    private pendingBackfillRequested: boolean = false;

    // OI throttling tracking
    private lastOiSampleTime: number = 0;

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
            wsShardCapacity: config.wsShardCapacity || 100, // 100 topics per shard
            healthcheckUrl: config.healthcheckUrl || process.env.HEALTHCHECK_URL || ''
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
        this.reporter = new QualityReporter(this.db, this.client);

        // Wire REST request telemetry to SQLite database table
        this.client.onRequestMetric = (ts, ep, ok, errCode) => {
            this.db.recordRestMetric(ts, ep, ok, errCode);
        };

        // Ensure clean data epoch exists
        this.ensureCleanDataEpoch();

        // Restore active contracts from database
        this.loadActiveContractsFromDb();

        this.setupWsHandlers();
        this.setupRestEventHandlers();
        RecorderService.setupProcessSafetyHandlers();
    }

    public static setupProcessSafetyHandlers(): void {
        process.on('unhandledRejection', (reason: any) => {
            const msg = reason?.message || String(reason);
            log.error({ reason: msg, stack: reason?.stack }, '[PROCESS_SAFETY] Unhandled Rejection detected');
            if (/database disk image is malformed|file is encrypted|disk I\/O error|database or disk is full/i.test(msg)) {
                log.fatal('[FATAL_DB_CORRUPTION] Critical unrecoverable database corruption. Terminating process.');
                process.exit(1);
            }
        });

        process.on('uncaughtException', (err: Error) => {
            const msg = err?.message || String(err);
            log.error({ error: msg, stack: err?.stack }, '[PROCESS_SAFETY] Uncaught Exception detected');
            if (/database disk image is malformed|file is encrypted|disk I\/O error|database or disk is full/i.test(msg)) {
                log.fatal('[FATAL_DB_CORRUPTION] Critical unrecoverable database corruption. Terminating process.');
                process.exit(1);
            }
        });
    }

    private ensureCleanDataEpoch(): void {
        try {
            const epochs = this.db.getEpochs();
            const phase2EpochId = 'clean_data_phase2';
            const exists = epochs.some(e => e.epochId === phase2EpochId);
            if (!exists) {
                const epoch: DataEpoch = {
                    epochId: phase2EpochId,
                    startedAt: Date.now(),
                    description: 'Phase 2: Corrected orderbook snapshot/delta local book, filtered forming klines, throttled open interest'
                };
                this.db.insertEpoch(epoch);
                log.info(epoch, 'Registered clean data epoch in data_epochs table');
            }
        } catch (err: any) {
            log.warn({ err: err?.message }, 'Failed to check/insert clean data epoch');
        }
    }

    private setupWsHandlers(): void {
        this.wsClient.onLiquidation = (record) => {
            const now = Date.now();
            this.lastDataTime = now;
            this.lastLiquidationEventTime = now;
            try {
                this.db.insertLiquidations([record]);
            } catch (err: any) {
                log.error({ err: err?.message, symbol: record.symbol }, 'Failed to insert liquidation record');
            }
        };

        this.wsClient.onOrderbook = (snapshot) => {
            const now = Date.now();
            this.lastDataTime = now;
            this.lastOrderbookTime = now;
            try {
                this.db.insertOrderbookSnapshots([snapshot]);
            } catch (err: any) {
                log.error({ err: err?.message, symbol: snapshot.symbol }, 'Failed to insert orderbook snapshot');
            }
        };

        this.wsClient.onStatus = (status, downShards) => {
            log.info({ status, downShards }, 'WebSocket aggregate connection status updated');

            if (status === 'DEGRADED' || status === 'RECONNECTING' || status === 'DISCONNECTED') {
                this.onOutageStarted(`WebSocket aggregate status: ${status} (down shards: ${downShards?.join(',') || 'all'})`);
            } else if (status === 'CONNECTED' && !this.isRestDegraded) {
                this.onOutageResolved();
            }
        };
    }

    private setupRestEventHandlers(): void {
        // Listen for DNS failures: count in sliding memory window and rest_request_metrics; DO NOT insert per-failure data_gaps
        this.client.onDnsFailure = (hostname, err) => {
            const now = Date.now();
            this.dnsFailureTimestamps.push(now);
            this.pruneDnsFailures(now);
            log.error({ hostname, err: err?.message, count24h: this.dnsFailureTimestamps.length }, '[ALERT] DNS failure detected');
        };

        // Listen for HTTP 403 bans: opens an outage record
        this.client.onBanDetected = (lockoutUntil, cause) => {
            const now = Date.now();
            this.isRestDegraded = true;
            this.onOutageStarted(`HTTP 403 ban active until ${new Date(lockoutUntil).toISOString()} (${cause})`);
            log.fatal({ lockoutUntil: new Date(lockoutUntil).toISOString() }, '[BAN] HTTP 403 Ban detected on REST');
        };
    }

    private pruneDnsFailures(now: number = Date.now()): void {
        const threshold = now - 86400000;
        this.dnsFailureTimestamps = this.dnsFailureTimestamps.filter(ts => ts >= threshold);
    }

    public getDnsFailures24h(): number {
        this.pruneDnsFailures();
        return this.dnsFailureTimestamps.length;
    }

    private onOutageStarted(cause: string): void {
        if (!this.activeOutageStart) {
            this.activeOutageStart = Date.now();
            this.activeOutageGapId = this.db.recordGap({
                symbol: 'ALL',
                dataType: 'network_outage',
                gapStart: this.activeOutageStart,
                gapEnd: this.activeOutageStart,
                missingCount: 0,
                detectedAt: this.activeOutageStart,
                cause
            });
            log.warn({ outageStart: new Date(this.activeOutageStart).toISOString(), cause }, '[OUTAGE_OPEN] Outage record opened');
        }
    }

    private onOutageResolved(): void {
        if (this.activeOutageStart && this.activeOutageGapId) {
            const outageEnd = Date.now();
            const durationMs = outageEnd - this.activeOutageStart;
            const durationMinutes = Math.max(1, Math.round(durationMs / 60000));

            this.db.resolveGap(this.activeOutageGapId, outageEnd);
            log.info({ durationMinutes }, '[OUTAGE_RESOLVED] Outage closed successfully');

            // Record unrecoverable stream loss for WS outage duration
            this.db.recordGap({
                symbol: 'ALL',
                dataType: 'streams_lost',
                gapStart: this.activeOutageStart,
                gapEnd: outageEnd,
                missingCount: durationMinutes,
                detectedAt: outageEnd,
                resolvedAt: outageEnd,
                cause: `Outage duration ${durationMinutes}m: streaming liquidations and orderbook snapshots cannot be backfilled`
            });

            this.activeOutageGapId = null;
            this.activeOutageStart = null;
            this.isRestDegraded = false;

            // Trigger single-flight post-outage backfill for klines
            this.triggerPostOutageBackfill();
        }
    }

    private triggerPostOutageBackfill(): void {
        if (this.isBackfilling) {
            this.pendingBackfillRequested = true;
            return;
        }

        this.isBackfilling = true;
        const symbols = Array.from(this.activeContracts.keys());

        log.info({ symbolsCount: symbols.length }, 'Starting single-flight post-outage kline backfill...');
        this.gapFiller.backfillStartupGaps(symbols, 1440)
            .then(summary => {
                log.info(summary, 'Post-outage backfill completed');
            })
            .catch(err => {
                log.error({ err: err?.message || err }, 'Post-outage backfill error');
            })
            .finally(() => {
                this.isBackfilling = false;
                if (this.pendingBackfillRequested) {
                    this.pendingBackfillRequested = false;
                    this.triggerPostOutageBackfill();
                }
            });
    }

    public async runStartupSelfCheck(): Promise<{
        passed: boolean;
        checks: Record<string, { ok: boolean; message: string }>;
    }> {
        log.info('Running recorder startup self-check...');
        const checks: Record<string, { ok: boolean; message: string }> = {};

        // 1. Network Connectivity to Bybit REST
        try {
            const timeResult = await this.client.fetchJson('/v5/market/time');
            checks['rest_api'] = {
                ok: true,
                message: `REST API reachable, server time: ${timeResult?.timeSecond || 'OK'}`
            };
        } catch (err: any) {
            checks['rest_api'] = {
                ok: false,
                message: `REST API unreachable: ${err.message} (will retry in background; non-fatal)`
            };
        }

        // 2. SQLite Journal Mode and Append-Only Triggers Enforced
        try {
            const rawDb = this.db.getRawDb();
            const journalRow = rawDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
            const isWal = journalRow?.journal_mode === 'wal' || journalRow?.journal_mode === 'memory';

            // Verify append-only triggers exist in sqlite_master
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
                'abort_delete_data_gaps',
                'abort_update_data_epochs', 'abort_delete_data_epochs',
                'abort_update_klines_1m_final', 'abort_delete_klines_1m_final'
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
                message: `SQLite journal_mode=${journalRow?.journal_mode}, append-only triggers enforced=${triggersActive} (${triggerNames.size} registered)`
            };
        } catch (err: any) {
            checks['database'] = { ok: false, message: `Database check failed: ${err.message}` };
        }

        // 3. Disk Storage / Path Writable
        try {
            const dbDir = this.db.dbPath && this.db.dbPath !== ':memory:' ? require('path').dirname(this.db.dbPath) : '.';
            if (fs.existsSync(dbDir)) {
                checks['disk_storage'] = { ok: true, message: `Storage accessible at ${this.db.dbPath}` };
            } else {
                checks['disk_storage'] = { ok: false, message: `Storage directory does not exist: ${dbDir}` };
            }
        } catch (err: any) {
            checks['disk_storage'] = { ok: false, message: `Storage check failed: ${err.message}` };
        }

        // ONLY DB and disk failures are fatal. REST unreachable is non-fatal (self-heals with retries).
        const passed = checks['database'].ok && checks['disk_storage'].ok;
        log.info({ passed, checks }, 'Startup self-check completed');
        return { passed, checks };
    }

    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDataTime = Date.now();
        log.info('Starting Bybit Market Data Recorder Service...');

        // Run self-check: only DB or disk failures abort
        const selfCheck = await this.runStartupSelfCheck();
        if (!selfCheck.passed) {
            this.isRunning = false;
            const fatalFailures = Object.entries(selfCheck.checks)
                .filter(([k, c]) => !c.ok && k !== 'rest_api')
                .map(([k, c]) => `${k}: ${c.message}`)
                .join('; ');
            log.fatal({ fatalFailures }, '[FATAL] Recorder DB/disk startup self-check failed! Refusing to start.');
            throw new Error(`Recorder startup self-check failed: ${fatalFailures}`);
        }

        // 1. Configure and start WebSocket immediately (does not depend on REST)
        const obSymbols = this.getDepthTrackedSymbols();
        const allLinearSymbols = Array.from(this.activeContracts.keys());
        if (allLinearSymbols.length > 0) {
            this.wsClient.setTrackedSymbols(obSymbols, allLinearSymbols);
        } else {
            // Baseline fallback orderbook symbols
            this.wsClient.setTrackedSymbols(['BTCUSDT', 'ETHUSDT'], ['BTCUSDT', 'ETHUSDT']);
        }
        this.wsClient.start();

        // 2. Initial contract snapshot & REST tasks (with resilient retry if REST is currently offline)
        if (selfCheck.checks['rest_api']?.ok) {
            await this.performRestStartupSequence();
        } else {
            log.warn('REST is currently unreachable; starting background retry loop while WS records data.');
            this.startRestRetryLoop();
        }

        // 3. Schedule recurring loops (all safely wrapped in try/catch)
        this.snapshotTimer = setInterval(() => {
            this.takeContractSnapshot().catch(err => log.error({ err: err?.message }, 'Snapshot callback error'));
        }, this.config.snapshotIntervalMs);

        this.tickerTimer = setInterval(() => {
            this.pollTickers().catch(err => log.error({ err: err?.message }, 'Ticker poll callback error'));
        }, this.config.tickerPollIntervalMs);

        this.heartbeatTimer = setInterval(() => {
            try {
                this.checkHeartbeat();
            } catch (err: any) {
                log.error({ err: err?.message }, 'Heartbeat callback error');
            }
        }, this.config.heartbeatCheckIntervalMs);

        // Continuous kline poller on relaxed schedule (low REST load)
        this.startRelaxedKlinePoller();

        // Record initial heartbeat
        this.db.insertHeartbeat({
            timestamp: Date.now(),
            activeSymbolsCount: this.activeContracts.size,
            status: 'HEALTHY',
            lastDataTimestamp: this.lastDataTime,
            details: `Recorder initialized: ${this.activeContracts.size} contracts across ${this.wsClient.getShardsCount()} WS shards`
        });

        log.info('Bybit Market Data Recorder is running successfully.');
    }

    private async performRestStartupSequence(): Promise<void> {
        try {
            await this.takeContractSnapshot();
            this.updateRecentListings();

            // Refresh WS subscriptions with newly snapshot symbols
            const obSymbols = this.getDepthTrackedSymbols();
            const allSymbols = Array.from(this.activeContracts.keys());
            this.wsClient.setTrackedSymbols(obSymbols, allSymbols);

            await this.pollTickers();

            // Background startup backfill
            this.triggerPostOutageBackfill();
        } catch (err: any) {
            log.error({ err: err?.message }, 'Error in REST startup sequence; will retry in background');
            this.startRestRetryLoop();
        }
    }

    private startRestRetryLoop(): void {
        if (this.restRetryTimer) return;
        let delayMs = 5000;
        this.isRestDegraded = true;
        this.onOutageStarted('REST API unreachable on startup');

        const attempt = async () => {
            if (!this.isRunning) return;
            try {
                await this.client.fetchJson('/v5/market/time');
                log.info('REST API has become reachable! Resuming REST startup sequence.');
                this.restRetryTimer = null;
                this.isRestDegraded = false;
                await this.performRestStartupSequence();
                this.onOutageResolved();
            } catch {
                delayMs = Math.min(delayMs * 1.5, 60000);
                log.warn({ retryInSeconds: Math.round(delayMs / 1000) }, 'REST still unreachable, retrying...');
                this.restRetryTimer = setTimeout(attempt, delayMs);
            }
        };

        this.restRetryTimer = setTimeout(attempt, delayMs);
    }

    public async stop(): Promise<void> {
        if (!this.isRunning) return;
        this.isRunning = false;
        log.info('Gracefully stopping Bybit Market Data Recorder Service...');

        if (this.snapshotTimer) clearInterval(this.snapshotTimer);
        if (this.tickerTimer) clearInterval(this.tickerTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.klineQueueTimer) clearInterval(this.klineQueueTimer);
        if (this.restRetryTimer) clearTimeout(this.restRetryTimer);

        this.wsClient.stop();

        try {
            this.db.insertHeartbeat({
                timestamp: Date.now(),
                activeSymbolsCount: this.activeContracts.size,
                status: 'HEALTHY',
                lastDataTimestamp: this.lastDataTime,
                details: 'Recorder gracefully shut down'
            });
            this.db.close();
        } catch {}
    }

    public async takeContractSnapshot(): Promise<void> {
        const snapshotTs = Date.now();
        log.info('Fetching instruments snapshot from Bybit REST API...');

        let currentContracts: ContractSnapshot[] = [];
        try {
            currentContracts = await this.client.fetchAllLinearContracts(snapshotTs);
            this.consecutiveSnapshotFailures = 0;
        } catch (err: any) {
            this.consecutiveSnapshotFailures++;
            log.error({ err: err?.message, consecutiveFailures: this.consecutiveSnapshotFailures }, 'Failed to fetch linear instruments snapshot');
            if (this.consecutiveSnapshotFailures >= 2) {
                sendDiscordAlert({
                    title: '[ALERT] Consecutive Instruments Snapshot Failures',
                    description: `Bybit linear instruments snapshot failed **${this.consecutiveSnapshotFailures} times** consecutively: ${err?.message}`,
                    color: 15158332,
                    fields: [{ name: 'Failures', value: `${this.consecutiveSnapshotFailures}`, inline: true }],
                    timestamp: new Date().toISOString()
                }).catch(() => {});
            }
            return;
        }

        if (currentContracts.length === 0) {
            this.consecutiveSnapshotFailures++;
            log.warn('Instruments snapshot returned 0 contracts; aborting persist.');
            return;
        }

        this.db.insertSnapshots(currentContracts);
        this.lastDataTime = Date.now();

        const currentSymbolMap = new Map<string, ContractSnapshot>();
        for (const c of currentContracts) {
            currentSymbolMap.set(c.symbol, c);
        }

        if (this.activeContracts.size === 0) {
            log.info({ totalContracts: currentContracts.length }, 'Cold start baseline established; no false listing events emitted.');
            this.activeContracts = currentSymbolMap;
            this.updateRecentListings();
            return;
        }

        const events: ListingEvent[] = [];

        // Check new listings
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
            }
        }

        // Check delistings
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

            for (const le of events.filter(e => e.eventType === 'LISTING')) {
                const isWithin72h = le.launchTime ? (Date.now() - le.launchTime <= 72 * 3600 * 1000) : true;
                this.wsClient.addNewListing(le.symbol, isWithin72h);
            }
        }

        this.activeContracts = currentSymbolMap;
        log.info({ snapshotTs, totalContracts: currentContracts.length, eventsDetected: events.length }, 'Hourly contract snapshot completed');
    }

    public loadActiveContractsFromDb(): void {
        const latestTs = this.db.getLatestSnapshotTimestamp();
        if (latestTs) {
            const snapshots = this.db.getSnapshotsByTimestamp(latestTs);
            for (const s of snapshots) {
                this.activeContracts.set(s.symbol, s);
            }
            log.info({ count: this.activeContracts.size, snapshotTs: latestTs }, 'Restored active contracts from previous database snapshot');
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
    }

    public getDepthTrackedSymbols(): string[] {
        const set = new Set<string>(['BTCUSDT', 'ETHUSDT']);
        for (const sym of this.recentListings) {
            set.add(sym);
        }
        return Array.from(set);
    }

    public async pollTickers(): Promise<void> {
        try {
            const recordedAt = Date.now();
            const { fundingRates, openInterests } = await this.client.fetchAllTickers(recordedAt);

            if (fundingRates.length > 0) {
                this.db.insertFundingRates(fundingRates);
                this.lastDataTime = Date.now();
            }

            // Open Interest Throttling:
            // Store all symbols every 5 minutes; store BTCUSDT & ETHUSDT every 1 minute
            const now = Date.now();
            const shouldStoreAllOI = (now - this.lastOiSampleTime >= 300000); // 5 minutes

            let oiToStore = openInterests;
            if (!shouldStoreAllOI) {
                oiToStore = openInterests.filter(oi => oi.symbol === 'BTCUSDT' || oi.symbol === 'ETHUSDT');
            } else {
                this.lastOiSampleTime = now;
            }

            if (oiToStore.length > 0) {
                this.db.insertOpenInterest(oiToStore);
                this.lastDataTime = Date.now();
            }

            this.lastTickerTime = Date.now();

            if (this.isRestDegraded) {
                this.isRestDegraded = false;
                if (this.wsClient.getAggregateStatus() === 'CONNECTED') {
                    this.onOutageResolved();
                }
            }
        } catch (err: any) {
            this.isRestDegraded = true;
            this.onOutageStarted(`Failed to poll tickers: ${err?.message || err}`);
            log.error({ err: err?.message || err }, 'Failed to poll tickers');
        }
    }

    /**
     * Relaxed kline poller (low REST load):
     * Klines are recoverable from REST history. Polls rotating batches of 4 symbols every 5 seconds (~0.8 req/s),
     * ensuring each active symbol gets closed bars refreshed smoothly every ~20 minutes with zero rate limit stress.
     */
    private startRelaxedKlinePoller(): void {
        const batchSize = 4;
        const batchIntervalMs = 5000;

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
                const lastClosedMinute = Math.floor(now / 60000) * 60000 - 60000;

                for (const sym of batch) {
                    if (!this.isRunning) break;
                    try {
                        const lastTs = this.lastKlineTimestamp.get(sym) || this.db.getLatestKlineTimestamp(sym) || (now - 3600000);
                        if (lastTs < lastClosedMinute) {
                            const klines = await this.client.fetch1mKlines(sym, 60, lastTs + 60000, lastClosedMinute);
                            const closedBars = klines.filter(k => k.timestamp <= lastClosedMinute);
                            if (closedBars.length > 0) {
                                this.db.insertKlines(closedBars);
                                const latest = closedBars[closedBars.length - 1].timestamp;
                                this.lastKlineTimestamp.set(sym, latest);
                                this.lastKlineTime = Date.now();
                                this.lastDataTime = Date.now();
                            }
                        }
                    } catch (err: any) {
                        log.warn({ symbol: sym, err: err?.message }, 'Failed to fetch klines for symbol');
                    }
                    await new Promise(r => setTimeout(r, 100));
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

        const wsStatus = this.wsClient.getAggregateStatus();
        const connectedShards = this.wsClient.getConnectedShardsCount();
        const totalShards = this.wsClient.getShardsCount();
        const dnsFailures24h = this.getDnsFailures24h();

        // Freshness per stream
        const klineLagSeconds = this.lastKlineTime > 0 ? Math.round((now - this.lastKlineTime) / 1000) : null;
        const liqLagSeconds = this.lastLiquidationEventTime > 0 ? Math.round((now - this.lastLiquidationEventTime) / 1000) : null;
        const obLagSeconds = this.lastOrderbookTime > 0 ? Math.round((now - this.lastOrderbookTime) / 1000) : null;
        const tickerLagSeconds = this.lastTickerTime > 0 ? Math.round((now - this.lastTickerTime) / 1000) : null;

        let status: 'HEALTHY' | 'DEGRADED' | 'STALE' = 'HEALTHY';
        const streamDetails = `streams=[kline:${klineLagSeconds ?? 'init'}s, liq:${liqLagSeconds ?? 'quiet'}s, ob:${obLagSeconds ?? 'init'}s, ticker:${tickerLagSeconds ?? 'init'}s]`;

        if (this.activeOutageStart || wsStatus !== 'CONNECTED' || this.isRestDegraded) {
            status = 'DEGRADED';
        } else if (silenceDurationMs > this.config.staleDataThresholdMs) {
            status = 'STALE';
            const silenceMinutes = Math.round(silenceDurationMs / 60000);
            log.error({ silenceMinutes }, '[ALERT] STALE DATA ALERT: No recorder data received');

            if (!this.staleAlertTriggered) {
                this.staleAlertTriggered = true;
                sendDiscordAlert({
                    title: '[RECORDER HEARTBEAT] Data Stale',
                    description: `No market data received from Bybit for **${silenceMinutes} minutes**. Reconnecting WS shards.`,
                    color: 15158332,
                    fields: [
                        { name: 'Silence Duration', value: `${silenceMinutes} mins`, inline: true },
                        { name: 'Status', value: 'STALE', inline: true }
                    ],
                    timestamp: new Date(now).toISOString()
                }).catch(() => {});
            }

            this.wsClient.stop();
            this.wsClient.start();
        } else if (wsStatus === 'CONNECTED' && silenceSeconds > 90) {
            // WS connected but zero messages of any kind for >90s
            status = 'DEGRADED';
            log.warn({ silenceSeconds }, 'WS connected but zero messages of any kind for >90s');
        }

        const details = `status=${status} shards=${connectedShards}/${totalShards} ${streamDetails} dns24h=${dnsFailures24h}`;

        this.db.insertHeartbeat({
            timestamp: now,
            activeSymbolsCount: this.activeContracts.size,
            status,
            lastDataTimestamp: this.lastDataTime,
            details
        });

        // Dead-man's switch: Ping healthcheck URL if healthy
        if (status === 'HEALTHY' && this.config.healthcheckUrl) {
            fetch(this.config.healthcheckUrl).catch(err => {
                log.warn({ err: err?.message }, 'Failed to ping dead-man switch healthcheck URL');
            });
        }
    }
}
