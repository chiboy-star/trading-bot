import { BybitPublicClient } from './bybit_client';
import { RecorderDB } from './db';
import { DataGap, Kline1m } from './types';
import { createLogger } from '../utils/logger';

const log = createLogger('gap-filler');

export interface GapFillSummary {
    symbolsChecked: number;
    gapsDetected: number;
    candlesFilled: number;
    fundingFilled: number;
    openInterestFilled: number;
    unresolvedGaps: number;
    details: string[];
}

export class GapFiller {
    private client: BybitPublicClient;
    private db: RecorderDB;

    constructor(client: BybitPublicClient, db: RecorderDB) {
        this.client = client;
        this.db = db;
    }

    /**
     * Inspects stored 1m klines for missing intervals.
     */
    public detectKlineGaps(symbol: string, fromTimestamp: number, toTimestamp: number): DataGap[] {
        const klines = this.db.getKlines(symbol, fromTimestamp, toTimestamp);
        const gaps: DataGap[] = [];

        if (klines.length <= 1) return gaps;

        const intervalMs = 60000; // 1 minute
        for (let i = 1; i < klines.length; i++) {
            const diff = klines[i].timestamp - klines[i - 1].timestamp;
            if (diff > intervalMs) {
                const gapStart = klines[i - 1].timestamp + intervalMs;
                const gapEnd = klines[i].timestamp - intervalMs;
                const missingCount = Math.floor(diff / intervalMs) - 1;

                const gap: DataGap = {
                    symbol,
                    dataType: 'kline_1m',
                    gapStart,
                    gapEnd,
                    missingCount,
                    detectedAt: Date.now(),
                    cause: 'kline_missing_interval'
                };
                gaps.push(gap);
            }
        }

        return gaps;
    }

