import { processTick } from '../src/live_runner';
import Database from 'better-sqlite3';
import path from 'path';

// Clean DB for mock test
const dbPath = path.resolve(__dirname, '../data/market_data.db');
const db = new Database(dbPath);
db.exec('DELETE FROM paper_trades');
db.exec('DELETE FROM candles WHERE timestamp > 2000000000000'); // Clean mock candles

async function runMock() {
    console.log("Starting mock circuit breaker test...\n");

    const symbol = 'BTC/USDT';
    const timeframe = '1h';
    let baseTime = 2000000000000; // Future timestamp to avoid real data overlap
    const oneHour = 3600000;

    // 1. Build initial momentum for BUY signal
    // We need 20 EMA > 50 EMA and RSI between 40 and 65
    let currentPrice = 60000;
    
    // Feed 50 candles to initialize EMAs
    for (let i = 0; i < 50; i++) {
        currentPrice += 10;
        await processTick(symbol, timeframe, [baseTime, currentPrice, currentPrice + 100, currentPrice - 100, currentPrice, 1000], true);
        baseTime += oneHour;
    }

    // Trigger signal with a small jump
    currentPrice += 500;
    await processTick(symbol, timeframe, [baseTime, currentPrice, currentPrice + 100, currentPrice - 100, currentPrice, 1000], true);
    baseTime += oneHour;
    
    console.log("\n--- Simulating 3 consecutive losing trades to trigger circuit breaker ---\n");

    for (let trade = 1; trade <= 3; trade++) {
        // Assume we have an open position now. 
        // We will simulate a sharp drop triggering the 2% Stop-Loss.
        currentPrice = currentPrice * 0.95; // 5% drop
        
        await processTick(symbol, timeframe, [baseTime, currentPrice * 1.05, currentPrice * 1.05, currentPrice, currentPrice, 1000], false);
        
        // Wait, processTick needs isClosed=true to generate a NEW buy signal after loss.
        // Let's close the candle.
        await processTick(symbol, timeframe, [baseTime, currentPrice * 1.05, currentPrice * 1.05, currentPrice, currentPrice, 1000], true);
        baseTime += oneHour;
        
        // To get another BUY signal quickly, we need to manipulate prices up to trigger the EMA crossover again
        // Actually, just pushing price up heavily for 50 periods.
        for (let i = 0; i < 50; i++) {
            currentPrice += 150;
            await processTick(symbol, timeframe, [baseTime, currentPrice, currentPrice + 100, currentPrice - 100, currentPrice, 1000], true);
            baseTime += oneHour;
        }
        
        // Final jump to trigger BUY
        currentPrice += 1000;
        await processTick(symbol, timeframe, [baseTime, currentPrice, currentPrice + 100, currentPrice - 100, currentPrice, 1000], true);
        baseTime += oneHour;
    }
}

runMock().catch(console.error);
