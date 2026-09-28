import ccxt from 'ccxt';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Initialize Database
const dbPath = path.resolve(__dirname, '../data/market_data.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
const db = new Database(dbPath);

// Create table and index
db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
        symbol TEXT,
        timeframe TEXT,
        timestamp INTEGER,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume REAL,
        PRIMARY KEY (symbol, timeframe, timestamp)
    );
`);

// The primary key already creates an index, but we can explicitly create one if needed
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_candles_symbol_timeframe_timestamp
    ON candles (symbol, timeframe, timestamp);
`);

const upsertStmt = db.prepare(`
    INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, timeframe, timestamp) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume;
`);

const exchange = new ccxt.binance({
    enableRateLimit: true,
});

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchHistory(symbol: string, timeframe: string, since: number) {
    console.log(`Starting fetch for ${symbol} - ${timeframe} since ${new Date(since).toISOString()}`);
    let currentSince = since;
    const now = Date.now();
    const limit = 1000;
    
    while (currentSince < now) {
        try {
            console.log(`Fetching ${symbol} since ${new Date(currentSince).toISOString()}...`);
            const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, currentSince, limit);
            
            if (ohlcv.length === 0) {
                console.log(`No more data for ${symbol}.`);
                break;
            }

            const insertMany = db.transaction((candles) => {
                for (const candle of candles) {
                    upsertStmt.run(symbol, timeframe, candle[0], candle[1], candle[2], candle[3], candle[4], candle[5]);
                }
            });
            
            insertMany(ohlcv);
            
            console.log(`Saved ${ohlcv.length} candles for ${symbol}.`);
            
            // Advance since to the last candle's timestamp + 1 to avoid re-fetching the exact same candle
            const lastTimestamp = ohlcv[ohlcv.length - 1][0];
            if (lastTimestamp === undefined) {
                break;
            }
            
            currentSince = lastTimestamp + 1;
            
            // Binance public rate limit safe
            await delay(500);
        } catch (error) {
            console.error(`Error fetching data for ${symbol}:`, error);
            // Wait a bit longer on error
            await delay(5000);
        }
    }
    console.log(`Finished fetch for ${symbol}`);
}

async function verifyData() {
    const symbols = ['BTC/USDT', 'ETH/USDT'];
    const timeframe = '1h';
    
    for (const symbol of symbols) {
        const row = db.prepare(`SELECT count(*) as count, min(timestamp) as min_ts, max(timestamp) as max_ts FROM candles WHERE symbol = ? AND timeframe = ?`).get(symbol, timeframe) as any;
        console.log(`Verification for ${symbol} (${timeframe}):`);
        console.log(`- Total records: ${row.count}`);
        if (row.count > 0) {
            console.log(`- Date range: ${new Date(row.min_ts).toISOString()} to ${new Date(row.max_ts).toISOString()}`);
            
            // Check for missing timestamps (assuming 1h = 3600000ms)
            const expectedCount = Math.floor((row.max_ts - row.min_ts) / 3600000) + 1;
            console.log(`- Expected records (contiguous): ${expectedCount}`);
            console.log(`- Missing records: ${expectedCount - row.count}`);
        }
    }
}

async function main() {
    // 6 months ago
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const since = sixMonthsAgo.getTime();
    
    const symbols = ['BTC/USDT', 'ETH/USDT'];
    const timeframe = '1h';
    
    for (const symbol of symbols) {
        await fetchHistory(symbol, timeframe, since);
    }
    
    console.log('--- Verification ---');
    await verifyData();
}

main().catch(console.error);
