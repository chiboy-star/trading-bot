import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Dynamically locate market_data.db
function getDbPath(): string {
    const parentDb = path.join(process.cwd(), '..', 'data', 'market_data.db');
    if (fs.existsSync(parentDb)) {
        return parentDb;
    }
    return path.join(process.cwd(), 'data', 'market_data.db');
}

let dbInstance: any = null;

export function getDatabase(): any {
    if (!dbInstance) {
        const dbPath = getDbPath();
        dbInstance = new Database(dbPath, { readonly: true });
        
        // NOTE: Tables are created by the live_runner.ts process.
        // Dashboard opens read-only to avoid SQLite write-lock conflicts.
        // If the runner hasn't been started yet, queries will return empty results gracefully.

        // NOTE: Schema migrations are handled by live_runner.ts.
        // Dashboard is read-only, so we skip migrations here.
    }
    return dbInstance;
}

// -------------------------------------------------------------
// Pure, Bundler-Safe Quantitative Technical Indicator Algorithms
// -------------------------------------------------------------

function calcEMA(period: number, values: number[]): number[] {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const result: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    let prev = sum / period;
    result.push(prev);
    for (let i = period; i < values.length; i++) {
        const cur = values[i] * k + prev * (1 - k);
        result.push(cur);
        prev = cur;
    }
    return result;
}

function calcRSI(period: number, values: number[]): number[] {
    if (values.length <= period) return [];
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = values[i] - values[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
    }
    let avgG = gains / period;
    let avgL = losses / period;
    const result: number[] = [];
    result.push(avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL)));
    for (let i = period + 1; i < values.length; i++) {
        const diff = values[i] - values[i - 1];
        avgG = (avgG * (period - 1) + (diff > 0 ? diff : 0)) / period;
        avgL = (avgL * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
        result.push(avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL)));
    }
    return result;
}

function calcADX(period: number, highs: number[], lows: number[], closes: number[]): { adx: number }[] {
    if (highs.length <= period * 2) return [];
    const trArr: number[] = [];
    const plusDmArr: number[] = [];
    const minusDmArr: number[] = [];

    for (let i = 1; i < highs.length; i++) {
        const h = highs[i], l = lows[i], prevH = highs[i - 1], prevL = lows[i - 1], prevC = closes[i - 1];
        const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
        const upMove = h - prevH;
        const downMove = prevL - l;
        const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
        const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
        trArr.push(tr);
        plusDmArr.push(plusDm);
        minusDmArr.push(minusDm);
    }

    let trSmooth = trArr.slice(0, period).reduce((a, b) => a + b, 0);
    let plusDmSmooth = plusDmArr.slice(0, period).reduce((a, b) => a + b, 0);
    let minusDmSmooth = minusDmArr.slice(0, period).reduce((a, b) => a + b, 0);

    const dxArr: number[] = [];
    const pDi = trSmooth > 0 ? (plusDmSmooth / trSmooth) * 100 : 0;
    const mDi = trSmooth > 0 ? (minusDmSmooth / trSmooth) * 100 : 0;
    const dSum = pDi + mDi;
    dxArr.push(dSum > 0 ? (Math.abs(pDi - mDi) / dSum) * 100 : 0);

    for (let i = period; i < trArr.length; i++) {
        trSmooth = trSmooth - (trSmooth / period) + trArr[i];
        plusDmSmooth = plusDmSmooth - (plusDmSmooth / period) + plusDmArr[i];
        minusDmSmooth = minusDmSmooth - (minusDmSmooth / period) + minusDmArr[i];
        const curPDi = trSmooth > 0 ? (plusDmSmooth / trSmooth) * 100 : 0;
        const curMDi = trSmooth > 0 ? (minusDmSmooth / trSmooth) * 100 : 0;
        const curDSum = curPDi + curMDi;
        dxArr.push(curDSum > 0 ? (Math.abs(curPDi - curMDi) / curDSum) * 100 : 0);
    }

    if (dxArr.length < period) return [];
    let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const result: { adx: number }[] = [{ adx }];
    for (let i = period; i < dxArr.length; i++) {
        adx = (adx * (period - 1) + dxArr[i]) / period;
        result.push({ adx });
    }
    return result;
}

// -------------------------------------------------------------
// Type Definitions
// -------------------------------------------------------------

