import Database from 'better-sqlite3';
import { getCanonicalDbPath } from './db';
import { config as coreConfig } from './config';
import { StrategyEngine, CandleData, IndicatorSnapshot } from './strategy/core';

const dbPath = getCanonicalDbPath();
const db = new Database(dbPath, { readonly: true });

export interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface Trade {
    symbol: string;
    entryTime: number;
    exitTime: number;
    entryPrice: number;
    exitPrice: number;
    durationMs: number;
    pnl: number;
    pnlPercent: number;
    exitReason: 'EMA_CROSS' | 'TRAILING_STOP' | 'TAKE_PROFIT' | 'END_OF_DATA';
}

export interface StrategyConfig {
    fastPeriod: number;
    slowPeriod: number;
    name: string;
    rsiPeriod?: number;
    rsiMin?: number;
    rsiMax?: number;
    adxPeriod?: number;
    adxThreshold?: number;
    atrPeriod?: number;
    atrMultiplier?: number;
    trailingStopMode?: 'intrabar' | 'close';
    takeProfitRMultiplier?: number;
}

export interface BacktestResult {
    symbol: string;
    timeframe: string;
    variationName: string;
    fastPeriod: number;
    slowPeriod: number;
    initialBalance: number;
    finalBalance: number;
    netPnl: number;
    netPnlPercent: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    profitFactor: number;
    maxDrawdown: number;
    sharpeRatio: number;
    sortinoRatio: number;
    trades: Trade[];
}

const INITIAL_BALANCE = coreConfig.exchange.initialCapital;
const TAKER_FEE = coreConfig.exchange.takerFee;
const SLIPPAGE = coreConfig.exchange.slippage;

/**
 * Calculates Sharpe and Sortino ratios based on periodic returns.
 * Annualized for 1-hour crypto candles (8,760 hours/year).
 */
export function calculateRiskAdjustedMetrics(
    periodicReturns: number[],
    periodsPerYear: number = 8760
): { sharpeRatio: number; sortinoRatio: number } {
    if (periodicReturns.length < 2) {
        return { sharpeRatio: 0, sortinoRatio: 0 };
    }

    const n = periodicReturns.length;
    const mean = periodicReturns.reduce((sum, r) => sum + r, 0) / n;

    // Variance & Standard Deviation
    const variance = periodicReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (n - 1);
    const stdDev = Math.sqrt(Math.max(0, variance));

    // Downside deviation (returns < 0)
    const negativeReturns = periodicReturns.filter(r => r < 0);
    const downsideVariance = negativeReturns.length > 0
        ? negativeReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / negativeReturns.length
        : 0;
    const downsideDeviation = Math.sqrt(downsideVariance);

    const annualizationFactor = Math.sqrt(periodsPerYear);
    const sharpeRatio = stdDev > 0 ? (mean / stdDev) * annualizationFactor : 0;
    const sortinoRatio = downsideDeviation > 0 ? (mean / downsideDeviation) * annualizationFactor : (mean > 0 ? 99.99 : 0);

    return {
        sharpeRatio: Number(sharpeRatio.toFixed(2)),
        sortinoRatio: Number(sortinoRatio.toFixed(2)),
    };
}

/**
 * Runs a backtest for a specific symbol, timeframe, and strategy configuration consuming StrategyEngine.
 */
