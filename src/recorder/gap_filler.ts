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
     * 
     * Rule: A gap is recorded ONLY when missing candles are CONFIRMED missing after a successful fetch
     * (HTTP 200, retCode 0), comparing against the last closed minute: floor(now/60000)*60000 - 60000.
     */
    public async backfillStartupGaps(
        trackedSymbols: string[],
        maxLookbackMinutes: number = 10080, // Default: 7 days lookback (configurable)
        rankedByTurnoverSymbols?: string[]
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
        // Compare strictly against the last CLOSED minute
        const lastClosedMinute = Math.floor(now / 60000) * 60000 - 60000;
        const maxLookbackMs = maxLookbackMinutes * 60 * 1000;
        const minAllowedTs = lastClosedMinute - maxLookbackMs;

        log.info({
            trackedSymbolsCount: trackedSymbols.length,
            maxLookbackMinutes,
            lastClosedMinuteIso: new Date(lastClosedMinute).toISOString()
        }, 'Commencing throttled startup/recovery backfill scan for all symbols...');

        const CHUNK_SIZE = 8;
        const CHUNK_DELAY_MS = 200; // ~10 req/s ceiling

        // 1. Backfill 1m Klines per symbol in throttled chunks
        for (let i = 0; i < trackedSymbols.length; i += CHUNK_SIZE) {
            if (this.client.isBanActive()) {
                log.warn('Bybit REST ban circuit breaker is active; pausing backfill loop.');
                break;
            }

            const chunk = trackedSymbols.slice(i, i + CHUNK_SIZE);

            for (const symbol of chunk) {
                summary.symbolsChecked++;
                const latestTs = this.db.getLatestKlineTimestamp(symbol);

                if (!latestTs) {
                    // Cold start: fetch recent initial 1000 closed bars
                    try {
                        const initialKlines = await this.client.fetch1mKlines(symbol, 1000, minAllowedTs, lastClosedMinute);
                        const closedInitial = initialKlines.filter(k => k.timestamp <= lastClosedMinute);
                        if (closedInitial.length > 0) {
                            const count = this.db.insertKlines(closedInitial);
                            summary.candlesFilled += count;
                            summary.details.push(`${symbol}: Cold start populated with ${count} 1m candles`);
                        }
                    } catch (err: any) {
                        summary.details.push(`${symbol}: Cold start fetch error: ${err.message}`);
                    }
                    continue;
                }

                // If latest stored bar is before the last closed minute, check missing span
                if (latestTs < lastClosedMinute) {
                    const fetchStart = Math.max(latestTs + 60000, minAllowedTs);
                    const fetchEnd = lastClosedMinute;
                    const expectedBarsCount = Math.floor((fetchEnd - fetchStart) / 60000) + 1;

                    if (expectedBarsCount <= 0) continue;

                    let missingKlines: Kline1m[] = [];
                    let fetchSucceeded = false;
                    let fetchErrorMessage = '';

                    try {
                        missingKlines = await this.fetchAll1mKlinesInRange(symbol, fetchStart, fetchEnd);
                        // Filter out any bar beyond the last closed minute
                        missingKlines = missingKlines.filter(k => k.timestamp <= lastClosedMinute);
                        fetchSucceeded = true;
                    } catch (err: any) {
                        fetchErrorMessage = err?.message || String(err);
                        log.warn({ symbol, err: fetchErrorMessage }, 'Kline fetch failed during backfill');
                    }

                    if (fetchSucceeded) {
                        let inserted = 0;
                        if (missingKlines.length > 0) {
                            inserted = this.db.insertKlines(missingKlines);
                            summary.candlesFilled += inserted;
                        }

                        // Gap confirmation rule:
                        // Record a gap only if missing candles are CONFIRMED missing after successful fetch
                        if (missingKlines.length < expectedBarsCount) {
                            const missingCount = expectedBarsCount - missingKlines.length;
                            summary.gapsDetected++;

                            // Record confirmed gap; mark resolved since the exchange was queried and all available bars were stored
                            const gapId = this.db.recordGap({
                                symbol,
                                dataType: 'kline_1m',
                                gapStart: fetchStart,
                                gapEnd: fetchEnd,
                                missingCount,
                                detectedAt: now,
                                resolvedAt: now,
                                cause: 'confirmed_zero_volume_or_exchange_omission'
                            });

                            summary.details.push(
                                `${symbol}: Confirmed ${missingCount} empty/missing bars across ${expectedBarsCount}m window (filled ${inserted} available bars)`
                            );
                        } else {
                            summary.details.push(
                                `${symbol}: Backfilled ${inserted} missing 1m candles seamlessly (100% contiguous)`
                            );
                        }
                    } else {
                        // Fetch failed: do NOT record a confirmed gap; record open gap for retry if desired
                        summary.unresolvedGaps++;
                        summary.details.push(`${symbol}: Gap fill fetch error: ${fetchErrorMessage}`);
                    }
                }
            }

            // Pacing delay between chunks
            if (i + CHUNK_SIZE < trackedSymbols.length) {
                await new Promise(res => setTimeout(res, CHUNK_DELAY_MS));
            }
        }

        // 2. Backfill Funding Rates & Open Interest
        // Prioritize symbols ranked by 24h turnover if provided, otherwise all symbols in throttled mode
        const targetFundingSymbols = rankedByTurnoverSymbols && rankedByTurnoverSymbols.length > 0
            ? rankedByTurnoverSymbols
            : trackedSymbols;

        for (const symbol of targetFundingSymbols) {
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
            await new Promise(res => setTimeout(res, 20));
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
     * Records streams_lost for the outage window, then backfills klines and funding for affected symbols.
     */
    public async backfillAfterOutage(
        affectedSymbols: string[],
        outageStart: number,
        outageEnd: number,
        cause: string = 'network_outage'
    ): Promise<GapFillSummary> {
        const durationMinutes = Math.max(1, Math.round((outageEnd - outageStart) / 60000));
        log.warn({
            outageStart: new Date(outageStart).toISOString(),
            outageEnd: new Date(outageEnd).toISOString(),
            durationMinutes,
            cause,
            symbolsCount: affectedSymbols.length
        }, '[RECOVERY] Executing post-outage recovery: recording streams_lost and backfilling affected symbols');

        // Record streams_lost: liquidations and orderbook snapshots cannot be backfilled
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

        // Backfill only the affected symbols and duration
        return this.backfillStartupGaps(affectedSymbols, Math.max(60, durationMinutes + 15));
    }

    /**
     * Fetches all 1m klines across a time window by paging through windows > 1,000 bars.
     * Filters out any forming candle (timestamp + 60000 > now).
     */
    public async fetchAll1mKlinesInRange(
        symbol: string,
        startTs: number,
        endTs: number
    ): Promise<Kline1m[]> {
        const allKlines: Kline1m[] = [];
        let cursorStart = startTs;
        const seenTimestamps = new Set<number>();
        const maxPages = 50; // allows backfilling up to 50,000 bars (~34 days)
        let pageCount = 0;
        const now = Date.now();

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
                // Reject currently forming candles
                if (bar.timestamp + 60000 > now) continue;

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
     * Scans and resolves open kline_1m gaps in data_gaps table.
     * Pages through gaps, inserts missing candles (insert-only),
     * and calls resolveGap ONLY when the filled range is verified contiguous or the exchange
     * returned a successful empty result for it. A fetch error leaves the gap open.
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

        log.info({ openGapsCount: openGaps.length }, 'Resolving open kline gaps with verified contiguous checks...');
        let resolvedCount = 0;
        let candlesFilled = 0;

        const BATCH_SIZE = 6;
        for (let i = 0; i < openGaps.length; i += BATCH_SIZE) {
            if (this.client.isBanActive()) break;

            const batch = openGaps.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(async (gap) => {
                    let klines: Kline1m[] = [];
                    try {
                        klines = await this.fetchAll1mKlinesInRange(gap.symbol, gap.gapStart, gap.gapEnd);
                    } catch (err: any) {
                        // Fetch failed: re-throw so Promise.allSettled marks as rejected (leaves gap open)
                        throw new Error(`Fetch error for ${gap.symbol} [${gap.gapStart}-${gap.gapEnd}]: ${err.message}`);
                    }

                    let inserted = 0;
                    if (klines.length > 0) {
                        inserted = this.db.insertKlines(klines);
                    }

                    // Verification: resolveGap ONLY when range is verified contiguous or exchange confirmed empty result
                    const expectedBars = Math.max(1, Math.floor((gap.gapEnd - gap.gapStart) / 60000) + 1);
                    const isContiguous = klines.length === expectedBars;
                    const isEmptyConfirmed = klines.length === 0;

                    if (isContiguous || isEmptyConfirmed) {
                        this.db.resolveGap(gap.id, Date.now());
                        return { gapId: gap.id, inserted, resolved: true };
                    } else {
                        // Partial fill: inserted available bars, but leave gap open for remaining missing bars
                        return { gapId: gap.id, inserted, resolved: false };
                    }
                })
            );

            for (const res of results) {
                if (res.status === 'fulfilled') {
                    candlesFilled += res.value.inserted;
                    if (res.value.resolved) {
                        resolvedCount++;
                    }
                } else {
                    log.warn({ err: res.reason?.message || res.reason }, 'Failed to resolve kline gap; leaving gap open');
                }
            }

            if ((i + BATCH_SIZE) % 60 === 0 || i + BATCH_SIZE >= openGaps.length) {
                log.info({
                    progress: `${Math.min(i + BATCH_SIZE, openGaps.length)}/${openGaps.length}`,
                    resolvedCount,
                    candlesFilled
                }, 'Resolving open kline gaps progress');
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