export interface TradeRecord {
    id: number;
    orderId: string;
    symbol: string;
    side: string;
    type: string;
    price: number;
    amount: number;
    fee: number;
    pnl: number;
    pnlPercent: number;
    timestamp: number;
    dateStr: string;
    status: 'WIN' | 'LOSS' | 'ENTRY';
    direction: 'LONG' | 'SHORT';
    executionMode: 'LIVE_FORWARD' | 'BACKTEST_MOCK';
}

export interface ActivePositionRecord {
    symbol: string;
    side: 'LONG' | 'SHORT';
    amount: number;
    entryPrice: number;
    currentPrice: number;
    highestPrice: number;
    lowestPrice: number;
    trailingStop: number;
    stopDistance: number;
    stopDistancePercent: number;
    atr: number;
    pnl: number;
    pnlPercent: number;
    entryTime: number;
    holdingDuration: string;
}

export interface MetricsSummary {
    capital: number;
    initialCapital: number;
    netPnl: number;
    netPnlPercent: number;
    winRate: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    profitFactor: number;
    circuitBreakerHalted: boolean;
    lockoutUntil: number;
    activePositionsCount: number;
    longTradesCount: number;
    shortTradesCount: number;
}

export interface DiagnosticChecklistItem {
    name: string;
    value: string;
    passed: boolean;
    ruleDescription: string;
    badgeText: string;
}

export interface EngineReasoningItem {
    symbol: string;
    currentPrice: number;
    hasActivePosition: boolean;
    activeSide?: 'LONG' | 'SHORT';
    posture: 'CASH' | 'ACTIVE_LONG' | 'ACTIVE_SHORT' | 'LONG_TRIGGERED' | 'SHORT_TRIGGERED';
    summarySentence: string;
    trendFilter: {
        adx: number;
        passed: boolean;
        threshold: number;
        badge: string;
        details: string;
    };
    longMomentumFilter: {
        rsi: number;
        passed: boolean;
        rangeMin: number;
        rangeMax: number;
        badge: string;
        details: string;
    };
    shortMomentumFilter: {
        rsi: number;
        passed: boolean;
        rangeMin: number;
        rangeMax: number;
        badge: string;
        details: string;
    };
    triggerFilter: {
        ema20: number;
        ema50: number;
        longCrossover: boolean;
        shortCrossover: boolean;
        bullishAlignment: boolean;
        badge: string;
        details: string;
    };
    checklist: DiagnosticChecklistItem[];
}

export interface CandleDataPoint {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    ema20: number | null;
    ema50: number | null;
}

export interface DashboardData {
    metrics: MetricsSummary;
    activePositions: ActivePositionRecord[];
    tradeHistory: TradeRecord[];
    marketOverview: {
        symbol: string;
        latestClose: number;
        high24h: number;
        low24h: number;
        volume24h: number;
        lastUpdated: number;
    }[];
    engineReasoning: EngineReasoningItem[];
    chartData: Record<string, CandleDataPoint[]>;
    screenedPairs: { symbol: string; dailyAdx: number; volume24h: number; rank: number }[];
    lastUpdated: number;
}

// NOTE: Seed data was removed. The dashboard now displays only real trades
// generated by the live_runner.ts bot. If the database is empty, the
// dashboard will show an appropriate empty state.

/**
 * Calculates quantitative indicators and bidirectional plain-English engine reasoning posture.
 */