export function runBacktest(
    symbol: string,
    timeframe: string,
    config: StrategyConfig
): BacktestResult | null {
    const candles = db.prepare(`
        SELECT timestamp, open, high, low, close, volume 
        FROM candles 
        WHERE symbol = ? AND timeframe = ? 
        ORDER BY timestamp ASC
    `).all(symbol, timeframe) as Candle[];

    if (candles.length === 0) {
        console.log(`No data found for ${symbol} - ${timeframe}`);
        return null;
    }

    const candleData: CandleData[] = candles.map(c => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
    }));

    // Indicator parameters
    const fastPeriod = config.fastPeriod;
    const slowPeriod = config.slowPeriod;
    const rsiPeriod = config.rsiPeriod ?? 14;
    const rsiMin = config.rsiMin ?? 40;
    const rsiMax = config.rsiMax ?? 65;
    const adxPeriod = config.adxPeriod ?? 14;
    const adxThreshold = config.adxThreshold ?? 25;
    const atrPeriod = config.atrPeriod ?? 14;
    const atrMultiplier = config.atrMultiplier ?? 1.5;
    const trailingStopMode = config.trailingStopMode ?? 'intrabar';

    // Calculate indicators using StrategyEngine
    const indicators = StrategyEngine.calculateIndicators(candleData, {
        fastPeriod,
        slowPeriod,
        rsiPeriod,
        adxPeriod,
        atrPeriod,
    });

    // Alignment offsets against candles array
    const emaFastOffset = candles.length - indicators.emaFast.length;
    const emaSlowOffset = candles.length - indicators.emaSlow.length;
    const rsiOffset = candles.length - indicators.rsi.length;
    const adxOffset = candles.length - indicators.adx.length;
    const atrOffset = candles.length - indicators.atr.length;

    let balance = INITIAL_BALANCE;
    let cryptoAmount = 0;
    let inPosition = false;
    let entryTime = 0;
    let entryPriceRaw = 0;
    let entryBalance = 0;
    let highestSinceEntry = 0;
    let lowestSinceEntry = 0;
    let trailingStop = 0;

    let maxEquity = INITIAL_BALANCE;
    let maxDrawdown = 0;

    const trades: Trade[] = [];
    const equityCurve: number[] = [INITIAL_BALANCE];
    const hourlyReturns: number[] = [];

    // Ensure all indicators are sufficiently warmed up
    const startIndex = Math.max(config.slowPeriod, 50, adxOffset, atrOffset);

    for (let i = startIndex; i < candles.length - 1; i++) {
        const candle = candles[i];
        const nextCandle = candles[i + 1]; // Trade execution on next candle open to eliminate lookahead bias

        // Calculate current equity & update max drawdown
        let currentEquity = balance;
        if (inPosition) {
            currentEquity = cryptoAmount * candle.close;
        }
        if (currentEquity > maxEquity) maxEquity = currentEquity;
        const currentDrawdown = (maxEquity - currentEquity) / maxEquity;
        if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;

        // Track bar return for Sharpe & Sortino
        const prevEquity = equityCurve[equityCurve.length - 1];
        if (prevEquity > 0) {
            hourlyReturns.push((currentEquity - prevEquity) / prevEquity);
        }
        equityCurve.push(currentEquity);

        // Indicator snapshot at index i
        const currentFast = indicators.emaFast[i - emaFastOffset];
        const previousFast = indicators.emaFast[i - 1 - emaFastOffset];
        const currentSlow = indicators.emaSlow[i - emaSlowOffset];
        const previousSlow = indicators.emaSlow[i - 1 - emaSlowOffset];
        const currentRsi = indicators.rsi[i - rsiOffset];
        const currentAdx = indicators.adx[i - adxOffset]?.adx ?? 0;
        const previousAdx = indicators.adx[i - 1 - adxOffset]?.adx ?? currentAdx;
        const currentAtr = indicators.atr[i - atrOffset] ?? 0;

        const snapshot: IndicatorSnapshot = {
            currentEmaFast: currentFast,
            previousEmaFast: previousFast,
            currentEmaSlow: currentSlow,
            previousEmaSlow: previousSlow,
            currentRsi,
            currentAdx,
            previousAdx,
            currentAtr,
        };

        if (!inPosition) {
            // Entry Condition evaluated by StrategyEngine logic:
            // Fast EMA crosses above Slow EMA AND RSI in [rsiMin, rsiMax] AND ADX > adxThreshold
            const emaBullish = previousFast <= previousSlow && currentFast > currentSlow;
            const rsiValid = currentRsi >= rsiMin && currentRsi <= rsiMax;
            const adxValid = currentAdx > adxThreshold;

            if (emaBullish && rsiValid && adxValid) {
                // Execute BUY on next candle open with slippage and taker fee
                const executionPrice = nextCandle.open * (1 + SLIPPAGE);
                cryptoAmount = (balance * (1 - TAKER_FEE)) / executionPrice;
                entryBalance = balance;
                balance = 0;
                inPosition = true;
                entryTime = nextCandle.timestamp;
                entryPriceRaw = executionPrice;
                highestSinceEntry = nextCandle.open;
                lowestSinceEntry = nextCandle.open;
                trailingStop = nextCandle.open - (atrMultiplier * currentAtr);
            }
        } else {
            // Position exit evaluation consuming StrategyEngine.evaluateExit
            const exitEval = StrategyEngine.evaluateExit(
                {
                    symbol,
                    side: 'LONG',
                    amount: cryptoAmount,
                    entryPrice: entryPriceRaw,
                    currentPrice: candle.close,
                    highestPrice: highestSinceEntry,
                    lowestPrice: lowestSinceEntry,
                    trailingStop,
                    atr: currentAtr,
                    entryTime,
                },
                candle,
                snapshot,
                true,
                { atrMultiplier, trailingStopMode, slippage: SLIPPAGE }
            );

            highestSinceEntry = exitEval.newHighestPrice;
            trailingStop = exitEval.newTrailingStop;

            if (exitEval.shouldExit && exitEval.reason) {
                // Execute exit on next candle open
                const executionPrice = nextCandle.open * (1 - SLIPPAGE);
                const grossValue = cryptoAmount * executionPrice;
                balance = grossValue * (1 - TAKER_FEE);

                const pnl = balance - entryBalance;
                const pnlPercent = (pnl / entryBalance) * 100;

                trades.push({
                    symbol,
                    entryTime,
                    exitTime: nextCandle.timestamp,
                    entryPrice: entryPriceRaw,
                    exitPrice: executionPrice,
                    durationMs: nextCandle.timestamp - entryTime,
                    pnl,
                    pnlPercent,
                    exitReason: exitEval.reason === 'TRAILING_STOP' ? 'TRAILING_STOP' : 'EMA_CROSS'
                });

                inPosition = false;
                cryptoAmount = 0;
            }
        }
    }

    // Close any position remaining open at the end of the data
    if (inPosition) {
        const lastCandle = candles[candles.length - 1];
        const executionPrice = lastCandle.close * (1 - SLIPPAGE);
        const grossValue = cryptoAmount * executionPrice;
        balance = grossValue * (1 - TAKER_FEE);

        const pnl = balance - entryBalance;
        const pnlPercent = (pnl / entryBalance) * 100;

        trades.push({
            symbol,
            entryTime,
            exitTime: lastCandle.timestamp,
            entryPrice: entryPriceRaw,
            exitPrice: executionPrice,
            durationMs: lastCandle.timestamp - entryTime,
            pnl,
            pnlPercent,
            exitReason: 'END_OF_DATA'
        });
    }

    const totalTrades = trades.length;
    const winningTrades = trades.filter(t => t.pnl > 0).length;
    const losingTrades = trades.filter(t => t.pnl <= 0).length;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

    let grossProfit = 0;
    let grossLoss = 0;
    for (const t of trades) {
        if (t.pnl > 0) grossProfit += t.pnl;
        else grossLoss += Math.abs(t.pnl);
    }

    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    const netPnl = balance - INITIAL_BALANCE;
    const netPnlPercent = (netPnl / INITIAL_BALANCE) * 100;

    const { sharpeRatio, sortinoRatio } = calculateRiskAdjustedMetrics(hourlyReturns);

    return {
        symbol,
        timeframe,
        variationName: config.name,
        fastPeriod: config.fastPeriod,
        slowPeriod: config.slowPeriod,
        initialBalance: INITIAL_BALANCE,
        finalBalance: balance,
        netPnl,
        netPnlPercent,
        totalTrades,
        winningTrades,
        losingTrades,
        winRate,
        profitFactor,
        maxDrawdown: maxDrawdown * 100,
        sharpeRatio,
        sortinoRatio,
        trades
    };
}