    /**
     * Routine executed on recorder startup or post-outage:
     * Checks the latest recorded timestamp for each tracked contract and fetches missing 1m klines,
     * funding rates, and open interest.
     * Inserts missing rows only (no updates or deletes, WAL & append-only safe).
     */
    public async backfillStartupGaps(
        trackedSymbols: string[],
        maxLookbackMinutes: number = 1440 // 24 hours max backfill window
    ): Promise<GapFillSummary> {
        const summary: GapFillSummary = {
            symbolsChecked: 0,
            gapsDetected: 0,
            candlesFilled: 0,
            fundingFilled: 0,
            openInterestFilled: 0,
            unresolvedGaps: 0,
            details: []
        };

        const now = Date.now();
        const maxLookbackMs = maxLookbackMinutes * 60 * 1000;
        log.info({ trackedSymbolsCount: trackedSymbols.length }, 'Commencing throttled startup/recovery backfill scan for all symbols...');

        const CHUNK_SIZE = 8;
        const CHUNK_DELAY_MS = 500; // 500ms throttle between batches of 8 (~16 req/s ceiling)

        // 1. Backfill 1m Klines per symbol in throttled chunks
        for (let i = 0; i < trackedSymbols.length; i += CHUNK_SIZE) {
            // If IP ban is active, halt backfill immediately
            if (this.client.isBanActive()) {
                log.warn('Bybit REST ban circuit breaker is active; pausing startup backfill loop.');
                break;
            }

            const chunk = trackedSymbols.slice(i, i + CHUNK_SIZE);

            for (const symbol of chunk) {
                summary.symbolsChecked++;
                const latestTs = this.db.getLatestKlineTimestamp(symbol);

                if (!latestTs) {
                    // Cold start: fetch recent initial 1000 bars (covers ~16.6h)
                    try {
                        const initialKlines = await this.client.fetch1mKlines(symbol, 1000);
                        if (initialKlines.length > 0) {
                            const count = this.db.insertKlines(initialKlines);
                            summary.candlesFilled += count;
                            summary.details.push(`${symbol}: Cold start populated with ${count} 1m candles`);
                        }
                    } catch (err: any) {
                        summary.details.push(`${symbol}: Cold start fetch error: ${err.message}`);
                    }
                    continue;
                }

                const gapDurationMs = now - latestTs;
                // If more than 1 minute missing, we have a gap to fill
                if (gapDurationMs > 60000) {
                    const missingCount = Math.floor(gapDurationMs / 60000);
                    summary.gapsDetected++;

                    const gapId = this.db.recordGap({
                        symbol,
                        dataType: 'kline_1m',
                        gapStart: latestTs + 60000,
                        gapEnd: now,
                        missingCount,
                        detectedAt: now,
                        cause: 'outage_or_rotation_shortfall'
                    });

                    // Fetch missing bars with pagination for windows > 1,000 bars
                    try {
                        const fetchStart = Math.max(latestTs + 60000, now - maxLookbackMs);
                        const missingKlines = await this.fetchAll1mKlinesInRange(symbol, fetchStart, now);

                        if (missingKlines.length > 0) {
                            const count = this.db.insertKlines(missingKlines);
                            summary.candlesFilled += count;
                            this.db.resolveGap(gapId, Date.now());
                            summary.details.push(`${symbol}: Backfilled ${count} missing 1m candles across ${missingCount}m gap`);
                        } else {
                            summary.unresolvedGaps++;
                            summary.details.push(`${symbol}: Gap detected (${missingCount}m) but exchange served 0 candles`);
                        }
                    } catch (err: any) {
                        summary.unresolvedGaps++;
                        summary.details.push(`${symbol}: Gap fill failed: ${err.message}`);
                    }
                }
            }

            // Pacing delay between chunks of 10 symbols
            if (i + CHUNK_SIZE < trackedSymbols.length) {
                await new Promise(res => setTimeout(res, CHUNK_DELAY_MS));
            }
        }

        // 2. Backfill Funding Rates & Open Interest for Core Symbols
        const coreSymbols = trackedSymbols.slice(0, 50); // prioritize top symbols for historical funding & OI
        for (const symbol of coreSymbols) {
            if (this.client.isBanActive()) break;
            try {
                const latestFunding = this.db.getLatestFundingRateTimestamp(symbol);
                if (latestFunding && (now - latestFunding > 8 * 3600 * 1000)) {
                    const histFunding = await this.client.fetchHistoricalFundingRates(symbol, 50, latestFunding + 1);
                    if (histFunding.length > 0) {
                        this.db.insertFundingRates(histFunding, true);
                        summary.fundingFilled += histFunding.length;
                    }
                }

                const latestOI = this.db.getLatestOpenInterestTimestamp(symbol);
                if (latestOI && (now - latestOI > 10 * 60 * 1000)) {
                    const histOI = await this.client.fetchHistoricalOpenInterest(symbol, '5min', 50, latestOI + 1);
                    if (histOI.length > 0) {
                        this.db.insertOpenInterest(histOI, true);
                        summary.openInterestFilled += histOI.length;
                    }
                }
            } catch {
                // Ignore transient historical funding/OI errors
            }
        }

        log.info({
            candlesFilled: summary.candlesFilled,
            fundingFilled: summary.fundingFilled,
            openInterestFilled: summary.openInterestFilled,
            gapsDetected: summary.gapsDetected,
            unresolvedGaps: summary.unresolvedGaps
        }, 'Startup/recovery backfill scan completed');

        return summary;
    }

    /**
     * Backfill routine executed immediately after an outage is resolved.
     * Marks streaming feeds as streams_lost, then backfills klines, funding, and open interest from REST history.
     */
    public async backfillAfterOutage(
        trackedSymbols: string[],
        outageStart: number,
        outageEnd: number,
        cause: string = 'network_outage'
    ): Promise<GapFillSummary> {
        const durationMinutes = Math.max(1, Math.round((outageEnd - outageStart) / 60000));
        log.warn({
            outageStart: new Date(outageStart).toISOString(),
            outageEnd: new Date(outageEnd).toISOString(),
            durationMinutes,
            cause
        }, '[RECOVERY] Executing post-outage recovery: recording streams_lost and backfilling REST data');

        // 1. Mark streaming feeds as permanently lost during outage window (liquidations & orderbook depth cannot be backfilled)
        this.db.recordGap({
            symbol: 'ALL',
            dataType: 'streams_lost',
            gapStart: outageStart,
            gapEnd: outageEnd,
            missingCount: durationMinutes,
            detectedAt: outageEnd,
            resolvedAt: outageEnd,
            cause: `Streams lost: liquidations and orderbook snapshots cannot be backfilled from REST (${cause})`
        });

        // 2. Backfill 1m klines, funding, and open interest
        return this.backfillStartupGaps(trackedSymbols, Math.max(60, durationMinutes + 10));
    }

