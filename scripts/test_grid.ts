import Database from 'better-sqlite3';
import path from 'path';
import { EMA, RSI, ADX, ATR } from 'technicalindicators';

const dbPath = path.resolve(__dirname, '../data/market_data.db');
const db = new Database(dbPath, { readonly: true });

interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

const INITIAL_BALANCE = 10000;
const TAKER_FEE = 0.00075;
const SLIPPAGE = 0.0005;

interface TestConfig {
    fastPeriod: number;
    slowPeriod: number;
    entryMode: 'crossover' | 'trend';
    trailingStopMode: 'close' | 'intrabar';
    atrMultiplier: number;
}

function runSim(symbol: string, config: TestConfig) {
    const candles = db.prepare(`
        SELECT timestamp, open, high, low, close, volume 
        FROM candles 
        WHERE symbol = ? AND timeframe = '1h' 
        ORDER BY timestamp ASC
    `).all(symbol) as Candle[];

    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);

    const minPeriod = Math.max(config.slowPeriod, 50);

    const emaFastAll = EMA.calculate({ period: config.fastPeriod, values: closes });
    const emaSlowAll = EMA.calculate({ period: config.slowPeriod, values: closes });
    const rsiAll = RSI.calculate({ period: 14, values: closes });
    const adxAll = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    const atrAll = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

    const emaFastOffset = candles.length - emaFastAll.length;
    const emaSlowOffset = candles.length - emaSlowAll.length;
    const rsiOffset = candles.length - rsiAll.length;
    const adxOffset = candles.length - adxAll.length;
    const atrOffset = candles.length - atrAll.length;

    let balance = INITIAL_BALANCE;
    let cryptoAmount = 0;
    let inPosition = false;
    let entryBalance = 0;
    let trailingStop = 0;
    let highestSinceEntry = 0;
    let maxEquity = INITIAL_BALANCE;
    let maxDrawdown = 0;

    let trades: { pnl: number }[] = [];

    const startIndex = Math.max(minPeriod, 50, adxOffset, atrOffset);

    for (let i = startIndex; i < candles.length - 1; i++) {
        const candle = candles[i];
        const nextCandle = candles[i + 1];

        const fastCurr = emaFastAll[i - emaFastOffset];
        const fastPrev = emaFastAll[i - 1 - emaFastOffset];
        const slowCurr = emaSlowAll[i - emaSlowOffset];
        const slowPrev = emaSlowAll[i - 1 - emaSlowOffset];
        const rsiCurr = rsiAll[i - rsiOffset];
        const adxCurr = adxAll[i - adxOffset]?.adx;
        const atrCurr = atrAll[i - atrOffset];

        // Drawdown
        let equity = balance;
        if (inPosition) {
            equity = cryptoAmount * candle.close;
        }
        if (equity > maxEquity) maxEquity = equity;
        const dd = (maxEquity - equity) / maxEquity;
        if (dd > maxDrawdown) maxDrawdown = dd;

        if (!inPosition) {
            const emaBullish = config.entryMode === 'crossover' 
                ? (fastPrev <= slowPrev && fastCurr > slowCurr)
                : (fastCurr > slowCurr);
            const rsiOk = rsiCurr >= 40 && rsiCurr <= 65;
            const adxOk = adxCurr > 25;

            if (emaBullish && rsiOk && adxOk) {
                // Buy on next open
                const execPrice = nextCandle.open * (1 + SLIPPAGE);
                cryptoAmount = (balance * (1 - TAKER_FEE)) / execPrice;
                entryBalance = balance;
                balance = 0;
                inPosition = true;
                highestSinceEntry = nextCandle.open;
                trailingStop = nextCandle.open - config.atrMultiplier * atrCurr;
            }
        } else {
            // Update trailing stop based on candle i
            highestSinceEntry = Math.max(highestSinceEntry, candle.high);
            const newStop = highestSinceEntry - config.atrMultiplier * atrCurr;
            if (newStop > trailingStop) {
                trailingStop = newStop;
            }

            const emaBearish = (fastPrev >= slowPrev && fastCurr < slowCurr);
            let stopHit = false;

            if (config.trailingStopMode === 'intrabar') {
                if (candle.low <= trailingStop) {
                    stopHit = true;
                }
            } else {
                if (candle.close <= trailingStop) {
                    stopHit = true;
                }
            }

            if (emaBearish || stopHit) {
                // Exit on next open
                const execPrice = nextCandle.open * (1 - SLIPPAGE);
                const gross = cryptoAmount * execPrice;
                balance = gross * (1 - TAKER_FEE);
                trades.push({ pnl: balance - entryBalance });
                inPosition = false;
                cryptoAmount = 0;
            }
        }
    }

    if (inPosition) {
        const lastCandle = candles[candles.length - 1];
        const execPrice = lastCandle.close * (1 - SLIPPAGE);
        const gross = cryptoAmount * execPrice;
        balance = gross * (1 - TAKER_FEE);
        trades.push({ pnl: balance - entryBalance });
    }

    const totalTrades = trades.length;
    const wins = trades.filter(t => t.pnl > 0).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const grossProfit = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    const netPnl = balance - INITIAL_BALANCE;

    return {
        symbol,
        fastPeriod: config.fastPeriod,
        slowPeriod: config.slowPeriod,
        totalTrades,
        winRate,
        netPnl,
        profitFactor: pf,
        maxDrawdown: maxDrawdown * 100
    };
}

const variations = [
    { fast: 9, slow: 21, name: '9 / 21 (Fast)' },
    { fast: 20, slow: 50, name: '20 / 50 (Medium)' },
    { fast: 50, slow: 200, name: '50 / 200 (Macro)' },
];

for (const entryMode of ['crossover', 'trend'] as const) {
    for (const trailingStopMode of ['close', 'intrabar'] as const) {
        console.log(`\n=== Entry: ${entryMode}, TrailingStopMode: ${trailingStopMode} ===`);
        for (const v of variations) {
            for (const sym of ['BTC/USDT', 'ETH/USDT']) {
                const res = runSim(sym, {
                    fastPeriod: v.fast,
                    slowPeriod: v.slow,
                    entryMode,
                    trailingStopMode,
                    atrMultiplier: 1.5
                });
                console.log(`${sym} | ${v.name.padEnd(16)} | Trades: ${res.totalTrades.toString().padStart(2)} | Win: ${res.winRate.toFixed(1).padStart(5)}% | PnL: $${res.netPnl.toFixed(2).padStart(8)} | PF: ${res.profitFactor.toFixed(2).padStart(5)} | DD: ${res.maxDrawdown.toFixed(1).padStart(5)}%`);
            }
        }
    }
}
