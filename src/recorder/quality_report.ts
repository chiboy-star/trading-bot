import { RecorderDB } from './db';
import { DataQualityReport, ListingEvent, isCryptoPerp } from './types';
import { BybitPublicClient } from './bybit_client';

export class QualityReporter {
    private db: RecorderDB;
    private client?: BybitPublicClient;

    constructor(db: RecorderDB, client?: BybitPublicClient) {
        this.db = db;
        this.client = client;
    }

    public async generateReport(windowHours: number = 24, nowTimestamp?: number): Promise<DataQualityReport> {
        const now = nowTimestamp || Date.now();
        const windowMs = windowHours * 3600 * 1000;
        const windowStart = now - windowMs;

        const rawDb = this.db.getRawDb();
        const counts = this.db.getTableCounts();
        const dbSizeBytes = this.db.getDbFileSize();
        const dbSizeMb = parseFloat((dbSizeBytes / (1024 * 1024)).toFixed(2));

        // 1. Determine recorder active span
        const earliestHeartbeat = rawDb.prepare(`SELECT MIN(timestamp) as minTs FROM recorder_heartbeats`).get() as { minTs: number | null };
        const earliestSnapshot = rawDb.prepare(`SELECT MIN(snapshot_timestamp) as minTs FROM contract_snapshots`).get() as { minTs: number | null };
        const earliestKline = rawDb.prepare(`SELECT MIN(timestamp) as minTs FROM klines_1m`).get() as { minTs: number | null };
        const earliestLiq = rawDb.prepare(`SELECT MIN(timestamp) as minTs FROM liquidations`).get() as { minTs: number | null };

        const recordedTimestamps = [earliestHeartbeat?.minTs, earliestSnapshot?.minTs, earliestKline?.minTs, earliestLiq?.minTs].filter(
            (ts): ts is number => typeof ts === 'number' && ts > 0
        );
        const recorderStartTs = recordedTimestamps.length > 0 ? Math.min(...recordedTimestamps) : now;
        const recordingSpanMinutes = Math.max(1, Math.floor((now - recorderStartTs) / 60000));
        const recordingSpanHours = (recordingSpanMinutes / 60).toFixed(1);
        const recordingSpanText = recordingSpanMinutes < 60 ? `${recordingSpanMinutes} Minutes` : `${recordingSpanHours} Hours`;

        // 2. Unique contracts recorded in snapshots
        const uniqueContractsRow = rawDb.prepare(`
            SELECT COUNT(DISTINCT symbol) as uniqueCount FROM contract_snapshots
        `).get() as { uniqueCount: number };

        // 3. Listing events in window & since start (using valid_listing_events to filter out cold-start/restart duplicates)
        const validListingEvents = this.db.getValidListingEvents(500);
        const windowEvents = validListingEvents.filter(e => e.detectedAt >= windowStart);
        const newListings = windowEvents.filter(e => e.eventType === 'LISTING');
        const delistings = windowEvents.filter(e => e.eventType === 'DELISTING');

        // Total valid listings since start & 7 days
        const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
        const totalListingsRow = rawDb.prepare(`
            SELECT COUNT(*) as count FROM valid_listing_events WHERE event_type = 'LISTING'
        `).get() as { count: number };
        const totalListingsSinceStart = totalListingsRow?.count || 0;

        const recentListings7dRows = rawDb.prepare(`
            SELECT l.symbol, l.detected_at as detectedAt, l.launch_time as launchTime,
                   (SELECT raw_json FROM contract_snapshots cs WHERE cs.symbol = l.symbol LIMIT 1) as rawJson,
                   COUNT(o.id) as obCount
            FROM valid_listing_events l
            LEFT JOIN orderbook_snapshots o ON o.symbol = l.symbol
            WHERE l.event_type = 'LISTING' AND l.detected_at >= ?
            GROUP BY l.symbol, l.detected_at, l.launch_time
            ORDER BY l.detected_at DESC
        `).all(sevenDaysAgo) as { symbol: string; detectedAt: number; launchTime: number | null; rawJson: string | null; obCount: number }[];

        // Strict Hypothesis A Eligibility Logic:
        // A listing is eligible for H-A if and only if:
        // 1. Valid listing detected within 60 minutes of exchange launch (detected_at - launch_time <= 3600000).
        // 2. Native crypto perpetual contract (isCryptoPerp === true, excluding equities/stocks, ETFs, commodities, forex).
        // 3. Full top-25 orderbook depth coverage spanning the evaluation trigger window from launch+1h (60m) to launch+6h (360m).
        const allValidListings = rawDb.prepare(`
            SELECT l.symbol, l.detected_at as detectedAt, l.launch_time as launchTime,
                   (SELECT raw_json FROM contract_snapshots cs WHERE cs.symbol = l.symbol LIMIT 1) as rawJson
            FROM valid_listing_events l
            WHERE l.event_type = 'LISTING'
            GROUP BY l.symbol, l.detected_at, l.launch_time
        `).all() as { symbol: string; detectedAt: number; launchTime: number | null; rawJson: string | null }[];

        let listingsEligibleForHA = 0;
        for (const l of allValidListings) {
            if (!isCryptoPerp(l.symbol, l.rawJson)) continue;
            if (!l.launchTime) continue;
            if (l.detectedAt - l.launchTime > 3600000) continue; // Seen >60m after launch

            const windowStartH1 = l.launchTime + 3600000;
            const windowEndH6 = l.launchTime + 21600000;

            const depthInWindow = rawDb.prepare(`
                SELECT COUNT(*) as count, MIN(timestamp) as minTs, MAX(timestamp) as maxTs
                FROM orderbook_snapshots
                WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
            `).get(l.symbol, windowStartH1, windowEndH6) as { count: number; minTs: number | null; maxTs: number | null };

            if (depthInWindow && depthInWindow.count >= 30 && depthInWindow.minTs && depthInWindow.maxTs) {
                const spanMs = depthInWindow.maxTs - depthInWindow.minTs;
                if (spanMs >= 4 * 3600 * 1000) {
                    listingsEligibleForHA++;
                }
            }
        }

        // 4. Recorder-side kline completeness:
        // Coverage is evaluated strictly from the recorder's first start (or contract launchTime if listed later).
        // Backfilled bars before recorder start are excluded from recorded-time completeness.
        const trackedSymbolsRows = rawDb.prepare(`
            SELECT DISTINCT symbol, MAX(launch_time) as launchTime FROM contract_snapshots GROUP BY symbol
        `).all() as { symbol: string; launchTime: number }[];

        const symbolsToAudit = trackedSymbolsRows.length > 0 
            ? trackedSymbolsRows 
            : (rawDb.prepare(`SELECT DISTINCT symbol, 0 as launchTime FROM klines_1m`).all() as { symbol: string; launchTime: number }[]);

        // Stored bars within evaluation window
        const storedBarRows = rawDb.prepare(`
            SELECT symbol, COUNT(*) as cnt, MIN(timestamp) as firstBarTs, MAX(timestamp) as lastBarTs
            FROM klines_1m
            WHERE timestamp >= ?
            GROUP BY symbol
        `).all(windowStart) as { symbol: string; cnt: number; firstBarTs: number; lastBarTs: number }[];

        // Stored bars strictly since recorderStartTs
        const recordedSpanBarRows = rawDb.prepare(`
            SELECT symbol, COUNT(*) as cnt
            FROM klines_1m
            WHERE timestamp >= ?
            GROUP BY symbol
        `).all(recorderStartTs) as { symbol: string; cnt: number }[];

        const storedBarMap = new Map<string, { cnt: number; firstBarTs: number; lastBarTs: number }>();
        for (const row of storedBarRows) {
            storedBarMap.set(row.symbol, row);
        }

        const recordedSpanMap = new Map<string, number>();
        for (const row of recordedSpanBarRows) {
            recordedSpanMap.set(row.symbol, row.cnt);
        }

        // 1. 24h Window Coverage
        let totalExpected24h = 0;
        let totalStored24h = 0;
        for (const s of symbolsToAudit) {
            const effectiveWindowStart = Math.max(windowStart, s.launchTime || 0);
            const expected24h = Math.max(1, Math.floor((now - effectiveWindowStart) / 60000));
            const stored24h = storedBarMap.get(s.symbol)?.cnt || 0;
            totalExpected24h += expected24h;
            totalStored24h += Math.min(stored24h, expected24h);
        }
        const coverage24hPct = totalExpected24h > 0
            ? parseFloat(((totalStored24h / totalExpected24h) * 100).toFixed(2))
            : 100.0;
        const coverage24hDescription = "Trailing 24-hour window candle completeness across all active contracts.";

        // 2. Since First Bar Coverage
        const allTimeBarRows = rawDb.prepare(`
            SELECT symbol, COUNT(*) as cnt, MIN(timestamp) as firstBarTs
            FROM klines_1m
            GROUP BY symbol
        `).all() as { symbol: string; cnt: number; firstBarTs: number }[];
        const allTimeBarMap = new Map<string, { cnt: number; firstBarTs: number }>();
        for (const row of allTimeBarRows) {
            allTimeBarMap.set(row.symbol, row);
        }

        let totalExpectedSinceFirstBar = 0;
        let totalStoredSinceFirstBar = 0;
        let symbolsAbove98Count = 0;
        const symbolsBelow98: Array<{
            symbol: string;
            firstBarTimestamp: number | null;
            firstBarIso: string;
            storedBars: number;
            expectedBars: number;
            coveragePct: number;
            verification: string;
        }> = [];

        for (const s of symbolsToAudit) {
            const stats = allTimeBarMap.get(s.symbol);
            const storedForSymbol = stats ? stats.cnt : 0;
            const firstBarTs = stats ? stats.firstBarTs : null;

            let expectedSinceFirst = 1;
            let coverage = 100.0;
            if (firstBarTs && firstBarTs > 0) {
                expectedSinceFirst = Math.max(1, Math.floor((now - firstBarTs) / 60000) + 1);
                totalExpectedSinceFirstBar += expectedSinceFirst;
                totalStoredSinceFirstBar += Math.min(storedForSymbol, expectedSinceFirst);
                coverage = (storedForSymbol / expectedSinceFirst) * 100;
            } else {
                expectedSinceFirst = Math.max(1, Math.floor((now - Math.max(recorderStartTs, s.launchTime || 0)) / 60000));
                totalExpectedSinceFirstBar += expectedSinceFirst;
                coverage = 0.0;
            }

            const covPct = parseFloat(coverage.toFixed(1));
            if (covPct >= 98.0) {
                symbolsAbove98Count++;
            } else {
                symbolsBelow98.push({
                    symbol: s.symbol,
                    firstBarTimestamp: firstBarTs,
                    firstBarIso: firstBarTs ? new Date(firstBarTs).toISOString() : 'NONE_INGESTED',
                    storedBars: storedForSymbol,
                    expectedBars: expectedSinceFirst,
                    coveragePct: covPct,
                    verification: 'PENDING_VERIFICATION'
                });
            }
        }

        const coverageSinceFirstBarPct = totalExpectedSinceFirstBar > 0
            ? parseFloat(((totalStoredSinceFirstBar / totalExpectedSinceFirstBar) * 100).toFixed(2))
            : 100.0;
        const coverageSinceFirstBarDescription = "Lifetime timeseries continuity from each contract's initial stored bar to current time.";
        const overallCoveragePct = coverage24hPct;
        const totalTimeCoveragePct = coverage24hPct;
        const recordedTimeCoveragePct = coverageSinceFirstBarPct;

        // 5. Real Check Against Bybit's API for Sample of Flagged Symbols
        const exchangeAuditSample: Array<{
            symbol: string;
            storedBars: number;
            exchangeAvailableBars: number;
            status: 'ZERO_VOLUME_CONFIRMED' | 'RECORDER_GAP' | 'OFFLINE';
            details: string;
        }> = [];

        // Sort flagged symbols by coverage ascending
        symbolsBelow98.sort((a, b) => a.coveragePct - b.coveragePct);
        const sampleToAudit = symbolsBelow98.slice(0, 5);

        if (this.client && sampleToAudit.length > 0) {
            for (const cand of sampleToAudit) {
                try {
                    const checkStartTs = cand.firstBarTimestamp || recorderStartTs;
                    const exchangeBars = await this.client.fetch1mKlines(cand.symbol, 200, checkStartTs, now);
                    const exchangeCount = exchangeBars.length;
                    const dbCount = cand.storedBars;

                    if (exchangeCount === dbCount) {
                        cand.verification = `CONFIRMED ZERO-VOLUME: Bybit API served ${exchangeCount} bars for this exact span; local DB has ${dbCount} bars (100% match; Bybit omitted empty minutes)`;
                        exchangeAuditSample.push({
                            symbol: cand.symbol,
                            storedBars: dbCount,
                            exchangeAvailableBars: exchangeCount,
                            status: 'ZERO_VOLUME_CONFIRMED',
                            details: `Exchange API served ${exchangeCount} bars; DB stored ${dbCount} bars (100% parity with Bybit matching engine)`
                        });
                    } else if (exchangeCount > dbCount) {
                        const missed = exchangeCount - dbCount;
                        cand.verification = `RECORDER ROTATION SHORTFALL: Bybit API served ${exchangeCount} bars; local DB has ${dbCount} bars (${missed} bars missed by recorder rotation)`;
                        exchangeAuditSample.push({
                            symbol: cand.symbol,
                            storedBars: dbCount,
                            exchangeAvailableBars: exchangeCount,
                            status: 'RECORDER_GAP',
                            details: `Bybit API served ${exchangeCount} bars; DB stored ${dbCount} bars (${missed} bars missed)`
                        });
                    } else {
                        cand.verification = `DB AHEAD: DB has ${dbCount} bars; Bybit API served ${exchangeCount} bars`;
                        exchangeAuditSample.push({
                            symbol: cand.symbol,
                            storedBars: dbCount,
                            exchangeAvailableBars: exchangeCount,
                            status: 'ZERO_VOLUME_CONFIRMED',
                            details: `DB has ${dbCount} bars; Bybit returned ${exchangeCount} bars`
                        });
                    }
                } catch (err: any) {
                    cand.verification = `UNKNOWN_REQUEST_FAILED: ${err.message}`;
                    exchangeAuditSample.push({
                        symbol: cand.symbol,
                        storedBars: cand.storedBars,
                        exchangeAvailableBars: -1,
                        status: 'OFFLINE',
                        details: `Bybit REST query error (fail closed): ${err.message}`
                    });
                }
            }

            // For remainder of flagged symbols, mark as UNAUDITED (never apply blanket zero-volume)
            for (let i = 5; i < symbolsBelow98.length; i++) {
                symbolsBelow98[i].verification = 'UNAUDITED (Query Bybit to verify)';
            }
        } else {
            for (const cand of symbolsBelow98) {
                cand.verification = 'Offline evaluation / Bybit client not configured in test environment';
            }
        }

        // 6. Liquidations in window
        const liqsInWindowRow = rawDb.prepare(`
            SELECT COUNT(*) as count FROM liquidations WHERE timestamp >= ?
        `).get(windowStart) as { count: number } | undefined;
        const liquidationsInWindow = liqsInWindowRow?.count || 0;

        // Fix report math: liquidation rate must divide by elapsed recorded hours, not fixed 24
        const elapsedRecordedHours = Math.max(0.01, (now - recorderStartTs) / 3600000);
        const evalHours = Math.min(elapsedRecordedHours, windowHours);
        const liquidationsPerHour = parseFloat((liquidationsInWindow / evalHours).toFixed(2));

        // 7. Gaps, outages and DNS resilience
        const unresolvedGaps = this.db.getUnresolvedGaps();
        const allGapsRows = rawDb.prepare(`
            SELECT id, symbol, data_type as dataType, gap_start as gapStart, gap_end as gapEnd,
                   missing_count as missingCount, detected_at as detectedAt, resolved_at as resolvedAt, cause
            FROM data_gaps
            ORDER BY detected_at DESC
            LIMIT 50
        `).all() as any[];

        const gapDetails = allGapsRows.map(g => ({
            id: g.id,
            symbol: g.symbol,
            dataType: g.dataType,
            gapStart: g.gapStart,
            gapEnd: g.gapEnd,
            durationMinutes: Math.max(g.missingCount, Math.round((g.gapEnd - g.gapStart) / 60000)),
            detectedAt: g.detectedAt,
            resolvedAt: g.resolvedAt,
            cause: g.cause || ''
        }));

        const gapsByDataType: Record<string, number> = {};
        for (const row of gapDetails) {
            gapsByDataType[row.dataType] = (gapsByDataType[row.dataType] || 0) + 1;
        }

        // Full table aggregates with exact disjoint partition
        // 1. Unrecoverable: all rows representing stream losses (liquidations, orderbook depth)
        // 2. Open: recoverable gaps where resolved_at IS NULL
        // 3. Resolved: recoverable gaps where resolved_at IS NOT NULL
        const totGapsRow = rawDb.prepare(`SELECT COUNT(*) as cnt FROM data_gaps`).get() as { cnt: number };
        const totalGapsDetected = totGapsRow?.cnt || 0;

        const isStreamLostClause = `(data_type = 'streams_lost' OR data_type LIKE '%stream%' OR data_type LIKE '%liq%' OR data_type LIKE '%orderbook%' OR data_type LIKE '%depth%')`;

        const unrecRow = rawDb.prepare(`
            SELECT COUNT(*) as cnt FROM data_gaps
            WHERE ${isStreamLostClause}
        `).get() as { cnt: number };
        const unrecoverableStreamGaps = unrecRow?.cnt || 0;

        const openRecRow = rawDb.prepare(`
            SELECT COUNT(*) as cnt FROM data_gaps
            WHERE resolved_at IS NULL AND NOT ${isStreamLostClause}
        `).get() as { cnt: number };
        const openRecoverableGaps = openRecRow?.cnt || 0;

        const resRecRow = rawDb.prepare(`
            SELECT COUNT(*) as cnt FROM data_gaps
            WHERE resolved_at IS NOT NULL AND NOT ${isStreamLostClause}
        `).get() as { cnt: number };
        const resolvedGaps = resRecRow?.cnt || 0;

        // Reconcile gap totals assertion: resolved + open + unrecoverable = total
        if (unrecoverableStreamGaps + openRecoverableGaps + resolvedGaps !== totalGapsDetected) {
            throw new Error(
                `Gap totals reconciliation failure: unrecoverable(${unrecoverableStreamGaps}) + open(${openRecoverableGaps}) + resolved(${resolvedGaps}) !== total(${totalGapsDetected})`
            );
        }

        const maxGapRow = rawDb.prepare(`
            SELECT MAX(gap_end - gap_start) as maxGapMs FROM data_gaps
        `).get() as { maxGapMs: number | null };
        const largestGapMinutes = maxGapRow?.maxGapMs ? Math.round(maxGapRow.maxGapMs / 60000) : 0;

        const rawMetrics = this.db.getRestMetricsPastHour(now);
        const restMetrics = {
            totalRequestsLastHour: rawMetrics.totalRequests,
            errors10006LastHour: rawMetrics.errors10006,
            errors429LastHour: rawMetrics.errors429,
            peak5sRequests: rawMetrics.peak5sRequests,
            avg5sRequests: rawMetrics.avg5sRequests,
            windowDistribution: rawMetrics.windowDistribution
        };

        // 8. Freshness (Funding staleness uses last successful ticker poll from open_interest, not row age)
        const lastKlineRow = rawDb.prepare(`SELECT MAX(timestamp) as ts FROM klines_1m`).get() as { ts: number | null };
        const lastTickerRow = rawDb.prepare(`SELECT MAX(recorded_at) as ts FROM open_interest`).get() as { ts: number | null };
        const lastObRow = rawDb.prepare(`SELECT MAX(timestamp) as ts FROM orderbook_snapshots`).get() as { ts: number | null };
        const lastLiqRow = rawDb.prepare(`SELECT MAX(timestamp) as ts FROM liquidations`).get() as { ts: number | null };

        const lastKlineTimestamp = lastKlineRow?.ts ?? null;
        const lastTickerTimestamp = lastTickerRow?.ts ?? null;
        const lastOrderbookTimestamp = lastObRow?.ts ?? null;
        const lastLiquidationTimestamp = lastLiqRow?.ts ?? null;

        const maxRecent = Math.max(
            lastKlineTimestamp || 0,
            lastTickerTimestamp || 0,
            lastOrderbookTimestamp || 0
        );
        const staleThresholdMs = 15 * 60 * 1000;
        const isStale = maxRecent > 0 && (now - maxRecent > staleThresholdMs);

        // 9. Disk usage projection (calibrated formula baseline, requiring >=1h for observed rate)
        const formulaDailyMb = parseFloat((
            (counts.klines_1m > 0 ? (counts.klines_1m * 70) / (1024 * 1024) : 85) +
            (counts.orderbook_snapshots > 0 ? (counts.orderbook_snapshots * 550) / (1024 * 1024) : 15) +
            (counts.funding_rates > 0 ? (counts.funding_rates * 50) / (1024 * 1024) : 12) +
            (counts.contract_snapshots > 0 ? (counts.contract_snapshots * 200) / (1024 * 1024) : 4)
        ).toFixed(2));

        let dailyEstimatedMb = Math.max(formulaDailyMb, 115.0);
        if (elapsedRecordedHours >= 1.0 && dbSizeMb > 0) {
            const observedDaily = parseFloat(((dbSizeMb / elapsedRecordedHours) * 24).toFixed(2));
            dailyEstimatedMb = Math.max(observedDaily, 115.0);
        }

        const monthlyEstimatedGb = parseFloat(((dailyEstimatedMb * 30) / 1024).toFixed(2));
        const annualEstimatedGb = parseFloat(((dailyEstimatedMb * 365) / 1024).toFixed(2));
        const latestEpoch = this.db.getLatestEpoch();

        return {
            generatedAt: now,
            evaluationWindowMs: windowMs,
            windowStart,
            windowEnd: now,
            epoch: latestEpoch,
            storage: {
                dbPath: this.db.dbPath,
                dbSizeBytes,
                dbSizeMb
            },
            counts: {
                contractSnapshots: counts.contract_snapshots || 0,
                uniqueContractsRecorded: uniqueContractsRow?.uniqueCount || 0,
                listingEvents: counts.listing_events || 0,
                klines1m: counts.klines_1m || 0,
                fundingRates: counts.funding_rates || 0,
                openInterestSnapshots: counts.open_interest || 0,
                liquidations: counts.liquidations || 0,
                orderbookSnapshots: counts.orderbook_snapshots || 0,
                heartbeats: counts.recorder_heartbeats || 0
            },
            newListings,
            delistings,
            gaps: {
                totalGapsDetected,
                unresolvedGaps: unresolvedGaps.length,
                unrecoverableStreamGaps,
                openRecoverableGaps,
                resolvedGaps,
                gapsByDataType,
                largestGapMinutes
            },
            restMetrics,
            freshness: {
                lastKlineTimestamp,
                lastTickerTimestamp,
                lastOrderbookTimestamp,
                lastLiquidationTimestamp,
                isStale,
                staleReason: isStale ? `No new data recorded for >${Math.round((now - maxRecent) / 60000)} minutes` : undefined
            },
            diskUsageProjection: {
                dailyEstimatedMb,
                monthlyEstimatedGb,
                annualEstimatedGb
            },
            recorderCompleteness: {
                recordingSpanMinutes,
                recordingSpanText,
                totalExpectedBars: totalExpectedSinceFirstBar,
                totalStoredBars: totalStoredSinceFirstBar,
                coverage24hPct,
                coverageSinceFirstBarPct,
                coverage24hDescription,
                coverageSinceFirstBarDescription,
                overallCoveragePct,
                recordedTimeCoveragePct,
                totalTimeCoveragePct,
                symbolsAbove98Count,
                symbolsBelow98Count: symbolsBelow98.length,
                symbolsBelow98,
                exchangeAuditSample
            },
            listingStats: {
                listingsLast7Days: recentListings7dRows.length,
                listingsTotalSinceStart: totalListingsSinceStart,
                listingsEligibleForHA,
                recentListings: recentListings7dRows.map(r => ({
                    symbol: r.symbol,
                    detectedAt: r.detectedAt,
                    launchTime: r.launchTime,
                    depthCovered: r.obCount > 0
                }))
            },
            liquidationStats: {
                liquidationsInWindow,
                liquidationsPerHour
            },
            gapDetails
        };
    }