    /**
     * Fetches all 1m klines across a time window by paging through windows > 1,000 bars.
     * Guaranteed insert-only within the rate limiter.
     */
    public async fetchAll1mKlinesInRange(
        symbol: string,
        startTs: number,
        endTs: number
    ): Promise<Kline1m[]> {
        const allKlines: Kline1m[] = [];
        let cursorStart = startTs;
        const seenTimestamps = new Set<number>();
        const maxPages = 20; // safety ceiling up to 20,000 bars
        let pageCount = 0;

        while (cursorStart < endTs && pageCount < maxPages) {
            if (this.client.isBanActive()) break;
            pageCount++;

            const chunkEnd = Math.min(endTs, cursorStart + 1000 * 60 * 1000);
            const page = await this.client.fetch1mKlines(symbol, 1000, cursorStart, chunkEnd);

            if (page.length === 0) {
                // Advance cursor if no trades occurred in this window (zero volume)
                cursorStart = chunkEnd + 60000;
                continue;
            }

            for (const bar of page) {
                if (!seenTimestamps.has(bar.timestamp)) {
                    seenTimestamps.add(bar.timestamp);
                    allKlines.push(bar);
                }
            }

            const maxPageTs = Math.max(...page.map(b => b.timestamp));
            if (maxPageTs <= cursorStart) {
                cursorStart += 1000 * 60 * 1000;
            } else {
                cursorStart = maxPageTs + 60000;
            }
        }

        return allKlines.sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Scans and resolves all open kline_1m gaps in data_gaps table.
     * Pages through gaps > 1,000 bars, inserts missing candles (insert-only),
     * and marks the gap records resolved.
     */
    public async resolveOpenKlineGaps(): Promise<{
        resolvedCount: number;
        remainingGaps: number;
        candlesFilled: number;
    }> {
        const rawDb = this.db.getRawDb();
        const openGaps = rawDb.prepare(`
            SELECT id, symbol, gap_start as gapStart, gap_end as gapEnd, missing_count as missingCount
            FROM data_gaps
            WHERE resolved_at IS NULL AND data_type = 'kline_1m'
            ORDER BY gap_start ASC
        `).all() as Array<{ id: number; symbol: string; gapStart: number; gapEnd: number; missingCount: number }>;

        log.info({ openGapsCount: openGaps.length }, 'Resolving open kline gaps with paging > 1,000 bars...');
        let resolvedCount = 0;
        let candlesFilled = 0;

        const BATCH_SIZE = 6;
        for (let i = 0; i < openGaps.length; i += BATCH_SIZE) {
            if (this.client.isBanActive()) break;

            const batch = openGaps.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(async (gap) => {
                    const klines = await this.fetchAll1mKlinesInRange(gap.symbol, gap.gapStart, gap.gapEnd);
                    let inserted = 0;
                    if (klines.length > 0) {
                        inserted = this.db.insertKlines(klines);
                    }
                    this.db.resolveGap(gap.id, Date.now());
                    return { gapId: gap.id, inserted };
                })
            );

            for (const res of results) {
                if (res.status === 'fulfilled') {
                    resolvedCount++;
                    candlesFilled += res.value.inserted;
                } else {
                    log.warn({ err: res.reason?.message || res.reason }, 'Failed to resolve kline gap in batch');
                }
            }

            if ((i + BATCH_SIZE) % 60 === 0 || i + BATCH_SIZE >= openGaps.length) {
                log.info({ progress: `${Math.min(i + BATCH_SIZE, openGaps.length)}/${openGaps.length}`, resolvedCount, candlesFilled }, 'Resolving open kline gaps progress');
            }
        }

        const remainingGapsRow = rawDb.prepare(`
            SELECT COUNT(*) as count FROM data_gaps WHERE resolved_at IS NULL AND data_type = 'kline_1m'
        `).get() as { count: number };

        const remainingGaps = remainingGapsRow?.count || 0;
        log.info({ resolvedCount, remainingGaps, candlesFilled }, 'Completed open kline gaps resolution');

        return { resolvedCount, remainingGaps, candlesFilled };
    }
}
