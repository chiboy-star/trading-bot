import ccxt from 'ccxt';
import path from 'path';
import fs from 'fs';
import { ADX } from 'technicalindicators';
import { db } from './db';
import config, { DEFAULT_SATELLITE_PAIRS } from './config';
import { createLogger } from './utils/logger';

const log = createLogger('screener');

const upsertMonitoredPairStmt = db.prepare(`
    INSERT INTO monitored_pairs (symbol, base_asset, quote_asset, daily_adx, intraday_adx, composite_score, tier, volume_24h, rank, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
        daily_adx = excluded.daily_adx,
        intraday_adx = excluded.intraday_adx,
        composite_score = excluded.composite_score,
        tier = excluded.tier,
        volume_24h = excluded.volume_24h,
        rank = excluded.rank,
        updated_at = excluded.updated_at;
`);

export interface ScreenedPair {
    symbol: string;
    normalizedSymbol: string;
    baseAsset: string;
    quoteAsset: string;
    volume24h: number;
    dailyAdx: number;
    intradayAdx: number;
    compositeScore: number;
    tier: 'CORE' | 'SATELLITE';
    rank: number;
}

const STABLECOINS = new Set([
    'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'EUR', 'AEUR', 'USTC', 'USDD', 'EURR', 'USDE', 'PYUSD', 'CUSD'
]);

export class DynamicAssetScreener {
    private exchange: any;

    constructor() {
        const bybitHostname = (process.env.BYBIT_HOSTNAME || 'bytick.com').replace(/^api\./, '');
        this.exchange = new ccxt.bybit({
            hostname: bybitHostname,
            options: { defaultType: 'future' },
            timeout: 30000,
            enableRateLimit: true
        });
    }

    /**
     * Normalizes CCXT perpetual futures symbol (e.g. 'BTC/USDT:USDT' -> 'BTC/USDT')
     */
    public normalizeSymbol(symbol: string): string {
        if (symbol.includes(':')) {
            return symbol.split(':')[0];
        }
        return symbol;
    }

    /**
     * Queries Bybit for top 75 USDT perpetual futures pairs ranked by 24h quote volume,
     * filtering out stablecoin pairs and low volume markets (< $15M).
     */
    async fetchTopVolumePairs(limit: number = 75, minQuoteVolume: number = 15000000): Promise<{ symbol: string; quoteVolume: number; base: string }[]> {
        console.log(`\x1b[36m[SCREENER]\x1b[0m Querying Bybit Perpetual Futures for top volume markets...`);
        try {
            const tickers = await this.exchange.fetchTickers();

            const filtered = Object.values(tickers).filter((t: any) => {
                if (!t || !t.symbol || !t.quoteVolume) return false;
                if (!t.symbol.includes('/USDT')) return false;

                const base = t.symbol.split('/')[0].split(':')[0].toUpperCase();
                if (STABLECOINS.has(base)) return false;

                return Number(t.quoteVolume) >= minQuoteVolume;
            }) as any[];

            // Sort descending by 24h quote volume
            filtered.sort((a: any, b: any) => (Number(b.quoteVolume) || 0) - (Number(a.quoteVolume) || 0));

            const top = filtered.slice(0, limit).map((t: any) => ({
                symbol: t.symbol,
                quoteVolume: Number(t.quoteVolume) || 0,
                base: t.symbol.split('/')[0].split(':')[0].toUpperCase()
            }));

            console.log(`\x1b[32m[SCREENER]\x1b[0m Filtered top ${top.length} perpetual futures pairs with > $15M 24h quote volume.`);
            return top;
        } catch (err) {
            console.error(`\x1b[31m[SCREENER ERROR]\x1b[0m Failed fetching tickers:`, err);
            return [];
        }
    }

    /**
     * Backward-compatible alias
     */
    async fetchTop50VolumePairs(): Promise<{ symbol: string; quoteVolume: number; base: string }[]> {
        return this.fetchTopVolumePairs(75, 15000000);
    }