function computeSymbolReasoningAndChart(
    db: any,
    symbol: string,
    hasActivePos: boolean,
    activeSide?: 'LONG' | 'SHORT',
    activePosPnl?: number
): { reasoning: EngineReasoningItem; chartCandles: CandleDataPoint[] } {
    const rows = db.prepare(`
        SELECT open, high, low, close, volume, timestamp 
        FROM candles 
        WHERE symbol = ? 
        ORDER BY timestamp DESC 
        LIMIT 150
    `).all(symbol) as { open: number; high: number; low: number; close: number; volume: number; timestamp: number }[];

    if (!rows || rows.length < 30) {
        const fallbackPrice = rows && rows.length > 0 ? rows[0].close : 100;
        return {
            reasoning: {
                symbol,
                currentPrice: fallbackPrice,
                hasActivePosition: hasActivePos,
                activeSide,
                posture: 'CASH',
                summarySentence: `Sitting in cash: Insufficient candle history for ${symbol}. Warming up indicators.`,
                trendFilter: { adx: 0, passed: false, threshold: 25, badge: 'FAIL (<= 25)', details: 'Awaiting candle stream' },
                longMomentumFilter: { rsi: 50, passed: true, rangeMin: 40, rangeMax: 65, badge: 'PASS (40–65)', details: 'Neutral Long RSI' },
                shortMomentumFilter: { rsi: 50, passed: true, rangeMin: 35, rangeMax: 60, badge: 'PASS (35–60)', details: 'Neutral Short RSI' },
                triggerFilter: { ema20: fallbackPrice, ema50: fallbackPrice, longCrossover: false, shortCrossover: false, bullishAlignment: false, badge: 'NO CROSS', details: 'Awaiting cross' },
                checklist: []
            },
            chartCandles: []
        };
    }

    // Chronological order: oldest to newest
    const history = [...rows].reverse();
    const closes = history.map((c) => c.close);
    const highs = history.map((c) => c.high);
    const lows = history.map((c) => c.low);

    const ema20Arr = calcEMA(20, closes);
    const ema50Arr = calcEMA(50, closes);
    const rsi14Arr = calcRSI(14, closes);
    const adx14Arr = calcADX(14, highs, lows, closes);

    const curClose = closes[closes.length - 1];
    const curEma20 = ema20Arr.length > 0 ? ema20Arr[ema20Arr.length - 1] : curClose;
    const prevEma20 = ema20Arr.length > 1 ? ema20Arr[ema20Arr.length - 2] : curEma20;
    const curEma50 = ema50Arr.length > 0 ? ema50Arr[ema50Arr.length - 1] : curClose;
    const prevEma50 = ema50Arr.length > 1 ? ema50Arr[ema50Arr.length - 2] : curEma50;
    const curRsi = rsi14Arr.length > 0 ? rsi14Arr[rsi14Arr.length - 1] : 50;
    const curAdx = adx14Arr.length > 0 ? (adx14Arr[adx14Arr.length - 1]?.adx ?? 0) : 0;

    // Gate evaluations
    const adxPassed = curAdx > 25;
    const longRsiPassed = curRsi >= 40 && curRsi <= 65;
    const shortRsiPassed = curRsi >= 35 && curRsi <= 60;
    const longEmaCross = prevEma20 <= prevEma50 && curEma20 > curEma50;
    const shortEmaCross = prevEma20 >= prevEma50 && curEma20 < curEma50;
    const emaBullish = curEma20 > curEma50;

    const coinBase = symbol.split('/')[0].split(':')[0];
    const coinShortName = coinBase === 'BTC' ? 'Bitcoin' : coinBase === 'ETH' ? 'Ethereum' : coinBase === 'SOL' ? 'Solana' : coinBase;

    let posture: 'CASH' | 'ACTIVE_LONG' | 'ACTIVE_SHORT' | 'LONG_TRIGGERED' | 'SHORT_TRIGGERED' = 'CASH';
    let summarySentence = '';

    if (hasActivePos) {
        const pnlStr = (activePosPnl ?? 0) >= 0 ? `+₦${Math.abs(activePosPnl ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : `-₦${Math.abs(activePosPnl ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
        if (activeSide === 'SHORT') {
            posture = 'ACTIVE_SHORT';
            summarySentence = `Active Short: ${coinShortName} is in a short perpetual position (${pnlStr}). Dynamic 1.5x ATR trailing stop is ratcheting down to guard downside profits.`;
        } else {
            posture = 'ACTIVE_LONG';
            summarySentence = `Active Long: ${coinShortName} is trending in an open position (${pnlStr}). Dynamic 1.5x ATR trailing stop is ratcheting up to guard accumulated gains.`;
        }
    } else if (adxPassed && longRsiPassed && longEmaCross) {
        posture = 'LONG_TRIGGERED';
        summarySentence = `Long Entry Signal Triggered: ${coinShortName} confirmed a bullish 20/50 EMA crossover with strong trend (ADX ${curAdx.toFixed(1)}) and balanced momentum (RSI ${curRsi.toFixed(1)}).`;
    } else if (adxPassed && shortRsiPassed && shortEmaCross) {
        posture = 'SHORT_TRIGGERED';
        summarySentence = `Short Entry Signal Triggered: ${coinShortName} confirmed a bearish 20/50 EMA death cross with strong trend (ADX ${curAdx.toFixed(1)}) and safe short momentum (RSI ${curRsi.toFixed(1)}).`;
    } else {
        posture = 'CASH';
        if (adxPassed && emaBullish && !longEmaCross) {
            summarySentence = `Sitting in cash: ${coinShortName} is trending strongly, but waiting for a fresh crossover entry.`;
        } else if (adxPassed && !emaBullish && !shortEmaCross) {
            summarySentence = `Sitting in cash: ${coinShortName} is trending strongly downward (ADX ${curAdx.toFixed(1)}), but waiting for a fresh bearish crossover entry.`;
        } else if (!adxPassed && emaBullish) {
            summarySentence = `Sitting in cash: ${coinShortName} shows positive EMA alignment, but trend strength is too weak (ADX ${curAdx.toFixed(1)} <= 25). Avoiding chop.`;
        } else if (!adxPassed && !emaBullish) {
            summarySentence = `Sitting in cash: ${coinShortName} is rangebound below 50 EMA with weak trend (ADX ${curAdx.toFixed(1)} <= 25). Preserving capital.`;
        } else {
            summarySentence = `Sitting in cash: ${coinShortName} regime criteria not met. Preserving capital until ADX > 25 and fresh crossover align.`;
        }
    }

    const checklist: DiagnosticChecklistItem[] = [
        {
            name: 'Trend Strength (ADX)',
            value: `ADX ${curAdx.toFixed(1)}`,
            passed: adxPassed,
            ruleDescription: 'Threshold > 25 validates strong directional momentum for both Long & Short',
            badgeText: adxPassed ? 'PASS (> 25)' : 'FAIL (<= 25)'
        },
        {
            name: 'Long Momentum (RSI 40–65)',
            value: `RSI ${curRsi.toFixed(1)}`,
            passed: longRsiPassed,
            ruleDescription: 'Optimal envelope for long entries without buying overextended tops',
            badgeText: longRsiPassed ? 'PASS (40–65)' : 'FAIL'
        },
        {
            name: 'Short Momentum (RSI 35–60)',
            value: `RSI ${curRsi.toFixed(1)}`,
            passed: shortRsiPassed,
            ruleDescription: 'Optimal envelope for short entries without shorting oversold bottoms',
            badgeText: shortRsiPassed ? 'PASS (35–60)' : 'FAIL'
        },
        {
            name: 'Crossover Trigger',
            value: longEmaCross ? 'Bullish Cross (20 > 50 EMA)' : (shortEmaCross ? 'Bearish Cross (20 < 50 EMA)' : (emaBullish ? '20 > 50 EMA (Ongoing Long)' : '20 < 50 EMA (Ongoing Short)')),
            passed: longEmaCross || shortEmaCross || (hasActivePos && (activeSide === 'LONG' ? emaBullish : !emaBullish)),
            ruleDescription: 'Requires fresh crossover on 1h closed candle',
            badgeText: longEmaCross ? 'LONG CROSS' : (shortEmaCross ? 'SHORT CROSS' : 'NO CROSS')
        }
    ];

    // Compute chart candles (last 100 hourly candles)
    const ema20Offset = history.length - ema20Arr.length;
    const ema50Offset = history.length - ema50Arr.length;
    const startIndex = Math.max(0, history.length - 100);

    const chartCandles: CandleDataPoint[] = history.slice(startIndex).map((c, i) => {
        const globalIdx = startIndex + i;
        const e20Idx = globalIdx - ema20Offset;
        const e50Idx = globalIdx - ema50Offset;
        return {
            time: Math.floor(c.timestamp / 1000),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            ema20: e20Idx >= 0 ? ema20Arr[e20Idx] : null,
            ema50: e50Idx >= 0 ? ema50Arr[e50Idx] : null
        };
    });

    return {
        reasoning: {
            symbol,
            currentPrice: curClose,
            hasActivePosition: hasActivePos,
            activeSide,
            posture,
            summarySentence,
            trendFilter: {
                adx: Number(curAdx.toFixed(1)),
                passed: adxPassed,
                threshold: 25,
                badge: adxPassed ? 'PASS (> 25)' : 'FAIL (<= 25)',
                details: adxPassed ? `Strong trend validated (ADX ${curAdx.toFixed(1)} > 25)` : `Rangebound chop detected (ADX ${curAdx.toFixed(1)} <= 25)`
            },
            longMomentumFilter: {
                rsi: Number(curRsi.toFixed(1)),
                passed: longRsiPassed,
                rangeMin: 40,
                rangeMax: 65,
                badge: longRsiPassed ? 'PASS (40–65)' : 'FAIL (Outside 40–65)',
                details: longRsiPassed ? `Valid Long RSI (${curRsi.toFixed(1)})` : `Outside Long RSI envelope (${curRsi.toFixed(1)})`
            },
            shortMomentumFilter: {
                rsi: Number(curRsi.toFixed(1)),
                passed: shortRsiPassed,
                rangeMin: 35,
                rangeMax: 60,
                badge: shortRsiPassed ? 'PASS (35–60)' : 'FAIL (Outside 35–60)',
                details: shortRsiPassed ? `Valid Short RSI (${curRsi.toFixed(1)})` : `Outside Short RSI envelope (${curRsi.toFixed(1)})`
            },
            triggerFilter: {
                ema20: Number(curEma20.toFixed(2)),
                ema50: Number(curEma50.toFixed(2)),
                longCrossover: longEmaCross,
                shortCrossover: shortEmaCross,
                bullishAlignment: emaBullish,
                badge: longEmaCross ? 'LONG CROSS' : (shortEmaCross ? 'SHORT CROSS' : 'NO CROSS'),
                details: longEmaCross
                    ? `Fresh Golden Cross confirmed: 20 EMA crossed above 50 EMA`
                    : (shortEmaCross
                        ? `Fresh Death Cross confirmed: 20 EMA crossed below 50 EMA`
                        : `No cross: 20 EMA is ${emaBullish ? 'above' : 'below'} 50 EMA ($${curEma20.toFixed(2)} vs $${curEma50.toFixed(2)})`)
            },
            checklist
        },
        chartCandles
    };
}

/**
 * Retrieves all dashboard data from SQLite database with bidirectional support.
 */
export function fetchDashboardData(): DashboardData {
    const db = getDatabase();

    // 1. Bot State & Capital
    const stateRow = db.prepare('SELECT * FROM bot_state WHERE id = 1').get() as any;
    const initialCapital = stateRow ? Number(stateRow.initial_capital) : 10000;
    const currentCapital = stateRow ? Number(stateRow.capital) : 10000;
    const circuitBreakerHalted = stateRow ? Boolean(stateRow.circuit_breaker_halted) || (Date.now() < Number(stateRow.lockout_until)) : false;
    const lockoutUntil = stateRow ? Number(stateRow.lockout_until) : 0;

    // 2. Active Positions
    const activePositionsRows = db.prepare('SELECT * FROM active_positions ORDER BY updated_at DESC').all() as any[];
    const activePositionsMap = new Map<string, ActivePositionRecord>();

    const activePositions: ActivePositionRecord[] = activePositionsRows.map((row) => {
        const curPrice = Number(row.current_price);
        const stopPrice = Number(row.trailing_stop);
        const side: 'LONG' | 'SHORT' = row.side === 'SHORT' ? 'SHORT' : 'LONG';
        const stopDist = side === 'LONG' ? Math.max(0, curPrice - stopPrice) : Math.max(0, stopPrice - curPrice);
        const stopDistPct = curPrice > 0 ? (stopDist / curPrice) * 100 : 0;

        const durationMs = Date.now() - Number(row.entry_time);
        const hours = Math.floor(durationMs / (1000 * 60 * 60));
        const mins = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
        const durationStr = `${hours}h ${mins}m`;

        const record: ActivePositionRecord = {
            symbol: row.symbol,
            side,
            amount: Number(row.amount),
            entryPrice: Number(row.entry_price),
            currentPrice: curPrice,
            highestPrice: Number(row.highest_price),
            lowestPrice: Number(row.lowest_price || row.entry_price),
            trailingStop: stopPrice,
            stopDistance: stopDist,
            stopDistancePercent: stopDistPct,
            atr: Number(row.atr),
            pnl: Number(row.pnl),
            pnlPercent: Number(row.pnl_percent),
            entryTime: Number(row.entry_time),
            holdingDuration: durationStr
        };

        activePositionsMap.set(row.symbol, record);
        return record;
    });

    // 3. Trade History
    const tradeRows = db.prepare(`
        SELECT * FROM paper_trades 
        ORDER BY timestamp DESC, id DESC
    `).all() as any[];

    let longTradesCount = 0;
    let shortTradesCount = 0;

    const tradeHistory: TradeRecord[] = tradeRows.map((t) => {
        const pnl = Number(t.pnl || 0);
        const direction: 'LONG' | 'SHORT' = t.direction === 'SHORT' ? 'SHORT' : 'LONG';
        if (direction === 'SHORT') shortTradesCount++;
        else longTradesCount++;

        let status: 'WIN' | 'LOSS' | 'ENTRY' = 'ENTRY';
        // For Long, exit is SELL. For Short, exit is BUY.
        if (t.type !== 'ENTRY') {
            status = pnl > 0 ? 'WIN' : 'LOSS';
        }

        return {
            id: Number(t.id),
            orderId: t.order_id,
            symbol: t.symbol,
            side: t.side,
            type: t.type,
            price: Number(t.price),
            amount: Number(t.amount),
            fee: Number(t.fee),
            pnl: pnl,
            pnlPercent: Number(t.pnl_percent || 0),
            timestamp: Number(t.timestamp),
            dateStr: new Date(Number(t.timestamp)).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            }),
            status,
            direction,
            executionMode: (t.execution_mode === 'BACKTEST_MOCK' ? 'BACKTEST_MOCK' : 'LIVE_FORWARD') as 'LIVE_FORWARD' | 'BACKTEST_MOCK'
        };
    });

    // 4. Performance Metrics
    const closedTrades = tradeHistory.filter((t) => t.type !== 'ENTRY');
    const totalTrades = closedTrades.length;
    const winningTrades = closedTrades.filter((t) => t.pnl > 0).length;
    const losingTrades = closedTrades.filter((t) => t.pnl <= 0).length;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

    let grossProfit = 0;
    let grossLoss = 0;
    let cumulativePnl = 0;

    for (const t of closedTrades) {
        cumulativePnl += t.pnl;
        if (t.pnl > 0) grossProfit += t.pnl;
        else grossLoss += Math.abs(t.pnl);
    }

    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    const netPnlPercent = initialCapital > 0 ? (cumulativePnl / initialCapital) * 100 : 0;

    // 5. Monitored & Screened Pairs
    let screenedPairs: { symbol: string; dailyAdx: number; volume24h: number; rank: number }[] = [];
    try {
        const rows = db.prepare('SELECT symbol, daily_adx, volume_24h, rank FROM monitored_pairs ORDER BY rank ASC').all() as any[];
        if (rows && rows.length > 0) {
            screenedPairs = rows.map(r => ({
                symbol: r.symbol,
                dailyAdx: Number(r.daily_adx),
                volume24h: Number(r.volume_24h),
                rank: Number(r.rank)
            }));
        }
    } catch (e) {}

    // Combine core symbols and screened symbols
    const pairSet = new Set(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    screenedPairs.forEach(p => pairSet.add(p.symbol));
    activePositions.forEach(p => pairSet.add(p.symbol));

    const monitored = Array.from(pairSet);
    const engineReasoning: EngineReasoningItem[] = [];
    const chartData: Record<string, CandleDataPoint[]> = {};

    const marketOverview = monitored.map((sym) => {
        const latest = db.prepare(`
            SELECT close, high, low, volume, timestamp 
            FROM candles 
            WHERE symbol = ? 
            ORDER BY timestamp DESC 
            LIMIT 1
        `).get(sym) as any;

        const hasActivePos = activePositionsMap.has(sym);
        const activePos = activePositionsMap.get(sym);

        const { reasoning, chartCandles } = computeSymbolReasoningAndChart(
            db,
            sym,
            hasActivePos,
            activePos?.side,
            activePos?.pnl
        );
        engineReasoning.push(reasoning);
        chartData[sym] = chartCandles;

        // Use actual 24-hour range across last 24 hourly candles
        const range24h = db.prepare(`
            SELECT 
                MAX(high) as high_24h,
                MIN(low) as low_24h,
                MAX(volume) as max_volume
            FROM candles 
            WHERE symbol = ? 
            ORDER BY timestamp DESC 
            LIMIT 24
        `).get(sym) as any;

        return {
            symbol: sym,
            latestClose: latest ? Number(latest.close) : reasoning.currentPrice,
            high24h: range24h ? Number(range24h.high_24h) : (latest ? Number(latest.high) : reasoning.currentPrice * 1.02),
            low24h: range24h ? Number(range24h.low_24h) : (latest ? Number(latest.low) : reasoning.currentPrice * 0.98),
            volume24h: latest ? Number(latest.volume) : 0,
            lastUpdated: latest ? Number(latest.timestamp) : Date.now()
        };
    });

    return {
        metrics: {
            capital: currentCapital,
            initialCapital,
            netPnl: cumulativePnl,
            netPnlPercent,
            winRate,
            totalTrades,
            winningTrades,
            losingTrades,
            profitFactor,
            circuitBreakerHalted,
            lockoutUntil,
            activePositionsCount: activePositions.length,
            longTradesCount,
            shortTradesCount
        },
        activePositions,
        tradeHistory,
        marketOverview,
        engineReasoning,
        chartData,
        screenedPairs,
        lastUpdated: Date.now()
    };
}
