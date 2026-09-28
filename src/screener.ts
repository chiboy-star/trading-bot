import ccxt from 'ccxt';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { ADX } from 'technicalindicators';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function getCanonicalDbPath(): string {
    const rootPath = path.resolve(process.cwd(), 'data/market_data.db');
    if (fs.existsSync(rootPath)) return rootPath;
    const parentPath = path.resolve(process.cwd(), '../data/market_data.db');
    if (fs.existsSync(parentPath)) return parentPath;
    return path.resolve(__dirname, '../../data/market_data.db');
}

export const db = new Database(getCanonicalDbPath());

// Initialize schema for dynamic asset screening
db.exec(`
    CREATE TABLE IF NOT EXISTS monitored_pairs (
        symbol TEXT PRIMARY KEY,
        base_asset TEXT NOT NULL,
        quote_asset TEXT NOT NULL,
        daily_adx REAL NOT NULL,
        volume_24h REAL NOT NULL,
        rank INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
`);

const upsertMonitoredPairStmt = db.prepare(`
    INSERT INTO monitored_pairs (symbol, base_asset, quote_asset, daily_adx, volume_24h, rank, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
        daily_adx = excluded.daily_adx,
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
    rank: number;
}

const STABLECOINS = new Set([
    'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'EUR', 'AEUR', 'USTC', 'USDD', 'EURR'
]);

export class DynamicAssetScreener {
    private exchange: any;

    constructor() {
        this.exchange = new ccxt.bybit({
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
     * Queries Bybit for top 50 USDT perpetual futures pairs ranked by 24h quote volume,
     * filtering out stablecoin pairs and dead markets.
     */
    async fetchTop50VolumePairs(): Promise<{ symbol: string; quoteVolume: number; base: string }[]> {
        console.log(`\x1b[36m[SCREENER]\x1b[0m Querying Bybit Perpetual Futures for top volume markets...`);
        const tickers = await this.exchange.fetchTickers();

        const filtered = Object.values(tickers).filter((t: any) => {
            if (!t || !t.symbol || !t.quoteVolume || t.quoteVolume <= 0) return false;
            // Target USDT perpetual contracts
            if (!t.symbol.includes('/USDT')) return false;

            const base = t.symbol.split('/')[0].split(':')[0].toUpperCase();
            if (STABLECOINS.has(base)) return false;

            return true;
        }) as any[];

        // Sort descending by 24h quote volume
        filtered.sort((a: any, b: any) => (b.quoteVolume || 0) - (a.quoteVolume || 0));

        const top50 = filtered.slice(0, 50).map((t: any) => ({
            symbol: t.symbol,
            quoteVolume: t.quoteVolume || 0,
            base: t.symbol.split('/')[0].split(':')[0].toUpperCase()
        }));

        console.log(`\x1b[32m[SCREENER]\x1b[0m Filtered top ${top50.length} perpetual futures pairs by 24h quote volume.`);
        return top50;
    }

    /**
     * Calculates 14-period ADX on the Daily (1D) timeframe for a symbol with RateLimitExceeded exponential backoff.
     */
    async calculateDailyAdx(symbol: string, maxRetries: number = 3): Promise<number> {
        const marketSymbol = symbol.includes(':') ? symbol : `${symbol}:USDT`;
        let delay = 5000; // 5-second initial backoff

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Fetch 40 daily candles to ensure sufficient smoothing for 14 ADX
                const ohlcv = await this.exchange.fetchOHLCV(marketSymbol, '1d', undefined, 40);
                if (!ohlcv || ohlcv.length < 28) {
                    return 0;
                }

                const highs = ohlcv.map((c: any) => c[2] as number);
                const lows = ohlcv.map((c: any) => c[3] as number);
                const closes = ohlcv.map((c: any) => c[4] as number);

                const adxResult = ADX.calculate({
                    period: 14,
                    high: highs,
                    low: lows,
                    close: closes
                });

                if (!adxResult || adxResult.length === 0) return 0;
                return adxResult[adxResult.length - 1]?.adx ?? 0;
            } catch (err: any) {
                const isRateLimit =
                    err instanceof ccxt.RateLimitExceeded ||
                    err?.name === 'RateLimitExceeded' ||
                    (err?.message && (err.message.includes('10006') || err.message.toLowerCase().includes('rate limit')));

                if (isRateLimit && attempt < maxRetries) {
                    console.warn(
                        `\x1b[33m[SCREENER RATE LIMIT]\x1b[0m Bybit 10006 on ${symbol}. Waiting ${delay / 1000}s before retry (Attempt ${attempt}/${maxRetries})...`
                    );
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    delay *= 2; // Exponential backoff: 5s -> 10s -> 20s
                } else {
                    console.error(`\x1b[31m[SCREENER WARNING]\x1b[0m Failed fetching 1D candles for ${symbol}: ${err?.message || err}`);
                    return 0;
                }
            }
        }
        return 0;
    }

    /**
     * Runs full screening pipeline:
     * 1. Top 50 volume perpetual futures
     * 2. Calculate 1D 14-period ADX sequentially with 200ms delay
     * 3. Filter ADX > 25 and rank top 5 highest ADX pairs
     * 4. Persist to SQLite and JSON config
     */
    async runScreening(): Promise<ScreenedPair[]> {
        console.log(`\n========================================================================================`);
        console.log(` \x1b[36mDYNAMIC ASSET SCREENER: DAILY TREND REGIME SCAN\x1b[0m`);
        console.log(` Scanning top 50 perpetual futures pairs for highest 1D ADX (> 25)`);
        console.log(`========================================================================================`);

        const topVolumePairs = await this.fetchTop50VolumePairs();
        const results: { symbol: string; quoteVolume: number; base: string; dailyAdx: number }[] = [];

        // Sequentially process one pair at a time with 200ms delay to respect Bybit rate limits
        for (const item of topVolumePairs) {
            const adx = await this.calculateDailyAdx(item.symbol);
            results.push({
                symbol: item.symbol,
                quoteVolume: item.quoteVolume,
                base: item.base,
                dailyAdx: adx
            });
            // Manual 200ms delay between pair fetches
            await new Promise((r) => setTimeout(r, 200));
        }

        // Filter pairs with daily ADX > 25 (Strong directional trend regime)
        const trendingPairs = results.filter((p) => p.dailyAdx > 25);

        // Sort descending by highest 1D ADX
        trendingPairs.sort((a, b) => b.dailyAdx - a.dailyAdx);

        // Take top 5 pairs
        const top5 = trendingPairs.slice(0, 5);

        console.log(`\n\x1b[32m[SCREENER COMPLETE]\x1b[0m Top 5 High-Trend Pairs Selected (ADX > 25):`);
        console.log(`----------------------------------------------------------------------------------------`);
        console.log(` Rank | Symbol          | 1D ADX  | 24h Quote Volume  | Regime Status`);
        console.log(`----------------------------------------------------------------------------------------`);

        const now = Date.now();
        const screenedList: ScreenedPair[] = [];

        // Clear existing monitored pairs and insert newly screened ones
        db.prepare('DELETE FROM monitored_pairs').run();

        top5.forEach((p, idx) => {
            const rank = idx + 1;
            const normalized = this.normalizeSymbol(p.symbol);
            const record: ScreenedPair = {
                symbol: p.symbol,
                normalizedSymbol: normalized,
                baseAsset: p.base,
                quoteAsset: 'USDT',
                volume24h: p.quoteVolume,
                dailyAdx: Number(p.dailyAdx.toFixed(2)),
                rank
            };
            screenedList.push(record);

            // Persist to SQLite
            upsertMonitoredPairStmt.run(
                normalized,
                p.base,
                'USDT',
                record.dailyAdx,
                p.quoteVolume,
                rank,
                now
            );

            console.log(
                ` #${rank}   | ${normalized.padEnd(15)} | ${record.dailyAdx.toFixed(1).padEnd(7)} | $${Math.round(p.quoteVolume).toLocaleString().padEnd(16)} | \x1b[32mSTRONG TREND (>25)\x1b[0m`
            );
        });

        // Save JSON config for dashboard & live runner consumption
        const jsonPath = path.resolve(process.cwd(), 'data/monitored_pairs.json');
        try {
            fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
            fs.writeFileSync(jsonPath, JSON.stringify(screenedList, null, 2), 'utf-8');
            console.log(`\n\x1b[36m[CONFIG SAVED]\x1b[0m Written to ${jsonPath} and SQLite table 'monitored_pairs'.\n`);
        } catch (e) {
            console.error("Failed saving monitored_pairs.json:", e);
        }

        return screenedList;
    }

    /**
     * Schedules the screener to run automatically once every 24 hours.
     */
    schedule24Hours(): NodeJS.Timeout {
        const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
        console.log(`\x1b[35m[SCHEDULER]\x1b[0m Dynamic Asset Screener scheduled to run automatically every 24 hours.`);

        return setInterval(() => {
            console.log(`\x1b[35m[SCHEDULER TRIGGER]\x1b[0m Running scheduled 24-hour asset screening scan...`);
            this.runScreening().catch((err) => console.error("Scheduled screener error:", err));
        }, TWENTY_FOUR_HOURS);
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
    } catch (e) {
        // Fallback default
    }
    return ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
}

// Standalone execution entrypoint
if (require.main === module) {
    const screener = new DynamicAssetScreener();
    screener.runScreening().catch(console.error);
}