    /**
     * Reads the last known good record for a symbol from monitored_pairs.json or SQLite.
     */
    private getLastKnownPair(symbol: string): ScreenedPair | undefined {
        const normalized = this.normalizeSymbol(symbol);
        try {
            const jsonPath = path.resolve(process.cwd(), 'data/monitored_pairs.json');
            if (fs.existsSync(jsonPath)) {
                const pairs = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as ScreenedPair[];
                const match = pairs.find(p => p.normalizedSymbol === normalized || p.symbol === symbol || p.baseAsset === normalized.split('/')[0]);
                if (match) return match;
            }
            const row = db.prepare('SELECT * FROM monitored_pairs WHERE symbol = ?').get(normalized) as any;
            if (row) {
                return {
                    symbol: row.symbol,
                    normalizedSymbol: row.symbol,
                    baseAsset: row.base_asset,
                    quoteAsset: row.quote_asset,
                    volume24h: Number(row.volume_24h || 0),
                    dailyAdx: Number(row.daily_adx || 0),
                    intradayAdx: Number(row.intraday_adx || 0),
                    compositeScore: Number(row.composite_score || 0),
                    tier: (row.tier || 'CORE') as 'CORE' | 'SATELLITE',
                    rank: Number(row.rank || 1)
                };
            }
        } catch {
            // ignore
        }
        return undefined;
    }

    /**
     * Calculates 14-period ADX on the Daily (1D) timeframe for a symbol with exponential backoff.
     */
    async calculateDailyAdx(symbol: string, maxRetries: number = 3): Promise<number> {
        const marketSymbol = symbol.includes(':') ? symbol : `${symbol}:USDT`;
        let delay = 3000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const ohlcv = await this.exchange.fetchOHLCV(marketSymbol, '1d', undefined, 40);
                if (!ohlcv || ohlcv.length < 28) continue;

                const highs = ohlcv.map((c: any) => c[2] as number);
                const lows = ohlcv.map((c: any) => c[3] as number);
                const closes = ohlcv.map((c: any) => c[4] as number);

                const adxResult = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
                if (!adxResult || adxResult.length === 0) continue;
                return adxResult[adxResult.length - 1]?.adx ?? 0;
            } catch (err: any) {
                const isRateLimit = err instanceof ccxt.RateLimitExceeded ||
                    (err?.message && (err.message.includes('10006') || err.message.toLowerCase().includes('rate limit')));

                if (isRateLimit && attempt < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    delay *= 2;
                } else if (attempt < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        }
        const lastKnown = this.getLastKnownPair(symbol);
        return lastKnown?.dailyAdx && lastKnown.dailyAdx > 0 ? lastKnown.dailyAdx : 25;
    }

    /**
     * Calculates 14-period ADX on the Intraday timeframe (15m/1h) for a symbol with exponential backoff.
     */
    async calculateIntradayAdx(symbol: string, timeframe: string = config.exchange.timeframe, maxRetries: number = 3): Promise<number> {
        const marketSymbol = symbol.includes(':') ? symbol : `${symbol}:USDT`;
        let delay = 3000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const ohlcv = await this.exchange.fetchOHLCV(marketSymbol, timeframe, undefined, 40);
                if (!ohlcv || ohlcv.length < 28) continue;

                const highs = ohlcv.map((c: any) => c[2] as number);
                const lows = ohlcv.map((c: any) => c[3] as number);
                const closes = ohlcv.map((c: any) => c[4] as number);

                const adxResult = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
                if (!adxResult || adxResult.length === 0) continue;
                return adxResult[adxResult.length - 1]?.adx ?? 0;
            } catch (err: any) {
                const isRateLimit = err instanceof ccxt.RateLimitExceeded ||
                    (err?.message && (err.message.includes('10006') || err.message.toLowerCase().includes('rate limit')));

                if (isRateLimit && attempt < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    delay *= 2;
                } else if (attempt < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        }
        const lastKnown = this.getLastKnownPair(symbol);
        return lastKnown?.intradayAdx && lastKnown.intradayAdx > 0 ? lastKnown.intradayAdx : 25;
    }

