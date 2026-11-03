import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getRecorderDashboardStatus, openReadOnlyRecorderDb } from '../dashboard/lib/recorder_db';
import fs from 'fs';
import path from 'path';

function createMockReq(headers: Record<string, string>): any {
    return {
        headers: {
            get: (key: string) => headers[key.toLowerCase()] ?? headers[key] ?? null
        }
    };
}

describe('Recorder Status Page - Data Aggregation & Read-Only Safety', () => {
    let testDb: Database.Database;

    beforeEach(() => {
        // Create an in-memory database with the full recorder schema
        testDb = new Database(':memory:');
        testDb.exec(`
            CREATE TABLE contract_snapshots (
                symbol TEXT NOT NULL,
                status TEXT NOT NULL,
                base_coin TEXT NOT NULL,
                quote_coin TEXT NOT NULL,
                price_filter_tick_size REAL NOT NULL,
                lot_size_filter_min_qty REAL NOT NULL,
                launch_time INTEGER,
                delivery_time INTEGER,
                snapshot_timestamp INTEGER NOT NULL,
                PRIMARY KEY (symbol, snapshot_timestamp)
            );

            CREATE TABLE listing_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                event_type TEXT NOT NULL,
                detected_at INTEGER NOT NULL,
                launch_time INTEGER,
                details TEXT
            );

            CREATE TABLE klines_1m (
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

            CREATE TABLE funding_rates (
                symbol TEXT NOT NULL,
                funding_rate_timestamp INTEGER NOT NULL,
                funding_rate REAL NOT NULL,
                recorded_at INTEGER NOT NULL,
                PRIMARY KEY (symbol, funding_rate_timestamp)
            );

            CREATE TABLE open_interest (
                symbol TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                open_interest REAL NOT NULL,
                open_interest_value REAL NOT NULL,
                recorded_at INTEGER NOT NULL,
                PRIMARY KEY (symbol, timestamp)
            );

            CREATE TABLE liquidations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                price REAL NOT NULL,
                size REAL NOT NULL,
                timestamp INTEGER NOT NULL,
                recorded_at INTEGER NOT NULL,
                UNIQUE(symbol, timestamp, price, size, side)
            );

            CREATE TABLE orderbook_snapshots (
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

            CREATE TABLE data_gaps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                data_type TEXT NOT NULL,
                gap_start INTEGER NOT NULL,
                gap_end INTEGER NOT NULL,
                missing_count INTEGER NOT NULL,
                detected_at INTEGER NOT NULL,
                resolved_at INTEGER,
                cause TEXT
            );

            CREATE TABLE recorder_heartbeats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                active_symbols_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                last_data_timestamp INTEGER NOT NULL,
                details TEXT
            );
        `);
    });

    afterEach(() => {
        testDb.close();
    });

    it('handles empty database gracefully with sensible defaults', () => {
        const now = 1700000000000;
        const status = getRecorderDashboardStatus(testDb, now);

        expect(status.overallHealth).toBe('DOWN');
        expect(status.streams.length).toBe(8);
        expect(status.tableCounts.length).toBe(9);
        expect(status.klineCoverage.symbolsAuditedCount).toBe(0);
        expect(status.klineCoverage.worst20).toEqual([]);
        expect(status.liquidations.countLast24h).toBe(0);
        expect(status.liquidations.eventsPerHour).toBe(0);
        expect(status.gaps.totalGapsCount).toBe(0);
        expect(status.listings.totalListings).toBe(0);
    });

    it('accurately calculates stream health and latency thresholds', () => {
        const now = 1700000000000;
        // Ingest kline 30s ago (fresh)
        testDb.prepare(`
            INSERT INTO klines_1m VALUES ('BTCUSDT', ?, 60000, 60100, 59900, 60050, 10, 600000)
        `).run(now - 30000);

        // Ingest funding rate 400s ago (fresh, threshold 900s)
        testDb.prepare(`
            INSERT INTO funding_rates VALUES ('BTCUSDT', ?, 0.0001, ?)
        `).run(now - 400000, now - 400000);

        // Ingest open interest 600s ago (stale, threshold 180s)
        testDb.prepare(`
            INSERT INTO open_interest VALUES ('BTCUSDT', ?, 50000, 3000000000, ?)
        `).run(now - 600000, now - 600000);

        // Heartbeat 20s ago
        testDb.prepare(`
            INSERT INTO recorder_heartbeats (timestamp, active_symbols_count, status, last_data_timestamp, details)
            VALUES (?, 808, 'HEALTHY', ?, 'Recorder initialized: 808 linear contracts across 9 WS shards')
        `).run(now - 20000, now - 20000);

        const status = getRecorderDashboardStatus(testDb, now);

        const klineStream = status.streams.find(s => s.stream === '1m Klines');
        expect(klineStream?.status).toBe('GREEN');
        expect(klineStream?.secondsSinceLatest).toBe(30);

        const fundingStream = status.streams.find(s => s.stream === 'Funding Rates');
        expect(fundingStream?.status).toBe('GREEN');
        expect(fundingStream?.secondsSinceLatest).toBe(400);

        const oiStream = status.streams.find(s => s.stream === 'Open Interest');
        expect(oiStream?.status).toBe('RED');
        expect(oiStream?.secondsSinceLatest).toBe(600);

        expect(status.wsShards.totalShards).toBe(9);
        expect(status.wsShards.activeSymbols).toBe(808);
        expect(status.wsShards.status).toBe('HEALTHY');
    });

    it('calculates 1m kline coverage measured from each symbol first recorded bar and lists worst 20', () => {
        const now = 1700000000000;
        const sixtyMinsAgo = now - 60 * 60 * 1000;

        // Register 25 symbols in contract_snapshots
        for (let i = 1; i <= 25; i++) {
            const sym = `SYM${i}USDT`;
            testDb.prepare(`
                INSERT INTO contract_snapshots (symbol, status, base_coin, quote_coin, price_filter_tick_size, lot_size_filter_min_qty, launch_time, snapshot_timestamp)
                VALUES (?, 'Trading', 'SYM', 'USDT', 0.1, 1, ?, ?)
            `).run(sym, sixtyMinsAgo, sixtyMinsAgo);

            // SYM1 to SYM5: 100% coverage (60 bars each)
            // SYM6 to SYM20: partial coverage (e.g. i * 2 bars)
            // SYM21 to SYM25: very low coverage (i bars)
            const barCount = i <= 5 ? 60 : (i <= 20 ? i * 2 : i);
            for (let b = 0; b < barCount; b++) {
                testDb.prepare(`
                    INSERT INTO klines_1m (symbol, timestamp, open, high, low, close, volume, turnover)
                    VALUES (?, ?, 10, 11, 9, 10.5, 100, 1050)
                `).run(sym, sixtyMinsAgo + b * 60000);
            }
        }

        const status = getRecorderDashboardStatus(testDb, now);

        expect(status.klineCoverage.symbolsAuditedCount).toBe(25);
        expect(status.klineCoverage.worst20.length).toBe(20);

        // Verify worst20 are sorted ascending by coveragePct
        for (let j = 0; j < status.klineCoverage.worst20.length - 1; j++) {
            expect(status.klineCoverage.worst20[j].coveragePct).toBeLessThanOrEqual(
                status.klineCoverage.worst20[j + 1].coveragePct
            );
        }

        // Each symbol's expected bars is 60 minutes
        expect(status.klineCoverage.worst20[0].expectedBars).toBe(60);
    });

    it('accurately tallies liquidation events per hour and data gaps with durations', () => {
        const now = 1700000000000;
        const twoHoursAgo = now - 2 * 3600 * 1000;

        // Ingest 50 liquidations across 2 hours
        for (let i = 0; i < 50; i++) {
            testDb.prepare(`
                INSERT INTO liquidations (symbol, side, price, size, timestamp, recorded_at)
                VALUES (?, 'Buy', 50000, 1.5, ?, ?)
            `).run(`SYM${i}`, twoHoursAgo + i * 100000, twoHoursAgo + i * 100000);
        }

        // Ingest a 15-minute gap
        testDb.prepare(`
            INSERT INTO data_gaps (symbol, data_type, gap_start, gap_end, missing_count, detected_at, resolved_at)
            VALUES ('BTCUSDT', 'kline_1m', ?, ?, 15, ?, NULL)
        `).run(now - 30 * 60000, now - 15 * 60000, now - 15 * 60000);

        const status = getRecorderDashboardStatus(testDb, now);

        expect(status.liquidations.countLast24h).toBe(50);
        expect(status.liquidations.eventsPerHour).toBeGreaterThan(0);
        expect(status.gaps.unresolvedGapsCount).toBe(1);
        expect(status.gaps.recentGaps[0].durationMinutes).toBe(15);
    });

    it('identifies DNS failure logs and longest outage in 24h', () => {
        const now = 1700000000000;

        testDb.prepare(`
            INSERT INTO recorder_heartbeats (timestamp, active_symbols_count, status, last_data_timestamp, details)
            VALUES (?, 808, 'STALE', ?, 'getaddrinfo ENOTFOUND api.bybit.com DNS resolution failed')
        `).run(now - 3600000, now - 3600000);

        testDb.prepare(`
            INSERT INTO data_gaps (symbol, data_type, gap_start, gap_end, missing_count, detected_at, resolved_at)
            VALUES ('ALL', 'network_outage', ?, ?, 42, ?, ?)
        `).run(now - 7200000, now - (7200000 - 42 * 60000), now - 3600000, now - 3600000);

        const status = getRecorderDashboardStatus(testDb, now);

        expect(status.network.dnsFailureCount24h).toBe(1);
        expect(status.network.longestOutageMinutes24h).toBe(42);
    });

    it('verifies read-only mode safety: mutation is strictly rejected', () => {
        const testFile = path.join(__dirname, 'test_readonly_recorder.db');
        try {
            const setupDb = new Database(testFile);
            setupDb.exec(`CREATE TABLE dummy (val TEXT); INSERT INTO dummy VALUES ('data');`);
            setupDb.close();

            const roDb = openReadOnlyRecorderDb(testFile);
            expect(roDb.readonly).toBe(true);

            expect(() => {
                roDb.prepare("INSERT INTO dummy VALUES ('illegal_write')").run();
            }).toThrow();

            roDb.close();
        } finally {
            if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        }
    });
});

