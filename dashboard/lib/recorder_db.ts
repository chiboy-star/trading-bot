import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface StreamHealth {
    stream: string;
    tableName: string;
    status: 'GREEN' | 'RED';
    latestTimestamp: number | null;
    secondsSinceLatest: number | null;
    statusText: string;
}

export interface WorstKlineCoverage {
    symbol: string;
    firstBarIso: string;
    storedBars: number;
    expectedBars: number;
    coveragePct: number;
}

export interface DataGapItem {
    id: number;
    symbol: string;
    dataType: string;
    gapStart: number;
    gapEnd: number;
    durationMinutes: number;
    detectedAt: number;
    resolvedAt: number | null;
    isRecoverable: boolean;
    category: 'UNRECOVERABLE_STREAM' | 'RECOVERABLE_OPEN' | 'RECOVERED';
}

export interface TableRowCount {
    table: string;
    count: number;
}

export interface RecorderDashboardStatus {
    timestamp: number;
    dbPath: string;
    dbSizeBytes: number;
    dbSizeMb: number;
    growthRateMbPerDay: number;
    overallHealth: 'HEALTHY' | 'DEGRADED' | 'DOWN';
    streams: StreamHealth[];
    wsShards: {
        totalShards: number;
        activeSymbols: number;
        status: string;
        lastHeartbeatIso: string;
        details: string;
    };
    tableCounts: TableRowCount[];
    klineCoverage: {
        overallCoveragePct: number;
        coverage24hPct: number;
        coverageSinceFirstBarPct: number;
        coverage24hDescription: string;
        coverageSinceFirstBarDescription: string;
        symbolsAuditedCount: number;
        symbolsAbove98Count: number;
        worst20: WorstKlineCoverage[];
    };
    restMetrics: {
        totalRequestsLastHour: number;
        errors10006LastHour: number;
        errors429LastHour: number;
        peak5sRequests: number;
    };
    gaps: {
        totalGapsCount: number;
        unresolvedGapsCount: number;
        unrecoverableStreamOutages: number;
        unrecoverableGapsCount: number;
        openRecoverableGapsCount: number;
        resolvedGapsCount: number;
        longestOutageMinutes24h: number;
        largestOutageMinutes: number;
        recentGaps: DataGapItem[];
    };
    network: {
        dnsFailureCount24h: number;
        longestOutageMinutes24h: number;
    };
    listings: {
        totalListings: number;
        listingsLast7d: number;
        haEligibleCount: number;
    };
    liquidations: {
        countLast24h: number;
        eventsPerHour: number;
    };
}

export function getRecorderDbPath(): string {
    const candidates = [
        path.join(process.cwd(), 'data', 'recorder.db'),
        path.join(process.cwd(), '..', 'data', 'recorder.db'),
        path.resolve(__dirname, '../../../data/recorder.db'),
        path.resolve(__dirname, '../../data/recorder.db'),
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }

    return path.join(process.cwd(), 'data', 'recorder.db');
}

export function openReadOnlyRecorderDb(customPath?: string): Database.Database {
    const dbPath = customPath || getRecorderDbPath();
    const db = new Database(dbPath, { readonly: true, fileMustExist: false });
    try {
        db.pragma('busy_timeout = 5000');
    } catch {
        // Fallback if pragmas fail on read-only in memory
    }
    return db;
}