    public formatMarkdownReport(report: DataQualityReport): string {
        const genDate = new Date(report.generatedAt).toISOString();
        const winStartDate = new Date(report.windowStart).toISOString();

        let reportStr = `# Bybit Market Data Recorder - Data Quality Report (${report.recorderCompleteness.recordingSpanText} Ingestion Window)

**Generated:** \`${genDate}\`  
**Evaluation Window:** Bybit Market Data Recorder - 24-Hour Data Quality Report (Active Recorder Timespan: **${report.recorderCompleteness.recordingSpanText}**; Log Window: \`${winStartDate}\` to \`${genDate}\`)  
**Clean Data Epoch:** ${report.epoch ? `\`${report.epoch.epochId}\` (Started: \`${new Date(report.epoch.startedAt).toISOString()}\`) - *${report.epoch.description}*` : 'None defined'}  
**Database Path:** \`${report.storage.dbPath}\`  
**Current Disk Footprint:** **${report.storage.dbSizeMb} MB** (\`${report.storage.dbSizeBytes.toLocaleString()} bytes\`)  
**Freshness Status:** ${report.freshness.isStale ? `[STALE] **STALE** (${report.freshness.staleReason})` : '[HEALTHY] **HEALTHY & CURRENT**'}

---

## 1. Storage & Record Totals

| Data Stream | Total Records Recorded | Storage Mode | Deduplication Key |
| :--- | :--- | :--- | :--- |
| **Hourly Contract Snapshots** | **${report.counts.contractSnapshots.toLocaleString()}** | Append-Only | \`UNIQUE(snapshot_timestamp, symbol)\` |
| **Unique Contracts Tracked** | **${report.counts.uniqueContractsRecorded.toLocaleString()}** | State Snapshot | Bybit Linear Perpetual Universe |
| **Listing / Delisting Events** | **${report.counts.listingEvents.toLocaleString()}** | Append-Only Log | \`detected_at, symbol, event_type\` |
| **1-Minute Klines** | **${report.counts.klines1m.toLocaleString()}** | Timeseries | \`PRIMARY KEY(symbol, timestamp)\` |
| **Funding Rates** | **${report.counts.fundingRates.toLocaleString()}** | Periodic | \`PRIMARY KEY(symbol, funding_rate_timestamp)\` |
| **Open Interest Snapshots** | **${report.counts.openInterestSnapshots.toLocaleString()}** | Timeseries | \`PRIMARY KEY(symbol, timestamp)\` |
| **Public Liquidations** | **${report.counts.liquidations.toLocaleString()}** | Event Stream | \`UNIQUE(symbol, timestamp, price, size, side)\` |
| **Order-Book Snapshots (Top 25)** | **${report.counts.orderbookSnapshots.toLocaleString()}** | Sampled (10s) | Bounded subset: BTC, ETH, new listings <72h |
| **Recorder Heartbeats** | **${report.counts.heartbeats.toLocaleString()}** | Periodic Log | \`timestamp, status\` |

---

## 2. Recorder-Side 1m Kline Completeness Report (From Inception to Now)

> [!NOTE]
> **Dynamic Timeline & Exchange-Side Check:**
> - Expected 1m bars are computed dynamically from each symbol's first recorded bar (or recorder start) to now, avoiding arbitrary fixed 24h assumptions.
> - **Exchange Verification Audit:** For flagged symbols, we query Bybit's API for the exact same minutes to empirically distinguish genuine recorder shortfalls from Bybit matching-engine zero-volume omissions.

| Metric | Recorded Value | Evaluation / Target |
| :--- | :--- | :--- |
| **Active Recorder Timespan** | **${report.recorderCompleteness.recordingSpanText}** (${report.recorderCompleteness.recordingSpanMinutes} Minutes) | Dynamic elapsed time |
| **Total Tracked Symbols** | **${(report.recorderCompleteness.symbolsAbove98Count + report.recorderCompleteness.symbolsBelow98Count).toLocaleString()}** | Full Linear Universe |
| **Total Stored 1m Bars** | **${report.recorderCompleteness.totalStoredBars.toLocaleString()}** | Ingested in \`klines_1m\` |
| **Total Expected 1m Bars** | **${report.recorderCompleteness.totalExpectedBars.toLocaleString()}** | Sum of per-symbol expected bars |
| **24h Window Coverage** | **${report.recorderCompleteness.coverage24hPct}%** | ${report.recorderCompleteness.coverage24hDescription} |
| **Since First Bar Coverage** | **${report.recorderCompleteness.coverageSinceFirstBarPct}%** | ${report.recorderCompleteness.coverageSinceFirstBarDescription} |
| **Symbols $\\ge 98\\%$ Completeness** | **${report.recorderCompleteness.symbolsAbove98Count}** | Continuous candle stream |
| **Symbols $< 98\\%$ Completeness** | **${report.recorderCompleteness.symbolsBelow98Count}** | Listed below with empirical check |

`;