    /**
     * Runs full 15-coin "Core + Satellite" screening pipeline:
     * 1. Pinned 7 Core Pairs are ALWAYS included (tier: 'CORE', ranks 1-7).
     * 2. Scan top 75 volume pairs (> $15M volume).
     * 3. For satellite candidates, calculate Composite Trend Score: 0.4 * ADX_1D + 0.6 * ADX_INTRADAY.
     * 4. Filter for ADX_INTRADAY >= 20 to avoid choppy coins on the active timeframe.
     * 5. Rank top dynamic slots (default 5) as 'SATELLITE' (ranks 8-12).
     * 6. Persist to SQLite and monitored_pairs.json.
     * 7. Fallback gracefully to last known good state if network/API drops.
     */
    async runScreening(): Promise<ScreenedPair[]> {
        const corePairsConfig = config.watchlist.pinnedCorePairs;
        const satelliteSlots = config.watchlist.dynamicScreenerSlots;
        const totalTarget = corePairsConfig.length + satelliteSlots;

        console.log(`\n========================================================================================`);
        console.log(` \x1b[36mHYBRID ASSET SCREENER: ${totalTarget}-COIN CORE + SATELLITE UNIVERSE\x1b[0m`);
        console.log(` Pinned Core: ${corePairsConfig.length} anchors | Satellite Slots: ${satelliteSlots} | Total Target: ${totalTarget}`);
        console.log(` Composite Score: 0.4 * 1D ADX + 0.6 * Intraday ADX (Filter: Intraday ADX >= 20)`);
        console.log(`========================================================================================`);

        try {
            // 1. Process Core Anchors
            const corePairsList: ScreenedPair[] = [];
            const normalizedCoreSet = new Set(corePairsConfig.map(s => this.normalizeSymbol(s)));

            for (let idx = 0; idx < corePairsConfig.length; idx++) {
                const sym = corePairsConfig[idx];
                const normalized = this.normalizeSymbol(sym);
                const base = normalized.split('/')[0];

                let dailyAdx = 22;
                let intradayAdx = 22;
                try {
                    dailyAdx = await this.calculateDailyAdx(sym);
                    intradayAdx = await this.calculateIntradayAdx(sym);
                } catch {
                    const lk = this.getLastKnownPair(sym);
                    dailyAdx = lk?.dailyAdx || 22;
                    intradayAdx = lk?.intradayAdx || 22;
                }
                const composite = Number((0.4 * dailyAdx + 0.6 * intradayAdx).toFixed(2));

                corePairsList.push({
                    symbol: sym.includes(':') ? sym : `${sym}:USDT`,
                    normalizedSymbol: normalized,
                    baseAsset: base,
                    quoteAsset: 'USDT',
                    volume24h: 100000000,
                    dailyAdx: Number(dailyAdx.toFixed(1)),
                    intradayAdx: Number(intradayAdx.toFixed(1)),
                    compositeScore: composite,
                    tier: 'CORE',
                    rank: idx + 1
                });
                await new Promise((r) => setTimeout(r, 250));
            }

            // 2. Fetch top 75 volume pairs
            const topVolumePairs = await this.fetchTopVolumePairs(75, 15000000);

            // Fallback to last known good state if topVolumePairs couldn't be retrieved due to network error/timeout
            if (!topVolumePairs || topVolumePairs.length === 0) {
                console.warn(`\x1b[33m[SCREENER FALLBACK]\x1b[0m Failed fetching top 75 volume pairs from exchange. Preserving last known good state without wiping active watchlist.`);
                const jsonPath = path.resolve(process.cwd(), 'data/monitored_pairs.json');
                if (fs.existsSync(jsonPath)) {
                    try {
                        const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as ScreenedPair[];
                        if (saved && saved.length > 0) {
                            return saved;
                        }
                    } catch {}
                }
                return getMonitoredPairsDetailed();
            }

            // 3. Score candidate satellites (excluding core pairs)
            const satelliteCandidates: {
                symbol: string;
                normalized: string;
                base: string;
                quoteVolume: number;
                dailyAdx: number;
                intradayAdx: number;
                composite: number;
            }[] = [];

            for (const item of topVolumePairs) {
                const normalized = this.normalizeSymbol(item.symbol);
                if (normalizedCoreSet.has(normalized)) continue;

                const dailyAdx = await this.calculateDailyAdx(item.symbol);
                const intradayAdx = await this.calculateIntradayAdx(item.symbol);
                const composite = Number((0.4 * dailyAdx + 0.6 * intradayAdx).toFixed(2));

            satelliteCandidates.push({
                symbol: item.symbol,
                normalized,
                base: item.base,
                quoteVolume: item.quoteVolume,
                dailyAdx,
                intradayAdx,
                composite
            });

            await new Promise((r) => setTimeout(r, 250));
        }

        // 4. Filter for ADX_INTRADAY >= 20 and sort by Composite Trend Score descending
        let qualifiedSatellites = satelliteCandidates.filter(c => c.intradayAdx >= 20);
        qualifiedSatellites.sort((a, b) => b.composite - a.composite);

        // If fewer than requested slots meet the 20 filter, take highest available composite scores
        if (qualifiedSatellites.length < satelliteSlots) {
            satelliteCandidates.sort((a, b) => b.composite - a.composite);
            qualifiedSatellites = satelliteCandidates;
        }

        const selectedSatellites = qualifiedSatellites.slice(0, satelliteSlots);
        const satellitePairsList: ScreenedPair[] = selectedSatellites.map((s, idx) => ({
            symbol: s.symbol,
            normalizedSymbol: s.normalized,
            baseAsset: s.base,
            quoteAsset: 'USDT',
            volume24h: s.quoteVolume,
            dailyAdx: Number(s.dailyAdx.toFixed(1)),
            intradayAdx: Number(s.intradayAdx.toFixed(1)),
            compositeScore: s.composite,
            tier: 'SATELLITE',
            rank: corePairsList.length + idx + 1
        }));

        const finalScreenedList = [...corePairsList, ...satellitePairsList];

        console.log(`\n\x1b[32m[SCREENER COMPLETE]\x1b[0m ${finalScreenedList.length}-Coin Core + Satellite Universe Selected:`);
        console.log(`----------------------------------------------------------------------------------------`);
        console.log(` Rank | Symbol          | Tier      | 1D ADX  | Intra ADX | Composite | Status`);
        console.log(`----------------------------------------------------------------------------------------`);

        finalScreenedList.forEach(p => {
            const tierStr = p.tier === 'CORE' ? `\x1b[36mCORE     \x1b[0m` : `\x1b[35mSATELLITE\x1b[0m`;
            const statusStr = p.intradayAdx >= 20 ? `\x1b[32mTRENDING (>=20)\x1b[0m` : `\x1b[33mANCHOR\x1b[0m`;
            console.log(
                ` #${String(p.rank).padStart(2, ' ')}  | ${p.normalizedSymbol.padEnd(15)} | ${tierStr} | ${p.dailyAdx.toFixed(1).padEnd(7)} | ${p.intradayAdx.toFixed(1).padEnd(9)} | ${p.compositeScore.toFixed(1).padEnd(9)} | ${statusStr}`
            );
        });

        // Persist to SQLite monitored_pairs
        const now = Date.now();
        const updatePairsTx = db.transaction(() => {
            db.prepare('DELETE FROM monitored_pairs').run();
            for (const p of finalScreenedList) {
                upsertMonitoredPairStmt.run(
                    p.normalizedSymbol,
                    p.baseAsset,
                    'USDT',
                    p.dailyAdx,
                    p.intradayAdx,
                    p.compositeScore,
                    p.tier,
                    p.volume24h,
                    p.rank,
                    now
                );
            }
        });
        updatePairsTx();

        // Save JSON config for dashboard & live runner consumption
        const jsonPath = path.resolve(process.cwd(), 'data/monitored_pairs.json');
        try {
            fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
            fs.writeFileSync(jsonPath, JSON.stringify(finalScreenedList, null, 2), 'utf-8');
            console.log(`\n\x1b[36m[CONFIG SAVED]\x1b[0m Written to ${jsonPath} and SQLite table 'monitored_pairs'.\n`);
        } catch (e) {
            console.error("Failed saving monitored_pairs.json:", e);
        }

        return finalScreenedList;
    } catch (err: any) {
        console.warn(`\x1b[33m[SCREENER FALLBACK]\x1b[0m Screener encountered error (${err?.message || err}). Falling back to last known good state from data/monitored_pairs.json.`);
        const jsonPath = path.resolve(process.cwd(), 'data/monitored_pairs.json');
        if (fs.existsSync(jsonPath)) {
            try {
                const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as ScreenedPair[];
                if (saved && saved.length > 0) {
                    return saved;
                }
            } catch {}
        }
        return getMonitoredPairsDetailed();
    }
}