export function getRecorderDashboardStatus(
    db: Database.Database,
    now: number = Date.now(),
    dbFilePath?: string
): RecorderDashboardStatus {
    const window24hStart = now - 24 * 3600 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;

    // 1. Storage & File Size
    let dbSizeBytes = 0;
    const resolvedDbPath = dbFilePath || (db.name ? String(db.name) : getRecorderDbPath());
    if (resolvedDbPath && fs.existsSync(resolvedDbPath)) {
        try {
            const stat = fs.statSync(resolvedDbPath);
            dbSizeBytes = stat.size;
            // Also add WAL and SHM if present
            const walPath = `${resolvedDbPath}-wal`;
            const shmPath = `${resolvedDbPath}-shm`;
            if (fs.existsSync(walPath)) dbSizeBytes += fs.statSync(walPath).size;
            if (fs.existsSync(shmPath)) dbSizeBytes += fs.statSync(shmPath).size;
        } catch {
            // Ignore stat errors
        }
    }
    const dbSizeMb = parseFloat((dbSizeBytes / (1024 * 1024)).toFixed(2));

    // Earliest recorded data timestamp for growth projection
    let recorderStartTs = now;
    try {
        const hbMin = db.prepare('SELECT MIN(timestamp) as minTs FROM recorder_heartbeats').get() as { minTs: number | null };
        const csMin = db.prepare('SELECT MIN(snapshot_timestamp) as minTs FROM contract_snapshots').get() as { minTs: number | null };
        const klMin = db.prepare('SELECT MIN(timestamp) as minTs FROM klines_1m').get() as { minTs: number | null };
        const minCandidates = [hbMin?.minTs, csMin?.minTs, klMin?.minTs].filter((ts): ts is number => typeof ts === 'number' && ts > 0);
        if (minCandidates.length > 0) {
            recorderStartTs = Math.min(...minCandidates);
        }
    } catch {
        // Tables might not exist in blank test DB
    }

    const elapsedHours = Math.max(0.01, (now - recorderStartTs) / 3600000);
    const growthRateMbPerDay = parseFloat(((dbSizeMb / Math.max(0.1, elapsedHours)) * 24).toFixed(2));

    // 2. Stream Health & Latency
    const streamDefs = [
        { name: '1m Klines', table: 'klines_1m', tsCol: 'timestamp', maxLagSec: 180 },
        { name: 'Funding Rates', table: 'funding_rates', tsCol: 'recorded_at', maxLagSec: 900 },
        { name: 'Open Interest', table: 'open_interest', tsCol: 'recorded_at', maxLagSec: 180 },
        { name: 'Orderbook Depth', table: 'orderbook_snapshots', tsCol: 'recorded_at', maxLagSec: 180 },
        { name: 'Liquidations', table: 'liquidations', tsCol: 'recorded_at', maxLagSec: 3600 },
        { name: 'Contract Snapshots', table: 'contract_snapshots', tsCol: 'snapshot_timestamp', maxLagSec: 43200 },
        { name: 'Listing Events', table: 'listing_events', tsCol: 'detected_at', maxLagSec: null },
        { name: 'Recorder Heartbeats', table: 'recorder_heartbeats', tsCol: 'timestamp', maxLagSec: 180 },
    ];

    const streams: StreamHealth[] = [];
    for (const def of streamDefs) {
        let latestTs: number | null = null;
        try {
            if (def.table === 'funding_rates') {
                // Requirement 6: Funding staleness must use the last successful ticker poll, not row age
                const pollRow = db.prepare('SELECT MAX(recorded_at) as maxTs FROM open_interest').get() as { maxTs: number | null };
                const fundingRow = db.prepare('SELECT MAX(recorded_at) as maxTs FROM funding_rates').get() as { maxTs: number | null };
                const maxTs = Math.max(pollRow?.maxTs ?? 0, fundingRow?.maxTs ?? 0);
                latestTs = maxTs > 0 ? maxTs : null;
            } else {
                const row = db.prepare(`SELECT MAX(${def.tsCol}) as maxTs FROM ${def.table}`).get() as { maxTs: number | null };
                latestTs = row?.maxTs ?? null;
            }
        } catch {
            latestTs = null;
        }

        const secondsSinceLatest = latestTs ? Math.max(0, Math.floor((now - latestTs) / 1000)) : null;
        let status: 'GREEN' | 'RED' = 'GREEN';
        let statusText = 'Optimal';

        if (latestTs === null) {
            status = 'RED';
            statusText = 'No data ingested';
        } else if (def.maxLagSec !== null && secondsSinceLatest !== null && secondsSinceLatest > def.maxLagSec) {
            status = 'RED';
            statusText = `Stale (${secondsSinceLatest}s ago, threshold ${def.maxLagSec}s)`;
        } else if (secondsSinceLatest !== null) {
            statusText = `${secondsSinceLatest}s ago`;
        }

        // Special handling for event-driven streams (liquidations, listings)
        if (def.table === 'listing_events') {
            status = 'GREEN';
            statusText = latestTs ? `${Math.round((secondsSinceLatest || 0) / 3600)}h ago (Event-driven)` : 'No listings detected (Event-driven)';
        } else if (def.table === 'liquidations' && secondsSinceLatest !== null && secondsSinceLatest <= 3600) {
            status = 'GREEN';
            statusText = `${secondsSinceLatest}s ago`;
        }

        streams.push({
            stream: def.name,
            tableName: def.table,
            status,
            latestTimestamp: latestTs,
            secondsSinceLatest,
            statusText
        });
    }

    // 3. WebSocket Shard Status
    let wsShards = {
        totalShards: 9,
        activeSymbols: 0,
        status: 'UNKNOWN',
        lastHeartbeatIso: 'NONE',
        details: 'No heartbeat recorded'
    };

    try {
        const hbRow = db.prepare(`
            SELECT timestamp, active_symbols_count, status, details
            FROM recorder_heartbeats
            ORDER BY timestamp DESC
            LIMIT 1
        `).get() as { timestamp: number; active_symbols_count: number; status: string; details: string } | undefined;

        if (hbRow) {
            const shardMatch = hbRow.details ? hbRow.details.match(/(\d+)\s+WS\s+shards/i) : null;
            const parsedShards = shardMatch ? parseInt(shardMatch[1], 10) : 9;

            wsShards = {
                totalShards: parsedShards,
                activeSymbols: hbRow.active_symbols_count,
                status: hbRow.status,
                lastHeartbeatIso: new Date(hbRow.timestamp).toISOString(),
                details: hbRow.details || 'Healthy'
            };
        }
    } catch {
        // Table missing or empty
    }

    // 4. Table Row Counts
    const tableNames = [
        'contract_snapshots',
        'listing_events',
        'klines_1m',
        'funding_rates',
        'open_interest',
        'liquidations',
        'orderbook_snapshots',
        'data_gaps',
        'recorder_heartbeats'
    ];

    const tableCounts: TableRowCount[] = [];
    for (const t of tableNames) {
        let count = 0;
        try {
            const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${t}`).get() as { cnt: number };
            count = row?.cnt ?? 0;
        } catch {
            count = 0;
        }
        tableCounts.push({ table: t, count });
    }

    // 5. Per-Symbol 1m Kline Coverage (measured from each symbol's first recorded bar)
    let symbolsToAudit: Array<{ symbol: string; launchTime: number }> = [];
    try {
        const csRows = db.prepare(`
            SELECT DISTINCT symbol, MAX(launch_time) as launchTime FROM contract_snapshots GROUP BY symbol
        `).all() as { symbol: string; launchTime: number }[];
        if (csRows.length > 0) {
            symbolsToAudit = csRows;
        } else {
            symbolsToAudit = db.prepare(`SELECT DISTINCT symbol, 0 as launchTime FROM klines_1m`).all() as { symbol: string; launchTime: number }[];
        }
    } catch {
        symbolsToAudit = [];
    }

    const storedBarMap = new Map<string, { cnt: number; firstBarTs: number }>();
    try {
        const storedRows = db.prepare(`
            SELECT symbol, COUNT(*) as cnt, MIN(timestamp) as firstBarTs
            FROM klines_1m
            GROUP BY symbol
        `).all() as { symbol: string; cnt: number; firstBarTs: number }[];
        for (const r of storedRows) {
            storedBarMap.set(r.symbol, r);
        }
    } catch {
        // No klines
    }

    // 5. Per-Symbol 1m Kline Coverage
    // 5a. Trailing 24-hour window
    const barsIn24hMap = new Map<string, number>();
    try {
        const rows24h = db.prepare(`
            SELECT symbol, COUNT(*) as cnt
            FROM klines_1m
            WHERE timestamp >= ?
            GROUP BY symbol
        `).all(window24hStart) as { symbol: string; cnt: number }[];
        for (const r of rows24h) barsIn24hMap.set(r.symbol, r.cnt);
    } catch {}

    let totalExpected24h = 0;
    let totalStored24h = 0;
    for (const s of symbolsToAudit) {
        const effectiveStart24h = Math.max(window24hStart, s.launchTime || 0);
        const expected24h = Math.max(1, Math.floor((now - effectiveStart24h) / 60000));
        const stored24h = barsIn24hMap.get(s.symbol) || 0;
        totalExpected24h += expected24h;
        totalStored24h += Math.min(stored24h, expected24h);
    }
    const coverage24hPct = totalExpected24h > 0
        ? parseFloat(((totalStored24h / totalExpected24h) * 100).toFixed(2))
        : 100.0;
    const coverage24hDescription = "Trailing 24-hour window candle completeness across all active contracts.";

    // 5b. Lifetime since first bar
    let totalExpectedSinceFirstBar = 0;
    let totalStoredSinceFirstBar = 0;
    let symbolsAbove98Count = 0;
    const symbolCoverageList: WorstKlineCoverage[] = [];

    for (const s of symbolsToAudit) {
        const stats = storedBarMap.get(s.symbol);
        const storedForSymbol = stats ? stats.cnt : 0;
        const firstBarTs = stats ? stats.firstBarTs : null;

        let expectedSinceFirst = 1;
        let coverage = 100.0;
        if (firstBarTs && firstBarTs > 0) {
            expectedSinceFirst = Math.max(1, Math.floor((now - firstBarTs) / 60000));
            totalExpectedSinceFirstBar += expectedSinceFirst;
            totalStoredSinceFirstBar += Math.min(storedForSymbol, expectedSinceFirst);
            coverage = (storedForSymbol / expectedSinceFirst) * 100;
        } else {
            expectedSinceFirst = Math.max(1, Math.floor((now - Math.max(recorderStartTs, s.launchTime || 0)) / 60000));
            totalExpectedSinceFirstBar += expectedSinceFirst;
            coverage = 0.0;
        }

        const coveragePct = parseFloat(Math.min(100, coverage).toFixed(1));
        if (coveragePct >= 98.0) {
            symbolsAbove98Count++;
        }

        symbolCoverageList.push({
            symbol: s.symbol,
            firstBarIso: firstBarTs ? new Date(firstBarTs).toISOString() : 'NO_BARS_YET',
            storedBars: storedForSymbol,
            expectedBars: expectedSinceFirst,
            coveragePct
        });
    }

    symbolCoverageList.sort((a, b) => a.coveragePct - b.coveragePct);
    const worst20 = symbolCoverageList.slice(0, 20);
    const coverageSinceFirstBarPct = totalExpectedSinceFirstBar > 0
        ? parseFloat(((totalStoredSinceFirstBar / totalExpectedSinceFirstBar) * 100).toFixed(2))
        : 100.0;
    const coverageSinceFirstBarDescription = "Lifetime timeseries continuity from each contract's initial stored bar to current time.";
    const overallCoveragePct = coverage24hPct;

    // 6. REST Rate Limiting & Error Metrics (Last 1 Hour)
    let restMetrics = {
        totalRequestsLastHour: 0,
        errors10006LastHour: 0,
        errors429LastHour: 0,
        peak5sRequests: 0,
    };
    try {
        const oneHourAgo = now - 60 * 60 * 1000;
        const metricRow = db.prepare(`
            SELECT 
                SUM(request_count) as totalReqs,
                SUM(errors_10006) as err10006,
                SUM(errors_429) as err429,
                MAX(request_count) as peak5s
            FROM rest_request_metrics
            WHERE window_5s >= ?
        `).get(oneHourAgo) as { totalReqs: number | null; err10006: number | null; err429: number | null; peak5s: number | null };

        if (metricRow && metricRow.totalReqs !== null) {
            restMetrics = {
                totalRequestsLastHour: metricRow.totalReqs || 0,
                errors10006LastHour: metricRow.err10006 || 0,
                errors429LastHour: metricRow.err429 || 0,
                peak5sRequests: metricRow.peak5s || 0,
            };
        }
    } catch {
        // Table may not exist yet in tests
    }

    // 7. Gaps & Outages (Separating unrecoverable streams from open/recoverable gaps)
    let recentGaps: DataGapItem[] = [];
    let totalGapsCount = 0;
    let unresolvedGapsCount = 0;
    let unrecoverableGapsCount = 0;
    let unrecoverableStreamOutages = 0;
    let openRecoverableGapsCount = 0;
    let resolvedGapsCount = 0;
    let largestOutageMinutes = 0;

    const isUnrecoverableType = (dataType: string) => {
        const dt = (dataType || '').toLowerCase();
        return dt === 'streams_lost' || dt.includes('stream') || dt.includes('liquidation') || dt.includes('orderbook') || dt.includes('depth');
    };

    try {
        const gapRows = db.prepare(`
            SELECT id, symbol, data_type as dataType, gap_start as gapStart, gap_end as gapEnd,
                   missing_count as missingCount, detected_at as detectedAt, resolved_at as resolvedAt
            FROM data_gaps
            ORDER BY detected_at DESC
            LIMIT 25
        `).all() as any[];

        recentGaps = gapRows.map(g => {
            const isUnrec = isUnrecoverableType(g.dataType);
            const isResolved = g.resolvedAt !== null;
            let category: 'UNRECOVERABLE_STREAM' | 'RECOVERABLE_OPEN' | 'RECOVERED';
            if (isUnrec) {
                category = 'UNRECOVERABLE_STREAM';
            } else if (isResolved) {
                category = 'RECOVERED';
            } else {
                category = 'RECOVERABLE_OPEN';
            }

            return {
                id: g.id,
                symbol: g.symbol,
                dataType: g.dataType,
                gapStart: g.gapStart,
                gapEnd: g.gapEnd,
                durationMinutes: Math.max(g.missingCount, Math.round((g.gapEnd - g.gapStart) / 60000)),
                detectedAt: g.detectedAt,
                resolvedAt: g.resolvedAt,
                isRecoverable: !isUnrec,
                category,
            };
        });

        const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM data_gaps`).get() as { cnt: number };
        totalGapsCount = totalRow?.cnt || 0;

        const unresRow = db.prepare(`SELECT COUNT(*) as cnt FROM data_gaps WHERE resolved_at IS NULL`).get() as { cnt: number };
        unresolvedGapsCount = unresRow?.cnt || 0;

        // Unrecoverable stream gap events (liquidations, orderbook, streams_lost)
        const unrecRow = db.prepare(`
            SELECT COUNT(*) as cnt FROM data_gaps
            WHERE data_type = 'streams_lost' OR data_type LIKE '%stream%' OR data_type LIKE '%liq%' OR data_type LIKE '%orderbook%' OR data_type LIKE '%depth%'
        `).get() as { cnt: number };
        unrecoverableGapsCount = unrecRow?.cnt || 0;
        unrecoverableStreamOutages = unrecoverableGapsCount;

        // Open recoverable gaps (e.g. kline_1m awaiting REST fill)
        const openRecRow = db.prepare(`
            SELECT COUNT(*) as cnt FROM data_gaps
            WHERE resolved_at IS NULL AND data_type NOT IN ('streams_lost') AND data_type NOT LIKE '%stream%' AND data_type NOT LIKE '%liq%' AND data_type NOT LIKE '%orderbook%'
        `).get() as { cnt: number };
        openRecoverableGapsCount = openRecRow?.cnt || 0;

        // Resolved recoverable gaps
        const resRecRow = db.prepare(`
            SELECT COUNT(*) as cnt FROM data_gaps
            WHERE resolved_at IS NOT NULL AND data_type NOT IN ('streams_lost') AND data_type NOT LIKE '%stream%' AND data_type NOT LIKE '%liq%' AND data_type NOT LIKE '%orderbook%'
        `).get() as { cnt: number };
        resolvedGapsCount = resRecRow?.cnt || 0;

        const maxGapAllTimeRow = db.prepare(`
            SELECT MAX(gap_end - gap_start) as maxGapMs
            FROM data_gaps
        `).get() as { maxGapMs: number | null };
        largestOutageMinutes = maxGapAllTimeRow?.maxGapMs ? Math.round(maxGapAllTimeRow.maxGapMs / 60000) : 0;
    } catch {
        // Table missing
    }

    // 7. DNS Failures & Longest Outage in 24h
    let dnsFailureCount24h = 0;
    let longestOutageMinutes24h = 0;

    try {
        const dnsHbRow = db.prepare(`
            SELECT COUNT(*) as cnt FROM recorder_heartbeats
            WHERE timestamp >= ? AND (
                details LIKE '%DNS%' OR details LIKE '%ENOTFOUND%' OR details LIKE '%EAI_AGAIN%'
            )
        `).get(window24hStart) as { cnt: number } | undefined;
        if (dnsHbRow && dnsHbRow.cnt > 0) {
            dnsFailureCount24h = Math.max(dnsFailureCount24h, dnsHbRow.cnt);
        }
    } catch {
        // Table missing or details column missing
    }

    try {
        const dnsGapRow = db.prepare(`
            SELECT COUNT(*) as cnt FROM data_gaps
            WHERE detected_at >= ? AND (
                cause LIKE '%DNS%' OR cause LIKE '%ENOTFOUND%' OR cause LIKE '%EAI_AGAIN%'
            )
        `).get(window24hStart) as { cnt: number } | undefined;
        if (dnsGapRow && dnsGapRow.cnt > 0) {
            dnsFailureCount24h = Math.max(dnsFailureCount24h, dnsGapRow.cnt);
        }
    } catch {
        // cause column may not exist in legacy schema
    }

    try {
        const maxGapRow = db.prepare(`
            SELECT MAX(gap_end - gap_start) as maxGapMs
            FROM data_gaps
            WHERE detected_at >= ?
        `).get(window24hStart) as { maxGapMs: number | null } | undefined;
        if (maxGapRow && typeof maxGapRow.maxGapMs === 'number') {
            longestOutageMinutes24h = Math.round(maxGapRow.maxGapMs / 60000);
        }
    } catch {
        // Table missing
    }

    // 8. Listings Detected & H-A Eligible Counts
    let totalListings = 0;
    let listingsLast7d = 0;
    let haEligibleCount = 0;

    try {
        // Use valid_listing_events view to filter out restarts and cold-start duplicates
        const totRow = db.prepare(`SELECT COUNT(*) as cnt FROM valid_listing_events WHERE event_type = 'LISTING'`).get() as { cnt: number } | undefined;
        totalListings = totRow?.cnt || 0;

        const recRow = db.prepare(`SELECT COUNT(*) as cnt FROM valid_listing_events WHERE event_type = 'LISTING' AND detected_at >= ?`).get(sevenDaysAgo) as { cnt: number } | undefined;
        listingsLast7d = recRow?.cnt || 0;

        // Strict H-A Eligibility check:
        // Must be in valid_listing_events, native crypto, with depth from launch+1h to launch+6h
        const candidates = db.prepare(`
            SELECT symbol, detected_at as detectedAt, launch_time as launchTime
            FROM valid_listing_events
            WHERE event_type = 'LISTING'
        `).all() as Array<{ symbol: string; detectedAt: number; launchTime: number | null }>;

        const nonCryptoKnown = new Set([
            'ABBVUSDT', 'AGPUUSDT', 'TTMIUSDT', 'BAUSDT', 'CRMLUSDT',
            'AXPUSDT', 'IBKRUSDT', 'LMTUSDT', 'PGUSDT', 'MXLUSDT',
            'XAUUSDT', 'XAGUSDT', 'SPYUSDT', 'QQQUSDT', 'NVDAUSDT',
            'TSLAUSDT', 'AAPLUSDT', 'MDTSTOCKUSDT', 'CSTOCKUSDT',
            '4STOCKUSDT'
        ]);

        for (const c of candidates) {
            if (c.symbol.endsWith('STOCKUSDT') || nonCryptoKnown.has(c.symbol)) continue;
            if (!c.launchTime || c.detectedAt - c.launchTime > 3600000) continue;

            const wStart = c.launchTime + 3600000;
            const wEnd = c.launchTime + 21600000;
            const obRow = db.prepare(`
                SELECT COUNT(*) as cnt, MIN(timestamp) as minTs, MAX(timestamp) as maxTs
                FROM orderbook_snapshots
                WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
            `).get(c.symbol, wStart, wEnd) as { cnt: number; minTs: number | null; maxTs: number | null };

            if (obRow && obRow.cnt >= 30 && obRow.minTs && obRow.maxTs && (obRow.maxTs - obRow.minTs >= 4 * 3600 * 1000)) {
                haEligibleCount++;
            }
        }
    } catch {
        // Tables missing or view not yet loaded in test DB
    }

    // 9. Liquidations & Rate per Hour
    let countLast24h = 0;
    let eventsPerHour = 0;

    try {
        const liqRow = db.prepare(`SELECT COUNT(*) as cnt FROM liquidations WHERE timestamp >= ?`).get(window24hStart) as { cnt: number };
        countLast24h = liqRow?.cnt || 0;

        const elapsedRecordedHours = Math.max(0.01, (now - recorderStartTs) / 3600000);
        const evalHours = Math.min(elapsedRecordedHours, 24);
        eventsPerHour = parseFloat((countLast24h / evalHours).toFixed(2));
    } catch {
        // Table missing
    }

    // Determine Overall Health
    const redStreams = streams.filter(s => s.status === 'RED' && s.tableName !== 'contract_snapshots' && s.tableName !== 'listing_events');
    let overallHealth: 'HEALTHY' | 'DEGRADED' | 'DOWN' = 'HEALTHY';
    if (redStreams.length >= 3) {
        overallHealth = 'DOWN';
    } else if (redStreams.length > 0 || wsShards.status === 'STALE') {
        overallHealth = 'DEGRADED';
    }

    return {
        timestamp: now,
        dbPath: resolvedDbPath,
        dbSizeBytes,
        dbSizeMb,
        growthRateMbPerDay,
        overallHealth,
        streams,
        wsShards,
        tableCounts,
        klineCoverage: {
            overallCoveragePct,
            coverage24hPct,
            coverageSinceFirstBarPct,
            coverage24hDescription,
            coverageSinceFirstBarDescription,
            symbolsAuditedCount: symbolsToAudit.length,
            symbolsAbove98Count,
            worst20
        },
        restMetrics,
        gaps: {
            totalGapsCount,
            unresolvedGapsCount,
            unrecoverableStreamOutages,
            unrecoverableGapsCount,
            openRecoverableGapsCount,
            resolvedGapsCount,
            longestOutageMinutes24h,
            largestOutageMinutes,
            recentGaps
        },
        network: {
            dnsFailureCount24h,
            longestOutageMinutes24h
        },
        listings: {
            totalListings,
            listingsLast7d,
            haEligibleCount
        },
        liquidations: {
            countLast24h,
            eventsPerHour
        }
    };
}
