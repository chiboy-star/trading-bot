import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {
    ContractSnapshot,
    ListingEvent,
    Kline1m,
    FundingRateRecord,
    OpenInterestRecord,
    LiquidationRecord,
    OrderbookSnapshot,
    DataGap,
    RecorderHeartbeat,
    DataEpoch
} from './types';

export class RecorderDB {
    private db: Database.Database;
    public readonly dbPath: string;

    constructor(customPath?: string) {
        if (customPath) {
            this.dbPath = customPath;
        } else {
            const dataDir = path.resolve(process.cwd(), 'data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            this.dbPath = path.resolve(dataDir, 'recorder.db');
        }

        this.db = new Database(this.dbPath);
        this.configurePragmas();
        this.initSchema();
    }

    private configurePragmas(): void {
        try {
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('busy_timeout = 5000');
            this.db.pragma('temp_store = MEMORY');
        } catch {
            // Memory DB or testing mode may ignore some pragmas
        }
    }

    private initSchema(): void {
        this.db.exec(`
            -- 1. Hourly contract snapshot (Append-only)
            CREATE TABLE IF NOT EXISTS contract_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_timestamp INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                base_coin TEXT NOT NULL,
                quote_coin TEXT NOT NULL,
                status TEXT NOT NULL,
                contract_type TEXT NOT NULL,
                launch_time INTEGER NOT NULL,
                delivery_time INTEGER NOT NULL,
                tick_size REAL NOT NULL,
                min_order_qty REAL NOT NULL,
                max_order_qty REAL NOT NULL,
                qty_step REAL NOT NULL,
                funding_interval INTEGER NOT NULL,
                raw_json TEXT,
                UNIQUE(snapshot_timestamp, symbol)
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_sym_ts ON contract_snapshots(symbol, snapshot_timestamp);
            CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON contract_snapshots(snapshot_timestamp);

            -- 2. Detected listing & delisting events
            CREATE TABLE IF NOT EXISTS listing_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                detected_at INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                event_type TEXT NOT NULL, -- 'LISTING' | 'DELISTING' | 'STATUS_CHANGE'
                prev_status TEXT,
                new_status TEXT,
                launch_time INTEGER,
                details TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_listing_events_sym ON listing_events(symbol, detected_at);

            -- 2b. Verified valid listing events view (filters out cold-start and restart duplicates)
            -- Rule: launch_time strictly after the first-ever snapshot (2026-10-24 16:18:48 UTC = 1792858728331)
            -- and detected within 60 minutes of launch.
            CREATE VIEW IF NOT EXISTS valid_listing_events AS
            SELECT 
                id,
                detected_at,
                symbol,
                event_type,
                prev_status,
                new_status,
                launch_time,
                details
            FROM listing_events
            WHERE event_type = 'LISTING'
              AND launch_time > COALESCE((SELECT MIN(snapshot_timestamp) FROM contract_snapshots), 1792858728331)
              AND (detected_at - launch_time) <= 3600000
              AND (detected_at - launch_time) >= -300000;

            -- 3. 1-Minute Klines
            CREATE TABLE IF NOT EXISTS klines_1m (
                symbol TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                turnover REAL NOT NULL,
                PRIMARY KEY (symbol, timestamp)
            );
            CREATE INDEX IF NOT EXISTS idx_klines_sym_ts ON klines_1m(symbol, timestamp);

            -- 4. Funding Rates
            CREATE TABLE IF NOT EXISTS funding_rates (
                symbol TEXT NOT NULL,
                funding_rate_timestamp INTEGER NOT NULL,
                funding_rate REAL NOT NULL,
                recorded_at INTEGER NOT NULL,
                PRIMARY KEY (symbol, funding_rate_timestamp)
            );
            CREATE INDEX IF NOT EXISTS idx_funding_sym_ts ON funding_rates(symbol, funding_rate_timestamp);

            -- 5. Open Interest
            CREATE TABLE IF NOT EXISTS open_interest (
                symbol TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                open_interest REAL NOT NULL,
                open_interest_value REAL NOT NULL,
                recorded_at INTEGER NOT NULL,
                PRIMARY KEY (symbol, timestamp)
            );
            CREATE INDEX IF NOT EXISTS idx_oi_sym_ts ON open_interest(symbol, timestamp);

            -- 6. Public Liquidations
            CREATE TABLE IF NOT EXISTS liquidations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL, -- 'Buy' | 'Sell'
                price REAL NOT NULL,
                size REAL NOT NULL,
                timestamp INTEGER NOT NULL,
                recorded_at INTEGER NOT NULL,
                UNIQUE(symbol, timestamp, price, size, side)
            );
            CREATE INDEX IF NOT EXISTS idx_liq_sym_ts ON liquidations(symbol, timestamp);

            -- 7. Order-book Depth Snapshots (top 10-25 levels)
            CREATE TABLE IF NOT EXISTS orderbook_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                depth INTEGER NOT NULL,
                bids_json TEXT NOT NULL,
                asks_json TEXT NOT NULL,
                best_bid REAL NOT NULL,
                best_ask REAL NOT NULL,
                spread REAL NOT NULL,
                mid_price REAL NOT NULL,
                recorded_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ob_sym_ts ON orderbook_snapshots(symbol, timestamp);

            -- 8. Data Gaps Tracking
            CREATE TABLE IF NOT EXISTS data_gaps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                data_type TEXT NOT NULL, -- 'kline_1m' | 'funding' | 'open_interest' | 'orderbook'
                gap_start INTEGER NOT NULL,
                gap_end INTEGER NOT NULL,
                missing_count INTEGER NOT NULL,
                detected_at INTEGER NOT NULL,
                resolved_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_gaps_sym_type ON data_gaps(symbol, data_type);

            -- 9. Recorder Heartbeats
            CREATE TABLE IF NOT EXISTS recorder_heartbeats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                active_symbols_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                last_data_timestamp INTEGER NOT NULL,
                details TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_heartbeats_ts ON recorder_heartbeats(timestamp);

            -- 10. REST Request Metrics (5-second window counters per endpoint)
            CREATE TABLE IF NOT EXISTS rest_request_metrics (
                window_5s INTEGER NOT NULL,
                endpoint TEXT NOT NULL,
                request_count INTEGER NOT NULL DEFAULT 0,
                errors_10006 INTEGER NOT NULL DEFAULT 0,
                errors_429 INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (window_5s, endpoint)
            );
            CREATE INDEX IF NOT EXISTS idx_rest_metrics_window ON rest_request_metrics(window_5s);

            -- 11. Data Epochs (Append-only metadata marking clean dataset milestones)
            CREATE TABLE IF NOT EXISTS data_epochs (
                epoch_id TEXT PRIMARY KEY,
                started_at INTEGER NOT NULL,
                description TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_epochs_started_at ON data_epochs(started_at);

            -- 12. 1-Minute Final Klines (Additive table for strictly closed, verified bars)
            CREATE TABLE IF NOT EXISTS klines_1m_final (
                symbol TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                turnover REAL NOT NULL,
                PRIMARY KEY (symbol, timestamp)
            );
            CREATE INDEX IF NOT EXISTS idx_klines_final_sym_ts ON klines_1m_final(symbol, timestamp);

            -- Append-Only Immutability Triggers (Enforce strictly no UPDATE or DELETE on recorded datasets)
            CREATE TRIGGER IF NOT EXISTS abort_update_contract_snapshots BEFORE UPDATE ON contract_snapshots
            BEGIN SELECT RAISE(ABORT, 'Mutation forbidden: table contract_snapshots is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS abort_delete_contract_snapshots BEFORE DELETE ON contract_snapshots
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table contract_snapshots is append-only'); END;

            CREATE TRIGGER IF NOT EXISTS abort_update_listing_events BEFORE UPDATE ON listing_events
            BEGIN SELECT RAISE(ABORT, 'Mutation forbidden: table listing_events is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS abort_delete_listing_events BEFORE DELETE ON listing_events
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table listing_events is append-only'); END;

            CREATE TRIGGER IF NOT EXISTS abort_update_klines_1m BEFORE UPDATE ON klines_1m
            BEGIN SELECT RAISE(ABORT, 'Mutation forbidden: table klines_1m is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS abort_delete_klines_1m BEFORE DELETE ON klines_1m
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table klines_1m is append-only'); END;

            CREATE TRIGGER IF NOT EXISTS abort_update_funding_rates BEFORE UPDATE ON funding_rates
            BEGIN SELECT RAISE(ABORT, 'Mutation forbidden: table funding_rates is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS abort_delete_funding_rates BEFORE DELETE ON funding_rates
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table funding_rates is append-only'); END;

            CREATE TRIGGER IF NOT EXISTS abort_update_open_interest BEFORE UPDATE ON open_interest
            BEGIN SELECT RAISE(ABORT, 'Mutation forbidden: table open_interest is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS abort_delete_open_interest BEFORE DELETE ON open_interest
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table open_interest is append-only'); END;

            CREATE TRIGGER IF NOT EXISTS abort_update_liquidations BEFORE UPDATE ON liquidations
            BEGIN SELECT RAISE(ABORT, 'Mutation forbidden: table liquidations is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS abort_delete_liquidations BEFORE DELETE ON liquidations
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table liquidations is append-only'); END;

            CREATE TRIGGER IF NOT EXISTS abort_update_orderbook_snapshots BEFORE UPDATE ON orderbook_snapshots
            BEGIN SELECT RAISE(ABORT, 'Mutation forbidden: table orderbook_snapshots is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS abort_delete_orderbook_snapshots BEFORE DELETE ON orderbook_snapshots
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table orderbook_snapshots is append-only'); END;

            CREATE TRIGGER IF NOT EXISTS abort_update_recorder_heartbeats BEFORE UPDATE ON recorder_heartbeats
            BEGIN SELECT RAISE(ABORT, 'Mutation forbidden: table recorder_heartbeats is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS abort_delete_recorder_heartbeats BEFORE DELETE ON recorder_heartbeats
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table recorder_heartbeats is append-only'); END;

            CREATE TRIGGER IF NOT EXISTS abort_delete_data_gaps BEFORE DELETE ON data_gaps
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table data_gaps is append-only'); END;

            CREATE TRIGGER IF NOT EXISTS abort_update_data_epochs BEFORE UPDATE ON data_epochs
            BEGIN SELECT RAISE(ABORT, 'Mutation forbidden: table data_epochs is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS abort_delete_data_epochs BEFORE DELETE ON data_epochs
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table data_epochs is append-only'); END;

            CREATE TRIGGER IF NOT EXISTS abort_update_klines_1m_final BEFORE UPDATE ON klines_1m_final
            BEGIN SELECT RAISE(ABORT, 'Mutation forbidden: table klines_1m_final is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS abort_delete_klines_1m_final BEFORE DELETE ON klines_1m_final
            BEGIN SELECT RAISE(ABORT, 'Deletion forbidden: table klines_1m_final is append-only'); END;
        `);

        // Schema migrations for backfill tracking & outage causes
        try { this.db.exec("ALTER TABLE funding_rates ADD COLUMN is_backfilled INTEGER DEFAULT 0"); } catch {}
        try { this.db.exec("ALTER TABLE open_interest ADD COLUMN is_backfilled INTEGER DEFAULT 0"); } catch {}
        try { this.db.exec("ALTER TABLE data_gaps ADD COLUMN cause TEXT"); } catch {}

        // Initialize default clean-data epoch milestone
        try {
            this.db.prepare(`
                INSERT OR IGNORE INTO data_epochs (epoch_id, started_at, description)
                VALUES ('clean_data_phase2', ?, 'Phase 2: Corrected orderbook snapshot/delta local book, filtered forming klines, throttled open interest')
            `).run(Date.now());
        } catch {}
    }

    public getRawDb(): Database.Database {
        return this.db;
    }

    public close(): void {
        try {
            this.db.close();
        } catch {
            // Ignore if already closed
        }
    }

    // --- SNAPSHOTS & LISTINGS ---

    public insertSnapshots(snapshots: ContractSnapshot[]): void {
        if (snapshots.length === 0) return;
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO contract_snapshots (
                snapshot_timestamp, symbol, base_coin, quote_coin, status,
                contract_type, launch_time, delivery_time, tick_size,
                min_order_qty, max_order_qty, qty_step, funding_interval, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((items: ContractSnapshot[]) => {
            for (const s of items) {
                stmt.run(
                    s.snapshotTimestamp,
                    s.symbol,
                    s.baseCoin,
                    s.quoteCoin,
                    s.status,
                    s.contractType,
                    s.launchTime,
                    s.deliveryTime,
                    s.tickSize,
                    s.minOrderQty,
                    s.maxOrderQty,
                    s.qtyStep,
                    s.fundingInterval,
                    s.rawJson || null
                );
            }
        });

        insertMany(snapshots);
    }

    public getLatestSnapshotTimestamp(): number | null {
        const row = this.db.prepare(`
            SELECT MAX(snapshot_timestamp) as latest FROM contract_snapshots
        `).get() as { latest: number | null } | undefined;
        return row?.latest ?? null;
    }

    public getSnapshotsByTimestamp(timestamp: number): ContractSnapshot[] {
        const rows = this.db.prepare(`
            SELECT 
                snapshot_timestamp as snapshotTimestamp,
                symbol,
                base_coin as baseCoin,
                quote_coin as quoteCoin,
                status,
                contract_type as contractType,
                launch_time as launchTime,
                delivery_time as deliveryTime,
                tick_size as tickSize,
                min_order_qty as minOrderQty,
                max_order_qty as maxOrderQty,
                qty_step as qtyStep,
                funding_interval as fundingInterval,
                raw_json as rawJson
            FROM contract_snapshots
            WHERE snapshot_timestamp = ?
        `).all(timestamp) as ContractSnapshot[];
        return rows;
    }

    public insertListingEvents(events: ListingEvent[]): void {
        if (events.length === 0) return;
        const stmt = this.db.prepare(`
            INSERT INTO listing_events (
                detected_at, symbol, event_type, prev_status, new_status, launch_time, details
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((items: ListingEvent[]) => {
            for (const e of items) {
                stmt.run(
                    e.detectedAt,
                    e.symbol,
                    e.eventType,
                    e.prevStatus,
                    e.newStatus,
                    e.launchTime,
                    e.details
                );
            }
        });

        insertMany(events);
    }

    public getListingEvents(limit: number = 100): ListingEvent[] {
        const rows = this.db.prepare(`
            SELECT 
                id,
                detected_at as detectedAt,
                symbol,
                event_type as eventType,
                prev_status as prevStatus,
                new_status as newStatus,
                launch_time as launchTime,
                details
            FROM listing_events
            ORDER BY detected_at DESC
            LIMIT ?
        `).all(limit) as ListingEvent[];
        return rows;
    }

    public getValidListingEvents(limit: number = 100): ListingEvent[] {
        const rows = this.db.prepare(`
            SELECT 
                id,
                detected_at as detectedAt,
                symbol,
                event_type as eventType,
                prev_status as prevStatus,
                new_status as newStatus,
                launch_time as launchTime,
                details
            FROM valid_listing_events
            ORDER BY detected_at DESC
            LIMIT ?
        `).all(limit) as ListingEvent[];
        return rows;
    }

    // --- KLINES ---

    public insertKlines(klines: Kline1m[]): number {
        if (klines.length === 0) return 0;
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO klines_1m (
                symbol, timestamp, open, high, low, close, volume, turnover
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let insertedCount = 0;
        const insertMany = this.db.transaction((items: Kline1m[]) => {
            for (const k of items) {
                const info = stmt.run(
                    k.symbol,
                    k.timestamp,
                    k.open,
                    k.high,
                    k.low,
                    k.close,
                    k.volume,
                    k.turnover
                );
                if (info.changes > 0) insertedCount++;
            }
        });

        insertMany(klines);
        return insertedCount;
    }

    public getLatestKlineTimestamp(symbol: string): number | null {
        const row = this.db.prepare(`
            SELECT MAX(timestamp) as latest FROM klines_1m WHERE symbol = ?
        `).get(symbol) as { latest: number | null } | undefined;
        return row?.latest ?? null;
    }

    public getKlines(symbol: string, fromTimestamp: number, toTimestamp: number): Kline1m[] {
        return this.db.prepare(`
            SELECT symbol, timestamp, open, high, low, close, volume, turnover
            FROM klines_1m
            WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `).all(symbol, fromTimestamp, toTimestamp) as Kline1m[];
    }

    // --- KLINES 1M FINAL (ADDITIVE & VERIFIED) ---

    public insertKlinesFinal(klines: Kline1m[]): number {
        if (klines.length === 0) return 0;
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO klines_1m_final (
                symbol, timestamp, open, high, low, close, volume, turnover
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let insertedCount = 0;
        const insertMany = this.db.transaction((items: Kline1m[]) => {
            for (const k of items) {
                const info = stmt.run(
                    k.symbol,
                    k.timestamp,
                    k.open,
                    k.high,
                    k.low,
                    k.close,
                    k.volume,
                    k.turnover
                );
                if (info.changes > 0) insertedCount++;
            }
        });

        insertMany(klines);
        return insertedCount;
    }

    public getLatestKlineFinalTimestamp(symbol: string): number | null {
        const row = this.db.prepare(`
            SELECT MAX(timestamp) as latest FROM klines_1m_final WHERE symbol = ?
        `).get(symbol) as { latest: number | null } | undefined;
        return row?.latest ?? null;
    }

    public getKlinesFinal(symbol: string, fromTimestamp: number, toTimestamp: number): Kline1m[] {
        return this.db.prepare(`
            SELECT symbol, timestamp, open, high, low, close, volume, turnover
            FROM klines_1m_final
            WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `).all(symbol, fromTimestamp, toTimestamp) as Kline1m[];
    }

    // --- DATA EPOCHS ---

    public insertEpoch(epoch: DataEpoch): void {
        this.db.prepare(`
            INSERT OR IGNORE INTO data_epochs (epoch_id, started_at, description)
            VALUES (?, ?, ?)
        `).run(epoch.epochId, epoch.startedAt, epoch.description);
    }

    public getEpochs(): DataEpoch[] {
        return this.db.prepare(`
            SELECT epoch_id as epochId, started_at as startedAt, description
            FROM data_epochs
            ORDER BY started_at ASC
        `).all() as DataEpoch[];
    }

    public getLatestEpoch(): DataEpoch | null {
        const row = this.db.prepare(`
            SELECT epoch_id as epochId, started_at as startedAt, description
            FROM data_epochs
            ORDER BY started_at DESC
            LIMIT 1
        `).get() as DataEpoch | undefined;
        return row ?? null;
    }

    // --- FUNDING RATES ---

    public insertFundingRates(records: FundingRateRecord[], isBackfilled: boolean = false): void {
        if (records.length === 0) return;
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO funding_rates (
                symbol, funding_rate_timestamp, funding_rate, recorded_at, is_backfilled
            ) VALUES (?, ?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((items: FundingRateRecord[]) => {
            for (const r of items) {
                stmt.run(
                    r.symbol,
                    r.fundingRateTimestamp,
                    r.fundingRate,
                    r.recordedAt,
                    r.isBackfilled ? 1 : (isBackfilled ? 1 : 0)
                );
            }
        });

        insertMany(records);
    }

    public getLatestFundingRateTimestamp(symbol: string): number | null {
        const row = this.db.prepare(`
            SELECT MAX(funding_rate_timestamp) as latest FROM funding_rates WHERE symbol = ?
        `).get(symbol) as { latest: number | null } | undefined;
        return row?.latest ?? null;
    }

    // --- OPEN INTEREST ---

    public insertOpenInterest(records: OpenInterestRecord[], isBackfilled: boolean = false): void {
        if (records.length === 0) return;
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO open_interest (
                symbol, timestamp, open_interest, open_interest_value, recorded_at, is_backfilled
            ) VALUES (?, ?, ?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((items: OpenInterestRecord[]) => {
            for (const r of items) {
                stmt.run(
                    r.symbol,
                    r.timestamp,
                    r.openInterest,
                    r.openInterestValue,
                    r.recordedAt,
                    r.isBackfilled ? 1 : (isBackfilled ? 1 : 0)
                );
            }
        });

        insertMany(records);
    }

    public getLatestOpenInterestTimestamp(symbol: string): number | null {
        const row = this.db.prepare(`
            SELECT MAX(timestamp) as latest FROM open_interest WHERE symbol = ?
        `).get(symbol) as { latest: number | null } | undefined;
        return row?.latest ?? null;
    }

    // --- LIQUIDATIONS ---

    public insertLiquidations(records: LiquidationRecord[]): void {
        if (records.length === 0) return;
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO liquidations (
                symbol, side, price, size, timestamp, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((items: LiquidationRecord[]) => {
            for (const r of items) {
                stmt.run(r.symbol, r.side, r.price, r.size, r.timestamp, r.recordedAt);
            }
        });

        insertMany(records);
    }

    // --- ORDERBOOK SNAPSHOTS ---

    public insertOrderbookSnapshots(snapshots: OrderbookSnapshot[]): void {
        if (snapshots.length === 0) return;
        const stmt = this.db.prepare(`
            INSERT INTO orderbook_snapshots (
                symbol, timestamp, depth, bids_json, asks_json,
                best_bid, best_ask, spread, mid_price, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((items: OrderbookSnapshot[]) => {
            for (const s of items) {
                stmt.run(
                    s.symbol,
                    s.timestamp,
                    s.depth,
                    JSON.stringify(s.bids),
                    JSON.stringify(s.asks),
                    s.bestBid,
                    s.bestAsk,
                    s.spread,
                    s.midPrice,
                    s.recordedAt
                );
            }
        });

        insertMany(snapshots);
    }

    // --- GAPS & HEARTBEATS ---

    public recordGap(gap: DataGap): number {
        const stmt = this.db.prepare(`
            INSERT INTO data_gaps (
                symbol, data_type, gap_start, gap_end, missing_count, detected_at, resolved_at, cause
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
            gap.symbol,
            gap.dataType,
            gap.gapStart,
            gap.gapEnd,
            gap.missingCount,
            gap.detectedAt,
            gap.resolvedAt ?? null,
            gap.cause ?? null
        );
        return Number(info.lastInsertRowid);
    }

    public resolveGap(gapId: number, resolvedAt: number = Date.now()): void {
        this.db.prepare(`
            UPDATE data_gaps SET resolved_at = ? WHERE id = ?
        `).run(resolvedAt, gapId);
    }

    public getDnsFailuresCount(sinceTimestamp: number): number {
        const gapRow = this.db.prepare(`
            SELECT COUNT(*) as cnt FROM data_gaps
            WHERE detected_at >= ? AND (cause LIKE '%DNS%' OR cause LIKE '%ENOTFOUND%' OR cause LIKE '%EAI_AGAIN%')
        `).get(sinceTimestamp) as { cnt: number } | undefined;

        const hbRow = this.db.prepare(`
            SELECT COUNT(*) as cnt FROM recorder_heartbeats
            WHERE timestamp >= ? AND (details LIKE '%DNS%' OR details LIKE '%ENOTFOUND%' OR details LIKE '%EAI_AGAIN%')
        `).get(sinceTimestamp) as { cnt: number } | undefined;

        return Math.max(gapRow?.cnt || 0, hbRow?.cnt || 0);
    }

    public getLongestOutageMinutes(sinceTimestamp: number): number {
        const row = this.db.prepare(`
            SELECT MAX(gap_end - gap_start) as maxGapMs FROM data_gaps
            WHERE detected_at >= ? AND data_type IN ('streams_lost', 'network_outage', 'ws_disconnect', 'rest_outage')
        `).get(sinceTimestamp) as { maxGapMs: number | null } | undefined;
        return row?.maxGapMs ? Math.round(row.maxGapMs / 60000) : 0;
    }

    public getUnresolvedGaps(symbol?: string): DataGap[] {
        const query = symbol
            ? `SELECT id, symbol, data_type as dataType, gap_start as gapStart, gap_end as gapEnd,
                      missing_count as missingCount, detected_at as detectedAt, resolved_at as resolvedAt
               FROM data_gaps WHERE resolved_at IS NULL AND symbol = ? ORDER BY gap_start ASC`
            : `SELECT id, symbol, data_type as dataType, gap_start as gapStart, gap_end as gapEnd,
                      missing_count as missingCount, detected_at as detectedAt, resolved_at as resolvedAt
               FROM data_gaps WHERE resolved_at IS NULL ORDER BY gap_start ASC`;

        return (symbol ? this.db.prepare(query).all(symbol) : this.db.prepare(query).all()) as DataGap[];
    }

    public insertHeartbeat(heartbeat: RecorderHeartbeat): void {
        this.db.prepare(`
            INSERT INTO recorder_heartbeats (
                timestamp, active_symbols_count, status, last_data_timestamp, details
            ) VALUES (?, ?, ?, ?, ?)
        `).run(
            heartbeat.timestamp,
            heartbeat.activeSymbolsCount,
            heartbeat.status,
            heartbeat.lastDataTimestamp,
            heartbeat.details
        );
    }

    public getLatestHeartbeat(): RecorderHeartbeat | null {
        const row = this.db.prepare(`
            SELECT timestamp, active_symbols_count as activeSymbolsCount, status,
                   last_data_timestamp as lastDataTimestamp, details
            FROM recorder_heartbeats
            ORDER BY timestamp DESC
            LIMIT 1
        `).get() as RecorderHeartbeat | undefined;
        return row ?? null;
    }

    // --- DATA QUALITY & STATS HELPERS ---

    public getTableCounts(): Record<string, number> {
        const tables = [
            'contract_snapshots',
            'listing_events',
            'klines_1m',
            'klines_1m_final',
            'funding_rates',
            'open_interest',
            'liquidations',
            'orderbook_snapshots',
            'data_gaps',
            'recorder_heartbeats',
            'data_epochs'
        ];

        const counts: Record<string, number> = {};
        for (const t of tables) {
            const row = this.db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get() as { count: number };
            counts[t] = row.count;
        }
        return counts;
    }

    public getDbFileSize(): number {
        try {
            if (this.dbPath === ':memory:') return 0;
            if (fs.existsSync(this.dbPath)) {
                return fs.statSync(this.dbPath).size;
            }
        } catch {
            // Ignore
        }
        return 0;
    }

    public recordRestMetric(
        timestamp: number,
        endpoint: string,
        isSuccess: boolean,
        errorCode?: number
    ): void {
        try {
            const window5s = Math.floor(timestamp / 5000) * 5000;
            const err10006 = errorCode === 10006 ? 1 : 0;
            const err429 = errorCode === 429 ? 1 : 0;
            const success = isSuccess ? 1 : 0;

            const stmt = this.db.prepare(`
                INSERT INTO rest_request_metrics (window_5s, endpoint, request_count, errors_10006, errors_429, success_count)
                VALUES (?, ?, 1, ?, ?, ?)
                ON CONFLICT(window_5s, endpoint) DO UPDATE SET
                    request_count = request_count + 1,
                    errors_10006 = errors_10006 + excluded.errors_10006,
                    errors_429 = errors_429 + excluded.errors_429,
                    success_count = success_count + excluded.success_count
            `);
            stmt.run(window5s, endpoint, err10006, err429, success);
        } catch {
            // Non-critical telemetry logging failure should never crash recording
        }
    }

    public getRestMetricsPastHour(now: number = Date.now()): {
        totalRequests: number;
        errors10006: number;
        errors429: number;
        peak5sRequests: number;
        avg5sRequests: number;
        windowDistribution: Array<{ window5s: number; iso: string; total: number; errors10006: number; errors429: number; byEndpoint: Record<string, number> }>;
    } {
        const oneHourAgo = now - 3600000;
        try {
            const rows = this.db.prepare(`
                SELECT window_5s as window5s, endpoint, request_count as reqCount, errors_10006 as err10006, errors_429 as err429
                FROM rest_request_metrics
                WHERE window_5s >= ?
                ORDER BY window_5s ASC
            `).all(oneHourAgo) as Array<{ window5s: number; endpoint: string; reqCount: number; err10006: number; err429: number }>;

            let totalRequests = 0;
            let errors10006 = 0;
            let errors429 = 0;
            let peak5sRequests = 0;

            const windowMap = new Map<number, { window5s: number; iso: string; total: number; errors10006: number; errors429: number; byEndpoint: Record<string, number> }>();

            for (const r of rows) {
                totalRequests += r.reqCount;
                errors10006 += r.err10006;
                errors429 += r.err429;

                let w = windowMap.get(r.window5s);
                if (!w) {
                    w = {
                        window5s: r.window5s,
                        iso: new Date(r.window5s).toISOString(),
                        total: 0,
                        errors10006: 0,
                        errors429: 0,
                        byEndpoint: {}
                    };
                    windowMap.set(r.window5s, w);
                }
                w.total += r.reqCount;
                w.errors10006 += r.err10006;
                w.errors429 += r.err429;
                w.byEndpoint[r.endpoint] = (w.byEndpoint[r.endpoint] || 0) + r.reqCount;
                if (w.total > peak5sRequests) peak5sRequests = w.total;
            }

            const windows = Array.from(windowMap.values());
            const avg5sRequests = windows.length > 0 ? parseFloat((totalRequests / windows.length).toFixed(2)) : 0;

            return {
                totalRequests,
                errors10006,
                errors429,
                peak5sRequests,
                avg5sRequests,
                windowDistribution: windows
            };
        } catch {
            return {
                totalRequests: 0,
                errors10006: 0,
                errors429: 0,
                peak5sRequests: 0,
                avg5sRequests: 0,
                windowDistribution: []
            };
        }
    }
}