export const EMA_VARIATIONS: StrategyConfig[] = [
    { fastPeriod: 9, slowPeriod: 21, name: '9 / 21 (Fast)', atrMultiplier: 1.5, adxThreshold: 25 },
    { fastPeriod: 20, slowPeriod: 50, name: '20 / 50 (Medium)', atrMultiplier: 1.5, adxThreshold: 25 },
    { fastPeriod: 50, slowPeriod: 200, name: '50 / 200 (Macro)', atrMultiplier: 1.5, adxThreshold: 25 },
];

function formatPnl(amount: number): string {
    const sign = amount >= 0 ? '+$' : '-$';
    return `${sign}${Math.abs(amount).toFixed(2)}`;
}

/**
 * Runs parameter grid search across variations and symbols, printing side-by-side markdown comparison table.
 */
export function runGridSearch() {
    const symbols = ['BTC/USDT', 'ETH/USDT'];
    const timeframe = '1h';

    console.log(`\n========================================================================================`);
    console.log(` QUANTITATIVE STRATEGY OPTIMIZATION: MARKET REGIME (ADX) & TRAILING STOP GRID SEARCH`);
    console.log(` Dataset: 6 Months (4,416 hourly candles) | Taker Fee: 0.075% | Slippage: 0.05%`);
    console.log(`========================================================================================\n`);

    const results: BacktestResult[] = [];

    for (const v of EMA_VARIATIONS) {
        for (const sym of symbols) {
            const res = runBacktest(sym, timeframe, v);
            if (res) results.push(res);
        }
    }

    console.log(`### Parameter Grid Search: Backtest Performance Comparison\n`);
    console.log(`| Symbol | EMA Variation | Trades | Win Rate (%) | Net PnL ($) | Return (%) | Max DD (%) | Profit Factor | Sharpe | Sortino | Status |`);
    console.log(`| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |`);

    for (const r of results) {
        const pfString = r.profitFactor === 999 ? 'N/A' : r.profitFactor.toFixed(2);
        const passed = r.profitFactor > 1.2;
        const status = passed ? '✅ PASS' : '❌ FAIL';
        const pnlStr = formatPnl(r.netPnl);
        const retStr = `${r.netPnlPercent >= 0 ? '+' : ''}${r.netPnlPercent.toFixed(2)}%`;

        console.log(
            `| **${r.symbol}** | ${r.variationName.padEnd(16)} | ${r.totalTrades.toString().padStart(6)} | ${r.winRate.toFixed(2).padStart(10)}% | ${pnlStr.padStart(13)} | ${retStr.padStart(10)} | ${r.maxDrawdown.toFixed(2).padStart(8)}% | ${pfString.padStart(12)} | ${r.sharpeRatio.toFixed(2).padStart(6)} | ${r.sortinoRatio.toFixed(2).padStart(7)} | ${status} |`
        );
    }

    console.log(`\n`);
    return results;
}

if (require.main === module) {
    runGridSearch();
}