    /**
     * Schedules the screener to run automatically every 6 hours.
     */
    schedule6Hours(): NodeJS.Timeout {
        const hours = config.watchlist.screeningIntervalHours || 6;
        const intervalMs = hours * 60 * 60 * 1000;
        console.log(`\x1b[35m[SCHEDULER]\x1b[0m Dynamic Asset Screener scheduled to run automatically every ${hours} hours.`);

        return setInterval(() => {
            console.log(`\x1b[35m[SCHEDULER TRIGGER]\x1b[0m Running scheduled ${hours}-hour asset screening scan...`);
            this.runScreening().catch((err) => console.error("Scheduled screener error:", err));
        }, intervalMs);
    }

    schedule24Hours(): NodeJS.Timeout {
        return this.schedule6Hours();
    }
}

/**
 * Loads currently monitored pairs from SQLite or fallback JSON.
 */
export function getMonitoredPairs(): string[] {
    try {
        const rows = db.prepare('SELECT symbol FROM monitored_pairs ORDER BY rank ASC').all() as { symbol: string }[];
        if (rows && rows.length > 0) {
            return rows.map((r) => r.symbol);
        }

        const jsonPath = path.resolve(process.cwd(), 'data/monitored_pairs.json');
        if (fs.existsSync(jsonPath)) {
            const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as ScreenedPair[];
            return parsed.map((p) => p.normalizedSymbol);
        }
    } catch {
        // Fallback default
    }
    return [...config.watchlist.pinnedCorePairs, ...DEFAULT_SATELLITE_PAIRS];
}

