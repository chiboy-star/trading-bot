import Database from 'better-sqlite3';
import path from 'path';
import { EMA, RSI, ADX, ATR } from 'technicalindicators';

const dbPath = path.resolve(__dirname, 'data/market_data.db');
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

interface TestOptions {
    entryMode: 'crossover' | 'trend' | 'pullback_rsi' | 'crossover_relaxed';
    exitExecution: 'next_open' | 'stop_price';
    trailingStopMode: 'close' | 'intrabar';
    atrMult: number;
}

function runStrategy(symbol: string, fastPeriod: number, slowPeriod: number, opts: TestOptions) {
    const candles = db.prepare(`
        SELECT timestamp, open, high, low, close, volume 
        FROM candles 
        WHERE symbol = ? AND timeframe = '1h' 
        ORDER BY timestamp ASC
    `).all(symbol) as Candle[];

    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);

    const emaFastAll = EMA.calculate({ period: fastPeriod, values: closes });
    const emaSlowAll = EMA.calculate({ period: slowPeriod, values: closes });
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
    let entryPrice = 0;
    let trailingStop = 0;
    let highestSinceEntry = 0;
    let maxEquity = INITIAL_BALANCE;
    let maxDrawdown = 0;

    let trades: { pnl: number, pnlPercent: number, win: boolean, reason: string }[] = [];

    const startIndex = Math.max(slowPeriod, 50, adxOffset, atrOffset);

    for (let i = startIndex; i < candles.length - 1; i++) {
        const candle = candles[i];
        const nextCandle = candles[i + 1];

        const fastCurr = emaFastAll[i - emaFastOffset];
        const fastPrev = emaFastAll[i - 1 - emaFastOffset];
        const slowCurr = emaSlowAll[i - emaSlowOffset];
        const slowPrev = emaSlowAll[i - 1 - emaSlowOffset];
        const rsiCurr = rsiAll[i - rsiOffset];
        const rsiPrev = rsiAll[i - 1 - rsiOffset];
        const adxCurr = adxAll[i - adxOffset]?.adx;
        const atrCurr = atrAll[i - atrOffset];

        let equity = balance;
        if (inPosition) {
            equity = cryptoAmount * candle.close;
        }
        if (equity > maxEquity) maxEquity = equity;
        const dd = (maxEquity - equity) / maxEquity;
        if (dd > maxDrawdown) maxDrawdown = dd;

        if (!inPosition) {
            let buySignal = false;

            if (opts.entryMode === 'crossover') {
                const crossedAbove = fastPrev <= slowPrev && fastCurr > slowCurr;
                const rsiValid = rsiCurr >= 40 && rsiCurr <= 65;
                const adxValid = adxCurr > 25;
                buySignal = crossedAbove && rsiValid && adxValid;
            } else if (opts.entryMode === 'trend') {
                const emaTrend = fastCurr > slowCurr;
                const rsiValid = rsiCurr >= 40 && rsiCurr <= 65;
                const adxValid = adxCurr > 25;
                buySignal = emaTrend && rsiValid && adxValid;
            } else if (opts.entryMode === 'pullback_rsi') {
                // EMA trend + ADX > 25 + RSI bouncing up into 40-65 or crossing 40/50
                const emaTrend = fastCurr > slowCurr;
                const rsiCross = (rsiPrev < 40 && rsiCurr >= 40) || (rsiPrev < 50 && rsiCurr >= 50);
                const adxValid = adxCurr > 25;
                buySignal = emaTrend && rsiCross && adxValid;
            }

            if (buySignal) {
                const execPrice = nextCandle.open * (1 + SLIPPAGE);
                cryptoAmount = (balance * (1 - TAKER_FEE)) / execPrice;
                entryBalance = balance;
                entryPrice = execPrice;
                balance = 0;
                inPosition = true;
                highestSinceEntry = nextCandle.open;
                trailingStop = nextCandle.open - (opts.atrMult * atrCurr);
            }
        } else {
            // Update trailing stop based on current candle
            highestSinceEntry = Math.max(highestSinceEntry, candle.high);
            const proposedStop = highestSinceEntry - (opts.atrMult * atrCurr);
            if (proposedStop > trailingStop) {
                trailingStop = proposedStop;
            }

            const crossedBelow = fastPrev >= slowPrev && fastCurr < slowCurr;
            let stopHit = false;

            if (opts.trailingStopMode === 'intrabar') {
                if (candle.low <= trailingStop) {
                    stopHit = true;
                }
            } else {
                if (candle.close <= trailingStop) {
                    stopHit = true;
                }
            }

            if (crossedBelow || stopHit) {
                let exitPrice: number;
                if (stopHit && opts.exitExecution === 'stop_price') {
                    // Executed at stop price with slippage
                    exitPrice = trailingStop * (1 - SLIPPAGE);
                } else {
                    // Executed on next candle open
                    exitPrice = nextCandle.open * (1 - SLIPPAGE);
                }

                const gross = cryptoAmount * exitPrice;
                balance = gross * (1 - TAKER_FEE);
                const pnl = balance - entryBalance;
                const pnlPercent = (pnl / entryBalance) * 100;
                trades.push({
                    pnl,
                    pnlPercent,
                    win: pnl > 0,
                    reason: crossedBelow ? 'EMA_CROSS' : 'TRAILING_STOP'
                });
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
        const pnl = balance - entryBalance;
        trades.push({
            pnl,
            pnlPercent: (pnl / entryBalance) * 100,
            win: pnl > 0,
            reason: 'END_OF_DATA'
        });
    }

    const totalTrades = trades.length;
    const wins = trades.filter(t => t.win).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = trades.filter(t => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
    const netPnl = balance - INITIAL_BALANCE;

    return {
        totalTrades,
        winRate,
        netPnl,
        profitFactor,
        maxDrawdown: maxDrawdown * 100,
        trades
    };
}

const variations = [
    { fast: 9, slow: 21, name: '9/21 (Fast)' },
    { fast: 20, slow: 50, name: '20/50 (Medium)' },
    { fast: 50, slow: 200, name: '50/200 (Macro)' },
];

console.log("=== CROSSOVER ENTRY, NEXT_OPEN EXIT, CLOSE TSL ===");
for (const v of variations) {
    for (const sym of ['BTC/USDT', 'ETH/USDT']) {
        const r = runStrategy(sym, v.fast, v.slow, {
            entryMode: 'crossover',
            exitExecution: 'next_open',
            trailingStopMode: 'close',
            atrMult: 1.5
        });
        console.log(`${sym.padEnd(8)} | ${v.name.padEnd(14)} | Trades: ${String(r.totalTrades).padStart(2)} | Win: ${r.winRate.toFixed(1).padStart(5)}% | PnL: $${r.netPnl.toFixed(2).padStart(8)} | PF: ${r.profitFactor.toFixed(2).padStart(5)} | DD: ${r.maxDrawdown.toFixed(1).padStart(5)}%`);
    }
}

console.log("\n=== CROSSOVER ENTRY, STOP_PRICE EXIT, INTRABAR TSL ===");
for (const v of variations) {
    for (const sym of ['BTC/USDT', 'ETH/USDT']) {
        const r = runStrategy(sym, v.fast, v.slow, {
            entryMode: 'crossover',
            exitExecution: 'stop_price',
            trailingStopMode: 'intrabar',
            atrMult: 1.5
        });
        console.log(`${sym.padEnd(8)} | ${v.name.padEnd(14)} | Trades: ${String(r.totalTrades).padStart(2)} | Win: ${r.winRate.toFixed(1).padStart(5)}% | PnL: $${r.netPnl.toFixed(2).padStart(8)} | PF: ${r.profitFactor.toFixed(2).padStart(5)} | DD: ${r.maxDrawdown.toFixed(1).padStart(5)}%`);
    }
}