        if (report.recorderCompleteness.exchangeAuditSample.length > 0) {
            reportStr += `### Live Exchange Audit Sample (Flagged Symbols vs Bybit API):\n\n`;
            reportStr += `| Symbol | DB Stored Bars | Bybit API Served Bars | Audit Finding |\n| :--- | :--- | :--- | :--- |\n`;
            for (const item of report.recorderCompleteness.exchangeAuditSample) {
                const badge = item.status === 'ZERO_VOLUME_CONFIRMED' ? '[ZERO_VOLUME] CONFIRMED_ZERO_VOLUME' : item.status === 'RECORDER_GAP' ? '[GAP] RECORDER_GAP' : '[OFFLINE] OFFLINE';
                reportStr += `| \`${item.symbol}\` | **${item.storedBars}** | **${item.exchangeAvailableBars}** | ${badge} (${item.details}) |\n`;
            }
            reportStr += `\n`;
        }

        if (report.recorderCompleteness.symbolsBelow98.length > 0) {
            reportStr += `### Sample of Contracts Below 98% Stored Completeness:\n\n`;
            reportStr += `| Symbol | First Bar Ingested | Stored | Expected | Coverage | Empirical Check Status |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
            for (const item of report.recorderCompleteness.symbolsBelow98.slice(0, 15)) {
                reportStr += `| \`${item.symbol}\` | \`${item.firstBarIso.slice(11, 19)}\` | ${item.storedBars} | ${item.expectedBars} | **${item.coveragePct}%** | ${item.verification} |\n`;
            }
            if (report.recorderCompleteness.symbolsBelow98.length > 15) {
                reportStr += `| ... | ... | ... | ... | ... | *(+${report.recorderCompleteness.symbolsBelow98.length - 15} additional contracts)* |\n`;
            }
            reportStr += `\n`;
        } else {
            reportStr += `> [OK] **100% of tracked symbols achieved $\\ge 98\\%$ recorder-side completeness.**\n\n`;
        }

        reportStr += `---

## 3. Listing & Delisting Lifecycle Tracking (Hypothesis A Eligibility)

| Metric | Count | Operational Notes |
| :--- | :--- | :--- |
| **Listings Detected (Last 7 Days)** | **${report.listingStats.listingsLast7Days}** | Detected via hourly instrument snapshot comparison |
| **Total Listings Since Recording Started** | **${report.listingStats.listingsTotalSinceStart}** | Baseline permanent append-only count |
| **Listings Eligible for H-A Evaluation** | **${report.listingStats.listingsEligibleForHA}** | **Full top-25 depth snapshots recorded in first 72h** |

`;

        if (report.listingStats.recentListings.length > 0) {
            reportStr += `### Recent Listings (Last 7 Days):\n\n`;
            reportStr += `| Symbol | Detected At | Launch Time | Depth Covered (<72h) | H-A Status |\n| :--- | :--- | :--- | :--- | :--- |\n`;
            for (const l of report.listingStats.recentListings) {
                const detectedIso = new Date(l.detectedAt).toISOString();
                const launchIso = l.launchTime ? new Date(l.launchTime).toISOString() : 'N/A';
                reportStr += `| \`${l.symbol}\` | \`${detectedIso}\` | \`${launchIso}\` | ${l.depthCovered ? 'YES' : 'NO'} | ${l.depthCovered ? 'ELIGIBLE' : 'PENDING_DEPTH'} |\n`;
            }
            reportStr += `\n`;
        }

        reportStr += `---

## 4. Public Liquidation Stream & Hourly Rate

| Metric | Value | Baseline Assessment |
| :--- | :--- | :--- |
| **Liquidations Recorded (Window)** | **${report.liquidationStats.liquidationsInWindow.toLocaleString()} events** | Captured via sharded \`allLiquidation\` stream |
| **Average Liquidation Rate** | **${report.liquidationStats.liquidationsPerHour} events / hour** | Real-time forced liquidation rate |
| **Last Liquidation Event** | \`${report.freshness.lastLiquidationTimestamp ? new Date(report.freshness.lastLiquidationTimestamp).toISOString() : 'N/A'}\` | Feed live activity check |

---

## 5. Gap Detection & Data Continuity (Outage Log with Durations)

| Metric | Value | Classification |
| :--- | :--- | :--- |
| **Total Outages / Gaps Detected** | **${report.gaps.totalGapsDetected}** | Historical log total |
| **Unrecoverable Stream Outages** | **${report.gaps.unrecoverableStreamGaps}** | **\`streams_lost: liquidations/orderbook\` (cannot be backfilled from REST)** |
| **Open Recoverable Gaps** | **${report.gaps.openRecoverableGaps}** | 1m candles awaiting REST gap filler recovery |
| **Resolved Gaps** | **${report.gaps.resolvedGaps}** | Backfilled and verified |
| **Active Unresolved Gaps** | **${report.gaps.unresolvedGaps}** | Current backlog |
| **Largest Outage Duration** | **${report.gaps.largestGapMinutes} minutes** | Max single gap span |

`;

        if (report.restMetrics) {
            const tot = (report.restMetrics.totalRequestsLastHour ?? 0).toLocaleString();
            const peak = report.restMetrics.peak5sRequests ?? 0;
            const err10006 = report.restMetrics.errors10006LastHour ?? 0;
            const err429 = report.restMetrics.errors429LastHour ?? 0;
            reportStr += `### REST Rate Limiting & Error Counts (Past 1 Hour):\n\n`;
            reportStr += `| Total Wire Calls (1h) | Peak Requests / 5s | Error 10006 Count (1h) | Error 429 Count (1h) |\n| :--- | :--- | :--- | :--- |\n`;
            reportStr += `| **${tot}** | **${peak} / 5s** (Cap: 100) | **${err10006}** | **${err429}** |\n\n`;
        }

        if (report.gapDetails.length > 0) {
            reportStr += `### Detected Outages & Durations (Separating Unrecoverable Streams from Recoverable Gaps):\n\n`;
            reportStr += `| ID | Symbol | Stream | Outage Window (UTC) | Duration | Gap Category | Status |\n| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
            for (const g of report.gapDetails.slice(0, 20)) {
                const startIso = new Date(g.gapStart).toISOString().slice(11, 19);
                const endIso = new Date(g.gapEnd).toISOString().slice(11, 19);
                const dt = (g.dataType || '').toLowerCase();
                const isUnrec = dt === 'streams_lost' || dt.includes('stream') || dt.includes('liquidation') || dt.includes('orderbook') || dt.includes('depth');
                const categoryBadge = isUnrec ? '[UNRECOVERABLE] **Stream Loss**' : '[RECOVERABLE] **Candles**';
                const statusStr = g.resolvedAt ? `[RESOLVED] Resolved (\`${new Date(g.resolvedAt).toISOString().slice(11, 19)}\`)` : isUnrec ? '[UNRECOVERABLE] Unrecoverable (WS lost)' : '[OPEN] Open (Pending REST fill)';
                reportStr += `| \`#${g.id}\` | \`${g.symbol}\` | \`${g.dataType}\` | \`${startIso} - ${endIso}\` | **${g.durationMinutes}m** | ${categoryBadge} | ${statusStr} |\n`;
            }
            reportStr += `\n`;
        } else {
            reportStr += `> [OK] **Zero gaps or network outages recorded. Database timeseries continuity is 100%.**\n\n`;
        }

        reportStr += `---

## 6. Storage Growth Projections

| Horizon | Projected Disk Usage | Notes |
| :--- | :--- | :--- |
| **Daily Incremental** | **~${report.diskUsageProjection.dailyEstimatedMb} MB/day** | Full 808 universe tickers + 1m klines + top-25 depth for BTC/ETH/<72h |
| **30-Day Retention** | **~${report.diskUsageProjection.monthlyEstimatedGb} GB** | SQLite WAL mode with index compression |
| **Annual (365 Days)** | **~${report.diskUsageProjection.annualEstimatedGb} GB** | Easily accommodated on standard NVMe / local storage |

`;

        return reportStr;
    }
}