export function getMonitoredPairsDetailed(): ScreenedPair[] {
    try {
        const rows = db.prepare('SELECT * FROM monitored_pairs ORDER BY rank ASC').all() as any[];
        if (rows && rows.length > 0) {
            return rows.map(r => ({
                symbol: r.symbol,
                normalizedSymbol: r.symbol,
                baseAsset: r.base_asset,
                quoteAsset: r.quote_asset,
                volume24h: Number(r.volume_24h || 0),
                dailyAdx: Number(r.daily_adx || 0),
                intradayAdx: Number(r.intraday_adx || 0),
                compositeScore: Number(r.composite_score || 0),
                tier: (r.tier || 'CORE') as 'CORE' | 'SATELLITE',
                rank: Number(r.rank || 1)
            }));
        }

        const jsonPath = path.resolve(process.cwd(), 'data/monitored_pairs.json');
        if (fs.existsSync(jsonPath)) {
            return JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as ScreenedPair[];
        }
    } catch {
        // Fallback
    }

    const allFallback = [
        ...config.watchlist.pinnedCorePairs.map((sym, idx) => ({
            symbol: sym,
            normalizedSymbol: sym,
            baseAsset: sym.split('/')[0],
            quoteAsset: 'USDT',
            volume24h: 100000000,
            dailyAdx: 25,
            intradayAdx: 25,
            compositeScore: 25,
            tier: 'CORE' as const,
            rank: idx + 1
        })),
        ...DEFAULT_SATELLITE_PAIRS.map((sym, idx) => ({
            symbol: sym,
            normalizedSymbol: sym,
            baseAsset: sym.split('/')[0],
            quoteAsset: 'USDT',
            volume24h: 30000000,
            dailyAdx: 28,
            intradayAdx: 28,
            compositeScore: 28,
            tier: 'SATELLITE' as const,
            rank: config.watchlist.pinnedCorePairs.length + idx + 1
        }))
    ];

    return allFallback;
}

// Standalone execution entrypoint
if (require.main === module) {
    const screener = new DynamicAssetScreener();
    screener.runScreening().catch(console.error);
}
