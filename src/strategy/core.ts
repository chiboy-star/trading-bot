import { EMA, RSI, ADX, ATR } from 'technicalindicators';
import Database from 'better-sqlite3';
import config from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('strategy-core');

export interface CandleData {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface StrategyIndicators {
    emaFast: number[];
    emaSlow: number[];
    rsi: number[];
    adx: { adx: number }[];
    atr: number[];
}

export type SetupType = 'TREND_PULLBACK' | 'EMA_CROSSOVER' | 'EXTREME_RSI_REVERSAL' | 'VOLATILITY_BREAKOUT';

export interface IndicatorSnapshot {
    currentEmaFast: number;
    previousEmaFast: number;
    currentEmaSlow: number;
    previousEmaSlow: number;
    currentRsi: number;
    currentAdx: number;
    previousAdx: number;
    currentAtr: number;
}

export type SignalType = 'BUY' | 'SELL' | 'HOLD';
export type TradeDirection = 'LONG' | 'SHORT';

export interface NearMissInfo {
    playbook: SetupType;
    direction: TradeDirection;
    rejectedFilter: string;
    filterValue: number;
    filterThreshold: number;
    entryPrice: number;
    atr: number;
    readinessPct: number;
    message: string;
}

export interface SignalEvaluation {
    signal: SignalType;
    direction: TradeDirection | null;
    isEntry: boolean;
    setupType?: SetupType | null;
    reason: string;
    indicators: IndicatorSnapshot;
    trendStatus: 'trending' | 'choppy';
    trendWord: 'upward' | 'downward';
    momentumWord: string;
    signalProximity: string;
    nearMiss?: NearMissInfo | null;
    recommendedRiskPct?: number;
    recommendedAtrMultiplier?: number;
    takeProfitPrice?: number;
}

export interface ActivePositionState {
    symbol: string;
    broker?: string;
    side: 'LONG' | 'SHORT';
    amount: number;
    entryPrice: number;
    currentPrice: number;
    highestPrice: number;
    lowestPrice: number;
    trailingStop: number;
    atr: number;
    takeProfitPrice?: number;
    entryTime: number;
    setupType?: SetupType;
}

export interface ExitEvaluation {
    shouldExit: boolean;
    reason: 'TRAILING_STOP' | 'EMA_CROSS' | 'TAKE_PROFIT' | null;
    executionPrice: number;
    newTrailingStop: number;
    newHighestPrice: number;
    newLowestPrice: number;
    stopRaisedOrLowered: boolean;
    details: string;
}

export interface PnlCalculation {
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    grossValueOrCost: number;
    fee: number;
    netRealizedPnl: number;
    netRealizedPnlPercent: number;
    fundingPnl?: number;
    slippageCost?: number;
}

export interface PositionSizingParams {
    capital: number;
    executionPrice: number;
    stopDistance: number;
    takerFee?: number;
    mode?: 'fixed' | 'kelly';
    maxRiskPct?: number;
    kellyFraction?: number;
    kellyWinRate?: number;
    kellyRewardRatio?: number;
    leverage?: number;
}

export interface PositionSizingResult {
    positionSize: number;
    riskAmount: number;
    totalCost: number;
    marginRequired?: number;
    notionalSize?: number;
    isAffordable: boolean;
    sizingMode: 'fixed' | 'kelly';
    rejectionReason?: string;
}

export interface AccountEquityCalculation {
    initialCapital: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalEquity: number;
    marginUsed: number;
    availableBuyingPower: number;
    leverage: number;
}

export interface CircuitBreakerStatus {
    isHalted: boolean;
    isLockedOut: boolean;
    totalLoss24h: number;
    lockoutUntil: number;
    lossThreshold: number;
    reason?: string;
}

export class StrategyEngine {
    /**
     * Calculates technical indicators across the entire candle series.
     */
    public static calculateIndicators(
        candles: CandleData[],
        params: {
            fastPeriod?: number;
            slowPeriod?: number;
            rsiPeriod?: number;
            adxPeriod?: number;
            atrPeriod?: number;
        } = {}
    ): StrategyIndicators {
        const fastPeriod = params.fastPeriod ?? config.strategy.fastEmaPeriod;
        const slowPeriod = params.slowPeriod ?? config.strategy.slowEmaPeriod;
        const rsiPeriod = params.rsiPeriod ?? config.strategy.rsiPeriod;
        const adxPeriod = params.adxPeriod ?? config.strategy.adxPeriod;
        const atrPeriod = params.atrPeriod ?? config.strategy.atrPeriod;

        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const closes = candles.map(c => c.close);

        const emaFast = EMA.calculate({ period: fastPeriod, values: closes });
        const emaSlow = EMA.calculate({ period: slowPeriod, values: closes });
        const rsi = RSI.calculate({ period: rsiPeriod, values: closes });
        const adx = ADX.calculate({ period: adxPeriod, high: highs, low: lows, close: closes });
        const atr = ATR.calculate({ period: atrPeriod, high: highs, low: lows, close: closes });

        return { emaFast, emaSlow, rsi, adx, atr };
    }

    /**
     * Extracts the latest snapshot of indicators for the most recent closed or active bar.
     */
    public static getLatestSnapshot(
        candles: CandleData[],
        indicators?: StrategyIndicators
    ): IndicatorSnapshot | null {
        const ind = indicators ?? this.calculateIndicators(candles);
        if (
            ind.emaFast.length < 2 ||
            ind.emaSlow.length < 2 ||
            ind.rsi.length < 1 ||
            ind.adx.length < 1 ||
            ind.atr.length < 1
        ) {
            return null;
        }

        const currentEmaFast = ind.emaFast[ind.emaFast.length - 1];
        const previousEmaFast = ind.emaFast[ind.emaFast.length - 2];
        const currentEmaSlow = ind.emaSlow[ind.emaSlow.length - 1];
        const previousEmaSlow = ind.emaSlow[ind.emaSlow.length - 2];
        const currentRsi = ind.rsi[ind.rsi.length - 1];
        const currentAdx = ind.adx[ind.adx.length - 1]?.adx ?? 0;
        const previousAdx = ind.adx.length >= 2 ? (ind.adx[ind.adx.length - 2]?.adx ?? currentAdx) : currentAdx;
        const currentAtr = ind.atr[ind.atr.length - 1] ?? 0;

        return {
            currentEmaFast,
            previousEmaFast,
            currentEmaSlow,
            previousEmaSlow,
            currentRsi,
            currentAdx,
            previousAdx,
            currentAtr,
        };
    }

    /**
     * Evaluates whether candle metrics trigger a LONG or SHORT entry signal across 3 active setups:
     * 1. EMA_CROSSOVER: Fast EMA crosses Slow EMA + ADX > 20 + RSI in momentum zone.
     * 2. TREND_PULLBACK: Established trend (EMA20 vs EMA50, ADX > 20) with price pullback to 20 EMA (within 0.3*ATR) closing back in trend direction.
     * 3. VOLATILITY_BREAKOUT: ADX > 22 and rising by >= 1.5 with 10-candle range breakout.
     */
    /**
     * Evaluates whether candle metrics trigger a LONG or SHORT entry signal across 3 active playbooks:
     * 1. Playbook A — TREND_PULLBACK:
     *    Short: EMA20 < EMA50, ADX >= 20, and strictly RSI in [45, 65] (ensuring price bounced up to EMA, not dumped away).
     *    Long:  EMA20 > EMA50, ADX >= 20, and strictly RSI in [35, 55] (ensuring price pulled back down to EMA, not overbought).
     * 2. Playbook B — EMA_CROSSOVER:
     *    EMA20 crossed EMA50 within last 2 candles, ADX >= 18, RSI 35-68.
     * 3. Playbook C — EXTREME_RSI_REVERSAL:
     *    Extreme exhaustion (RSI < 22 for Long bounce, RSI > 78 for Short fade) + reversal candle body.
     *    Mean-reversion scalp with half-size (1% risk), 1.2x ATR trailing stop and 2.0x ATR take-profit target.
     * Fallback: VOLATILITY_BREAKOUT.
     */
    public static evaluateEntry(
        candles: CandleData[],
        indicators?: StrategyIndicators,
        options: {
            isClosed?: boolean;
            allowShorts?: boolean;
            allowIntrabar?: boolean;
            isExploreMode?: boolean;
        } = {}
    ): SignalEvaluation {
        const { isClosed = true, allowShorts = true, allowIntrabar = false, isExploreMode = false } = options;
        const ind = indicators ?? this.calculateIndicators(candles);
        const snapshot = this.getLatestSnapshot(candles, ind);

        if (!snapshot || candles.length < 15) {
            return {
                signal: 'HOLD',
                direction: null,
                isEntry: false,
                setupType: null,
                reason: 'Insufficient candle data to warm up indicators',
                indicators: {
                    currentEmaFast: 0,
                    previousEmaFast: 0,
                    currentEmaSlow: 0,
                    previousEmaSlow: 0,
                    currentRsi: 50,
                    currentAdx: 0,
                    previousAdx: 0,
                    currentAtr: 0,
                },
                trendStatus: 'choppy',
                trendWord: 'downward',
                momentumWord: 'insufficient data',
                signalProximity: 'Warming up indicators...',
            };
        }

        const {
            currentEmaFast,
            previousEmaFast,
            currentEmaSlow,
            previousEmaSlow,
            currentRsi,
            currentAdx,
            previousAdx,
            currentAtr,
        } = snapshot;

        const currentCandle = candles[candles.length - 1];
        const previousCandle = candles.length >= 2 ? candles[candles.length - 2] : currentCandle;

        // Cold-Start Exploration adjustments: lower ADX threshold by 3 points (down to 16) and widen RSI window by 4 points
        const baseAdxThreshold = config.strategy.adxThreshold; // default 20
        const adxThreshold = isExploreMode ? Math.max(16, baseAdxThreshold - 3) : baseAdxThreshold;
        const rsiDelta = isExploreMode ? 4 : 0;
        const adxPassed = currentAdx >= adxThreshold;

        const trendStatus: 'trending' | 'choppy' = adxPassed ? 'trending' : 'choppy';
        const trendWord: 'upward' | 'downward' = currentEmaFast > currentEmaSlow ? 'upward' : 'downward';
        const momentumWord =
            currentRsi > 65
                ? 'overbought'
                : currentRsi < 35
                ? 'oversold'
                : 'healthy';

        // Historical RSI across last 4 candles to detect recovery/cooloff
        const rsiHistory = ind.rsi && ind.rsi.length > 0 ? ind.rsi : [currentRsi];
        const recentRsis = rsiHistory.slice(Math.max(0, rsiHistory.length - 4));
        const hadRsiBelow35 = recentRsis.some(r => r < 35);
        const hadRsiAbove65 = recentRsis.some(r => r > 65);
        const previousRsi = rsiHistory.length >= 2 ? rsiHistory[rsiHistory.length - 2] : currentRsi;

        // 2-candle EMA crossover detection for Playbook B
        const twoBarsAgoFast = ind.emaFast.length >= 3 ? ind.emaFast[ind.emaFast.length - 3] : previousEmaFast;
        const twoBarsAgoSlow = ind.emaSlow.length >= 3 ? ind.emaSlow[ind.emaSlow.length - 3] : previousEmaSlow;

        const longCrossCurrent = previousEmaFast <= previousEmaSlow && currentEmaFast > currentEmaSlow;
        const longCrossPrevious = twoBarsAgoFast <= twoBarsAgoSlow && previousEmaFast > previousEmaSlow && currentEmaFast >= currentEmaSlow;
        const longEmaCross2 = longCrossCurrent || longCrossPrevious;

        const shortCrossCurrent = previousEmaFast >= previousEmaSlow && currentEmaFast < currentEmaSlow;
        const shortCrossPrevious = twoBarsAgoFast >= twoBarsAgoSlow && previousEmaFast < previousEmaSlow && currentEmaFast <= currentEmaSlow;
        const shortEmaCross2 = shortCrossCurrent || shortCrossPrevious;

        // Signal proximity string for dashboard & terminal
        let signalProximity = `Consolidation (ADX ${currentAdx.toFixed(0)}) · Waiting for trend expansion >= ${adxThreshold} ADX`;
        if (adxPassed) {
            const formattedEma = currentEmaFast < 1 ? currentEmaFast.toFixed(4) : currentEmaFast.toFixed(2);
            signalProximity = `Trending (ADX ${currentAdx.toFixed(0)}) · Watching 20 EMA pullback at $${formattedEma}`;
        }

        // Intrabar guard: unless explicitly allowed, signals only trigger on closed candle
        if (!isClosed && !allowIntrabar) {
            return {
                signal: 'HOLD',
                direction: null,
                isEntry: false,
                setupType: null,
                reason: 'Intrabar: candle still open',
                indicators: snapshot,
                trendStatus,
                trendWord,
                momentumWord,
                signalProximity,
            };
        }

        // -------------------------------------------------------------
        // PLAYBOOK B — EMA_CROSSOVER (Classic Momentum, 2-candle window)
        // -------------------------------------------------------------
        const crossoverAdxThreshold = isExploreMode ? 16 : 18;
        const crossoverAdxPassed = currentAdx >= crossoverAdxThreshold;
        const rsiCrossPassed = currentRsi >= (35 - rsiDelta) && currentRsi <= (68 + rsiDelta);

        if (longEmaCross2 && crossoverAdxPassed && rsiCrossPassed) {
            return {
                signal: 'BUY',
                direction: 'LONG',
                isEntry: true,
                setupType: 'EMA_CROSSOVER',
                reason: `Bullish EMA crossover within last 2 bars (Fast ${currentEmaFast.toFixed(2)} > Slow ${currentEmaSlow.toFixed(2)}), ADX ${currentAdx.toFixed(1)} >= ${crossoverAdxThreshold}, RSI ${currentRsi.toFixed(1)}`,
                indicators: snapshot,
                trendStatus,
                trendWord,
                momentumWord,
                signalProximity: 'Setup confirmed: EMA_CROSSOVER (LONG)',
            };
        }

        if (allowShorts && shortEmaCross2 && crossoverAdxPassed && rsiCrossPassed) {
            return {
                signal: 'SELL',
                direction: 'SHORT',
                isEntry: true,
                setupType: 'EMA_CROSSOVER',
                reason: `Bearish EMA crossover within last 2 bars (Fast ${currentEmaFast.toFixed(2)} < Slow ${currentEmaSlow.toFixed(2)}), ADX ${currentAdx.toFixed(1)} >= ${crossoverAdxThreshold}, RSI ${currentRsi.toFixed(1)}`,
                indicators: snapshot,
                trendStatus,
                trendWord,
                momentumWord,
                signalProximity: 'Setup confirmed: EMA_CROSSOVER (SHORT)',
            };
        }

        // -------------------------------------------------------------
        // PLAYBOOK A — TREND_PULLBACK (Strict RSI pullback enforcement)
        // -------------------------------------------------------------
        const pullbackTolerance = 0.4 * Math.max(0.000001, currentAtr);

        // Long Trend Pullback: EMA20 > EMA50, ADX >= 20, strictly requiring RSI between 35 and 55
        if (currentEmaFast > currentEmaSlow && adxPassed) {
            const rsiInLongPullbackZone = currentRsi >= 35 && currentRsi <= 55;
            const rsiRecoveredLong = hadRsiAbove65 && rsiInLongPullbackZone;
            const emaTouchedLong = Math.abs(currentCandle.close - currentEmaFast) <= pullbackTolerance ||
                (currentCandle.low <= currentEmaFast + pullbackTolerance && currentCandle.close >= currentEmaFast - pullbackTolerance);
            const bouncedLong = currentCandle.close > currentCandle.open;
            const priceBounceLong = emaTouchedLong && bouncedLong;

            if (rsiInLongPullbackZone && (rsiRecoveredLong || priceBounceLong)) {
                const subReason = rsiRecoveredLong
                    ? `RSI cooled off from >65 to ${currentRsi.toFixed(1)} in pullback zone [35-55]`
                    : `Price touched within 0.4 ATR of 20 EMA ($${currentEmaFast.toFixed(2)}) and bounced (close > open) with RSI ${currentRsi.toFixed(1)} in pullback zone [35-55]`;

                return {
                    signal: 'BUY',
                    direction: 'LONG',
                    isEntry: true,
                    setupType: 'TREND_PULLBACK',
                    reason: `Trend Pullback [LONG]: EMA20 > EMA50, ADX ${currentAdx.toFixed(1)} confirms trend. ${subReason}`,
                    indicators: snapshot,
                    trendStatus,
                    trendWord,
                    momentumWord,
                    signalProximity: 'Setup confirmed: TREND_PULLBACK (LONG)',
                };
            }
        }

        // Short Trend Pullback: EMA20 < EMA50, ADX >= 20, strictly requiring RSI between 45 and 65
        if (allowShorts && currentEmaFast < currentEmaSlow && adxPassed) {
            const rsiInShortPullbackZone = currentRsi >= 45 && currentRsi <= 65;
            const rsiRecoveredShort = hadRsiBelow35 && rsiInShortPullbackZone;
            const emaTouchedShort = Math.abs(currentCandle.close - currentEmaFast) <= pullbackTolerance ||
                (currentCandle.high >= currentEmaFast - pullbackTolerance && currentCandle.close <= currentEmaFast + pullbackTolerance);
            const rejectingShort = currentCandle.close < currentCandle.open;
            const priceRejectShort = emaTouchedShort && rejectingShort;

            if (rsiInShortPullbackZone && (rsiRecoveredShort || priceRejectShort)) {
                const subReason = rsiRecoveredShort
                    ? `RSI bounced/recovered from <35 to ${currentRsi.toFixed(1)} in pullback zone [45-65]`
                    : `Price touched within 0.4 ATR of 20 EMA ($${currentEmaFast.toFixed(2)}) and rejected downward (close < open) with RSI ${currentRsi.toFixed(1)} in pullback zone [45-65]`;

                return {
                    signal: 'SELL',
                    direction: 'SHORT',
                    isEntry: true,
                    setupType: 'TREND_PULLBACK',
                    reason: `Trend Pullback [SHORT]: EMA20 < EMA50, ADX ${currentAdx.toFixed(1)} confirms trend. ${subReason}`,
                    indicators: snapshot,
                    trendStatus,
                    trendWord,
                    momentumWord,
                    signalProximity: 'Setup confirmed: TREND_PULLBACK (SHORT)',
                };
            }
        }

        // -------------------------------------------------------------
        // PLAYBOOK C — EXTREME_RSI_REVERSAL (Mean-Reversion Scalp)
        // -------------------------------------------------------------
        // Long bounce: Extreme exhaustion (RSI < 22) + reversal candle body
        const isOversoldExhaustion = currentRsi < 22 || previousRsi < 22;
        const isReversalLong =
            currentCandle.close > previousCandle.high ||
            (currentCandle.close > currentCandle.open && currentCandle.open <= previousCandle.low && currentCandle.close >= previousCandle.close) ||
            (currentCandle.close > currentCandle.open && (currentCandle.close - currentCandle.open) >= 0.35 * currentAtr);

        if (isOversoldExhaustion && isReversalLong && currentRsi <= 35) {
            return {
                signal: 'BUY',
                direction: 'LONG',
                isEntry: true,
                setupType: 'EXTREME_RSI_REVERSAL',
                reason: `Extreme oversold exhaustion bounce (RSI ${currentRsi.toFixed(1)} < 22) confirmed by reversal candle close`,
                indicators: snapshot,
                trendStatus,
                trendWord,
                momentumWord,
                signalProximity: 'Setup confirmed: EXTREME_RSI_REVERSAL (LONG)',
                recommendedRiskPct: 0.01, // 1% half-size risk
                recommendedAtrMultiplier: 1.2, // tight 1.2x ATR trailing stop
                takeProfitPrice: currentCandle.close + (2.0 * currentAtr), // 2.0x ATR take-profit target
            };
        }

        // Short fade: Extreme exhaustion (RSI > 78) + reversal candle body
        const isOverboughtExhaustion = currentRsi > 78 || previousRsi > 78;
        const isReversalShort =
            currentCandle.close < previousCandle.low ||
            (currentCandle.close < currentCandle.open && currentCandle.open >= previousCandle.high && currentCandle.close <= previousCandle.close) ||
            (currentCandle.close < currentCandle.open && (currentCandle.open - currentCandle.close) >= 0.35 * currentAtr);

        if (allowShorts && isOverboughtExhaustion && isReversalShort && currentRsi >= 65) {
            return {
                signal: 'SELL',
                direction: 'SHORT',
                isEntry: true,
                setupType: 'EXTREME_RSI_REVERSAL',
                reason: `Extreme overbought exhaustion fade (RSI ${currentRsi.toFixed(1)} > 78) confirmed by reversal candle close`,
                indicators: snapshot,
                trendStatus,
                trendWord,
                momentumWord,
                signalProximity: 'Setup confirmed: EXTREME_RSI_REVERSAL (SHORT)',
                recommendedRiskPct: 0.01, // 1% half-size risk
                recommendedAtrMultiplier: 1.2, // tight 1.2x ATR trailing stop
                takeProfitPrice: currentCandle.close - (2.0 * currentAtr), // 2.0x ATR take-profit target
            };
        }

        // -------------------------------------------------------------
        // FALLBACK: VOLATILITY BREAKOUT
        // -------------------------------------------------------------
        const isAdxRising = currentAdx > 22 && (currentAdx - previousAdx >= 1.5 || (previousAdx > 0 && currentAdx > previousAdx + 1.0));
        if (isAdxRising && candles.length >= 12) {
            const lookback10 = candles.slice(Math.max(0, candles.length - 11), -1);
            const high10 = Math.max(...lookback10.map(c => c.high));
            const low10 = Math.min(...lookback10.map(c => c.low));

            if (currentCandle.close > high10 && currentRsi >= 50 && currentRsi <= 72) {
                return {
                    signal: 'BUY',
                    direction: 'LONG',
                    isEntry: true,
                    setupType: 'VOLATILITY_BREAKOUT',
                    reason: `Volatility expansion breakout above 10-candle high ($${high10.toFixed(2)}), ADX rising (+${(currentAdx - previousAdx).toFixed(1)} to ${currentAdx.toFixed(1)}), RSI ${currentRsi.toFixed(1)} confirms momentum`,
                    indicators: snapshot,
                    trendStatus,
                    trendWord,
                    momentumWord,
                    signalProximity: 'Setup confirmed: VOLATILITY_BREAKOUT (LONG)',
                };
            }

            if (allowShorts && currentCandle.close < low10 && currentRsi <= 50 && currentRsi >= 28) {
                return {
                    signal: 'SELL',
                    direction: 'SHORT',
                    isEntry: true,
                    setupType: 'VOLATILITY_BREAKOUT',
                    reason: `Volatility expansion breakdown below 10-candle low ($${low10.toFixed(2)}), ADX rising (+${(currentAdx - previousAdx).toFixed(1)} to ${currentAdx.toFixed(1)}), RSI ${currentRsi.toFixed(1)} confirms momentum`,
                    indicators: snapshot,
                    trendStatus,
                    trendWord,
                    momentumWord,
                    signalProximity: 'Setup confirmed: VOLATILITY_BREAKOUT (SHORT)',
                };
            }
        }

        // -------------------------------------------------------------
        // NEAR-MISS COUNTERFACTUAL DETECTION (Shadow Trade Candidates)
        // -------------------------------------------------------------
        let nearMiss: NearMissInfo | null = null;

        // Near-miss 1: Downtrend pullback rejected solely by RSI too low (< 45) or too high (> 65)
        if (currentEmaFast < currentEmaSlow && adxPassed && currentRsi < 45) {
            nearMiss = {
                playbook: 'TREND_PULLBACK',
                direction: 'SHORT',
                rejectedFilter: 'RSI_TOO_LOW',
                filterValue: currentRsi,
                filterThreshold: 45,
                entryPrice: currentCandle.close,
                atr: currentAtr,
                readinessPct: Math.round(Math.min(95, (currentRsi / 45) * 100)),
                message: `waiting for RSI >= 45, currently ${currentRsi.toFixed(0)}`,
            };
        } else if (currentEmaFast < currentEmaSlow && adxPassed && currentRsi > 65) {
            nearMiss = {
                playbook: 'TREND_PULLBACK',
                direction: 'SHORT',
                rejectedFilter: 'RSI_TOO_HIGH',
                filterValue: currentRsi,
                filterThreshold: 65,
                entryPrice: currentCandle.close,
                atr: currentAtr,
                readinessPct: Math.round(Math.min(95, (65 / currentRsi) * 100)),
                message: `waiting for RSI <= 65, currently ${currentRsi.toFixed(0)}`,
            };
        } else if (currentEmaFast > currentEmaSlow && adxPassed && currentRsi > 55) {
            nearMiss = {
                playbook: 'TREND_PULLBACK',
                direction: 'LONG',
                rejectedFilter: 'RSI_TOO_HIGH',
                filterValue: currentRsi,
                filterThreshold: 55,
                entryPrice: currentCandle.close,
                atr: currentAtr,
                readinessPct: Math.round(Math.min(95, (55 / currentRsi) * 100)),
                message: `waiting for RSI <= 55, currently ${currentRsi.toFixed(0)}`,
            };
        } else if (currentEmaFast > currentEmaSlow && adxPassed && currentRsi < 35) {
            nearMiss = {
                playbook: 'TREND_PULLBACK',
                direction: 'LONG',
                rejectedFilter: 'RSI_TOO_LOW',
                filterValue: currentRsi,
                filterThreshold: 35,
                entryPrice: currentCandle.close,
                atr: currentAtr,
                readinessPct: Math.round(Math.min(95, (currentRsi / 35) * 100)),
                message: `waiting for RSI >= 35, currently ${currentRsi.toFixed(0)}`,
            };
        } else if ((longEmaCross2 || shortEmaCross2) && currentAdx < crossoverAdxThreshold) {
            nearMiss = {
                playbook: 'EMA_CROSSOVER',
                direction: longEmaCross2 ? 'LONG' : 'SHORT',
                rejectedFilter: 'ADX_TOO_LOW',
                filterValue: currentAdx,
                filterThreshold: crossoverAdxThreshold,
                entryPrice: currentCandle.close,
                atr: currentAtr,
                readinessPct: Math.round(Math.min(95, (currentAdx / crossoverAdxThreshold) * 100)),
                message: `waiting for ADX >= ${crossoverAdxThreshold}, currently ${currentAdx.toFixed(0)}`,
            };
        } else if (isOversoldExhaustion && !isReversalLong) {
            nearMiss = {
                playbook: 'EXTREME_RSI_REVERSAL',
                direction: 'LONG',
                rejectedFilter: 'WAITING_REVERSAL_BODY',
                filterValue: currentRsi,
                filterThreshold: 22,
                entryPrice: currentCandle.close,
                atr: currentAtr,
                readinessPct: 90,
                message: `extreme oversold (RSI ${currentRsi.toFixed(0)}), waiting for reversal candle`,
            };
        }

        return {
            signal: 'HOLD',
            direction: null,
            isEntry: false,
            setupType: null,
            reason: 'Entry conditions not met',
            indicators: snapshot,
            trendStatus,
            trendWord,
            momentumWord,
            signalProximity,
            nearMiss,
        };
    }

    /**
     * Evaluates dynamic ATR trailing stops, Take-Profit targets, and EMA reverse crossover exits.
     */
    public static evaluateExit(
        pos: ActivePositionState,
        candle: CandleData,
        snapshot: IndicatorSnapshot,
        isClosed: boolean,
        options: {
            atrMultiplier?: number;
            trailingStopMode?: 'intrabar' | 'close';
            slippage?: number;
        } = {}
    ): ExitEvaluation {
        const atrMultiplier = options.atrMultiplier ?? config.strategy.atrMultiplier;
        const trailingStopMode = options.trailingStopMode ?? config.strategy.trailingStopMode;
        const slippage = options.slippage ?? config.exchange.slippage;
        const effectiveAtr = snapshot.currentAtr > 0 ? snapshot.currentAtr : pos.atr;

        let newTrailingStop = pos.trailingStop;
        let newHighestPrice = pos.highestPrice;
        let newLowestPrice = pos.lowestPrice;
        let stopRaisedOrLowered = false;

        if (pos.side === 'LONG') {
            // (a) Check exits against stop level carried from PREVIOUS bar
            const testPrice = trailingStopMode === 'intrabar' ? candle.low : candle.close;
            if (testPrice <= pos.trailingStop) {
                const effectiveStopPrice = Math.min(candle.open, pos.trailingStop);
                const executionPrice = effectiveStopPrice * (1 - slippage);
                return {
                    shouldExit: true,
                    reason: 'TRAILING_STOP',
                    executionPrice,
                    newTrailingStop: pos.trailingStop,
                    newHighestPrice: pos.highestPrice,
                    newLowestPrice: pos.lowestPrice,
                    stopRaisedOrLowered: false,
                    details: `Long Trailing Stop breached ($${candle.low.toFixed(2)} <= $${pos.trailingStop.toFixed(2)})`,
                };
            }

            // Check Optional Take-Profit Target (Only if stop was not hit)
            if (pos.takeProfitPrice && candle.high >= pos.takeProfitPrice) {
                const effectiveTpPrice = Math.max(candle.open, pos.takeProfitPrice);
                const executionPrice = effectiveTpPrice * (1 - slippage);
                return {
                    shouldExit: true,
                    reason: 'TAKE_PROFIT',
                    executionPrice,
                    newTrailingStop: pos.trailingStop,
                    newHighestPrice: pos.highestPrice,
                    newLowestPrice: pos.lowestPrice,
                    stopRaisedOrLowered: false,
                    details: `Long Take-Profit target reached at $${pos.takeProfitPrice.toFixed(2)}`,
                };
            }

            // Check Reverse EMA Cross on closed candle
            if (isClosed) {
                const crossedBelow =
                    snapshot.previousEmaFast >= snapshot.previousEmaSlow &&
                    snapshot.currentEmaFast < snapshot.currentEmaSlow;
                if (crossedBelow) {
                    const executionPrice = candle.close * (1 - slippage);
                    return {
                        shouldExit: true,
                        reason: 'EMA_CROSS',
                        executionPrice,
                        newTrailingStop: pos.trailingStop,
                        newHighestPrice: pos.highestPrice,
                        newLowestPrice: pos.lowestPrice,
                        stopRaisedOrLowered: false,
                        details: `Fast EMA (${snapshot.currentEmaFast.toFixed(2)}) crossed below Slow EMA (${snapshot.currentEmaSlow.toFixed(2)})`,
                    };
                }
            }

            // (b) Only if NO exit occurred, update trailing stop using current bar's high/low for use from NEXT bar
            if (candle.high > newHighestPrice) {
                newHighestPrice = candle.high;
                const proposedStop = newHighestPrice - (atrMultiplier * effectiveAtr);
                if (proposedStop > newTrailingStop) {
                    newTrailingStop = proposedStop;
                    stopRaisedOrLowered = true;
                }
            }
        } else if (pos.side === 'SHORT') {
            // (a) Check exits against stop level carried from PREVIOUS bar
            const testPrice = trailingStopMode === 'intrabar' ? candle.high : candle.close;
            if (pos.trailingStop > 0 && testPrice >= pos.trailingStop) {
                const effectiveStopPrice = Math.max(candle.open, pos.trailingStop);
                const executionPrice = effectiveStopPrice * (1 + slippage);
                return {
                    shouldExit: true,
                    reason: 'TRAILING_STOP',
                    executionPrice,
                    newTrailingStop: pos.trailingStop,
                    newHighestPrice: pos.highestPrice,
                    newLowestPrice: pos.lowestPrice,
                    stopRaisedOrLowered: false,
                    details: `Short Trailing Stop breached ($${candle.high.toFixed(2)} >= $${pos.trailingStop.toFixed(2)})`,
                };
            }

            // Check Optional Take-Profit Target (Only if stop was not hit)
            if (pos.takeProfitPrice && candle.low <= pos.takeProfitPrice) {
                const effectiveTpPrice = Math.min(candle.open, pos.takeProfitPrice);
                const executionPrice = effectiveTpPrice * (1 + slippage);
                return {
                    shouldExit: true,
                    reason: 'TAKE_PROFIT',
                    executionPrice,
                    newTrailingStop: pos.trailingStop,
                    newHighestPrice: pos.highestPrice,
                    newLowestPrice: pos.lowestPrice,
                    stopRaisedOrLowered: false,
                    details: `Short Take-Profit target reached at $${pos.takeProfitPrice.toFixed(2)}`,
                };
            }

            // Check Reverse EMA Cross on closed candle
            if (isClosed) {
                const crossedAbove =
                    snapshot.previousEmaFast <= snapshot.previousEmaSlow &&
                    snapshot.currentEmaFast > snapshot.currentEmaSlow;
                if (crossedAbove) {
                    const executionPrice = candle.close * (1 + slippage);
                    return {
                        shouldExit: true,
                        reason: 'EMA_CROSS',
                        executionPrice,
                        newTrailingStop: pos.trailingStop,
                        newHighestPrice: pos.highestPrice,
                        newLowestPrice: pos.lowestPrice,
                        stopRaisedOrLowered: false,
                        details: `Fast EMA (${snapshot.currentEmaFast.toFixed(2)}) crossed above Slow EMA (${snapshot.currentEmaSlow.toFixed(2)})`,
                    };
                }
            }

            // (b) Only if NO exit occurred, update trailing stop using current bar's high/low for use from NEXT bar
            if (candle.low < newLowestPrice || newLowestPrice === 0) {
                newLowestPrice = candle.low;
                const proposedStop = newLowestPrice + (atrMultiplier * effectiveAtr);
                if (newTrailingStop === 0 || proposedStop < newTrailingStop) {
                    newTrailingStop = proposedStop;
                    stopRaisedOrLowered = true;
                }
            }
        }

        return {
            shouldExit: false,
            reason: null,
            executionPrice: candle.close,
            newTrailingStop,
            newHighestPrice,
            newLowestPrice,
            stopRaisedOrLowered,
            details: 'Position held',
        };
    }

    /**
     * Calculates unrealized and realized PnL accounting for fees and slippage.
     */
    public static calculatePnL(
        side: 'LONG' | 'SHORT',
        amount: number,
        entryPrice: number,
        exitOrCurrentPrice: number,
        options: {
            slippage?: number;
            takerFee?: number;
            accumulatedFunding?: number;
        } = {}
    ): PnlCalculation {
        const slippage = options.slippage ?? config.exchange.slippage;
        const takerFee = options.takerFee ?? config.exchange.takerFee;
        const accumulatedFunding = options.accumulatedFunding ?? 0;
        const initialCost = amount * entryPrice;

        if (side === 'LONG') {
            const effectiveExit = exitOrCurrentPrice * (1 - slippage);
            const grossValue = amount * effectiveExit;
            const fee = grossValue * takerFee;
            const netProceeds = grossValue - fee;
            const netRealizedPnl = netProceeds - initialCost + accumulatedFunding;
            const netRealizedPnlPercent = initialCost > 0 ? (netRealizedPnl / initialCost) * 100 : 0;
            const slippageCost = amount * exitOrCurrentPrice * slippage;

            return {
                unrealizedPnl: netRealizedPnl,
                unrealizedPnlPercent: netRealizedPnlPercent,
                grossValueOrCost: grossValue,
                fee,
                netRealizedPnl,
                netRealizedPnlPercent,
                fundingPnl: accumulatedFunding,
                slippageCost,
            };
        } else {
            const effectiveExit = exitOrCurrentPrice * (1 + slippage);
            const grossCost = amount * effectiveExit;
            const fee = grossCost * takerFee;
            const netRealizedPnl = initialCost - grossCost - fee + accumulatedFunding;
            const netRealizedPnlPercent = initialCost > 0 ? (netRealizedPnl / initialCost) * 100 : 0;
            const slippageCost = amount * exitOrCurrentPrice * slippage;

            return {
                unrealizedPnl: netRealizedPnl,
                unrealizedPnlPercent: netRealizedPnlPercent,
                grossValueOrCost: grossCost,
                fee,
                netRealizedPnl,
                netRealizedPnlPercent,
                fundingPnl: accumulatedFunding,
                slippageCost,
            };
        }
    }
}

export class RiskManager {
    /**
     * Calculates position size respecting risk limits, Kelly criterion, and available capital.
     */
    public static calculatePositionSize(params: PositionSizingParams): PositionSizingResult {
        const capital = params.capital;
        const price = params.executionPrice;
        const stopDistance = Math.max(0.000001, params.stopDistance);
        const takerFee = params.takerFee ?? config.exchange.takerFee;
        const mode = params.mode ?? config.risk.sizingMode;
        const maxRiskPct = params.maxRiskPct ?? config.risk.maxRiskPct;
        const leverage = params.leverage ?? 1; // Defaults to 1 (spot/unleveraged), pass 10 for margin/futures

        if (capital <= 0 || price <= 0) {
            return {
                positionSize: 0,
                riskAmount: 0,
                totalCost: 0,
                marginRequired: 0,
                notionalSize: 0,
                isAffordable: false,
                sizingMode: mode,
                rejectionReason: 'Invalid capital or price',
            };
        }

        let effectiveRiskPct = maxRiskPct;

        if (mode === 'kelly') {
            const winRate = params.kellyWinRate ?? config.risk.kellyWinRate;
            const rewardRatio = params.kellyRewardRatio ?? config.risk.kellyRewardRatio;
            const fraction = params.kellyFraction ?? config.risk.kellyFraction;
            const lossRate = 1 - winRate;

            // Kelly formula: f* = (b * p - q) / b
            const fullKelly = (rewardRatio * winRate - lossRate) / rewardRatio;
            const fractionalKelly = fullKelly * fraction;

            if (fractionalKelly > 0) {
                // Bound Kelly percentage by maxRiskPct to prevent overleveraging
                effectiveRiskPct = Math.min(fractionalKelly, maxRiskPct);
            } else {
                // Negative expectancy under Kelly parameters, fallback safely to conservative 0.5%
                effectiveRiskPct = Math.min(0.005, maxRiskPct);
            }
        }

        const riskAmount = capital * effectiveRiskPct;
        const sizeByRisk = riskAmount / stopDistance;
        // With leverage, purchasing capacity is capital * leverage
        const maxAffordableSize = (capital * leverage * (1 - takerFee)) / price;
        const positionSize = Math.min(sizeByRisk, maxAffordableSize);

        if (positionSize <= 0 || isNaN(positionSize)) {
            return {
                positionSize: 0,
                riskAmount,
                totalCost: 0,
                marginRequired: 0,
                notionalSize: 0,
                isAffordable: false,
                sizingMode: mode,
                rejectionReason: 'Calculated size is zero or below minimum precision',
            };
        }

        const notionalSize = positionSize * price;
        const marginRequired = notionalSize / leverage;
        const fee = notionalSize * takerFee;
        const totalCost = marginRequired + fee;
        const isAffordable = totalCost <= capital;

        return {
            positionSize,
            riskAmount,
            totalCost,
            marginRequired,
            notionalSize,
            isAffordable,
            sizingMode: mode,
            rejectionReason: isAffordable ? undefined : `Insufficient capital ($${capital.toFixed(2)} available, $${totalCost.toFixed(2)} required for margin + fee)`,
        };
    }

    /**
     * Calculates institutional paper trading equity and available buying power.
     * Available Buying Power = Initial Capital + Realized PnL - (Margin Used by Open Trades) (Assume 10x leverage, so margin used is notional_size / 10).
     * Total Equity = Initial Capital + Realized PnL + Unrealized PnL.
     */
    public static calculateAccountEquity(params: {
        initialCapital: number;
        realizedPnl: number;
        unrealizedPnl: number;
        openPositionsNotional: number;
        leverage?: number;
    }): AccountEquityCalculation {
        const leverage = params.leverage ?? 10;
        const marginUsed = params.openPositionsNotional / leverage;
        const availableBuyingPower = params.initialCapital + params.realizedPnl - marginUsed;
        const totalEquity = params.initialCapital + params.realizedPnl + params.unrealizedPnl;

        return {
            initialCapital: params.initialCapital,
            realizedPnl: params.realizedPnl,
            unrealizedPnl: params.unrealizedPnl,
            totalEquity,
            marginUsed,
            availableBuyingPower,
            leverage,
        };
    }

    /**
     * Calculates aggregate dollar risk across all active open positions.
     * Dollar risk for a position = amount * max(0, |entryPrice - trailingStop|).
     * If trailing stop has ratcheted past entry into profit, dollar risk is 0.
     */
    public static calculateTotalOpenRisk(positions: Iterable<{
        side: 'LONG' | 'SHORT';
        amount: number;
        entryPrice: number;
        trailingStop: number;
    }>): number {
        let totalRisk = 0;
        for (const pos of positions) {
            const riskPerUnit = pos.side === 'LONG'
                ? Math.max(0, pos.entryPrice - pos.trailingStop)
                : Math.max(0, pos.trailingStop - pos.entryPrice);
            totalRisk += pos.amount * riskPerUnit;
        }
        return totalRisk;
    }

    /**
     * Evaluates and enforces the global open risk cap across all active positions.
     * Enforces that currentOpenRisk + newPositionRisk <= maxTotalOpenRiskPct * totalEquity (default 6%).
     */
    public static enforceOpenRiskCap(params: {
        currentOpenRisk: number;
        newPositionRisk: number;
        totalEquity: number;
        maxTotalOpenRiskPct?: number;
    }): {
        allowed: boolean;
        maxAllowedRisk: number;
        currentOpenRisk: number;
        availableRiskBudget: number;
        effectiveRisk: number;
        wasDownsized: boolean;
        reason?: string;
    } {
        const maxPct = params.maxTotalOpenRiskPct ?? config.risk.maxTotalOpenRiskPct;
        const maxAllowedRisk = Math.max(0, params.totalEquity * maxPct);
        const availableRiskBudget = Math.max(0, maxAllowedRisk - params.currentOpenRisk);

        if (availableRiskBudget <= 0) {
            return {
                allowed: false,
                maxAllowedRisk,
                currentOpenRisk: params.currentOpenRisk,
                availableRiskBudget: 0,
                effectiveRisk: 0,
                wasDownsized: false,
                reason: `Total open risk cap (${(maxPct * 100).toFixed(1)}%) reached: current open risk $${params.currentOpenRisk.toFixed(2)} >= max allowed $${maxAllowedRisk.toFixed(2)}`,
            };
        }

        if (params.newPositionRisk <= availableRiskBudget) {
            return {
                allowed: true,
                maxAllowedRisk,
                currentOpenRisk: params.currentOpenRisk,
                availableRiskBudget,
                effectiveRisk: params.newPositionRisk,
                wasDownsized: false,
            };
        }

        // Downsize to remaining budget
        return {
            allowed: true,
            maxAllowedRisk,
            currentOpenRisk: params.currentOpenRisk,
            availableRiskBudget,
            effectiveRisk: availableRiskBudget,
            wasDownsized: true,
            reason: `Position risk downsized from $${params.newPositionRisk.toFixed(2)} to $${availableRiskBudget.toFixed(2)} to respect ${(maxPct * 100).toFixed(1)}% total open risk cap`,
        };
    }

    /**
     * Checks the 24-hour rolling drawdown circuit breaker.
     */
    public static checkCircuitBreaker(
        database: Database.Database,
        capital: number,
        currentTimestamp: number,
        lockoutUntil: number,
        options: {
            maxDrawdownPct?: number;
            lockoutMs?: number;
        } = {}
    ): CircuitBreakerStatus {
        const maxDrawdownPct = options.maxDrawdownPct ?? config.risk.maxDrawdownPct;
        const lockoutMs = options.lockoutMs ?? config.risk.lockoutMs;
        const lossThreshold = capital * maxDrawdownPct;

        // Check active lockout
        if (currentTimestamp < lockoutUntil) {
            return {
                isHalted: true,
                isLockedOut: true,
                totalLoss24h: 0,
                lockoutUntil,
                lossThreshold,
                reason: `Locked out until ${new Date(lockoutUntil).toISOString()}`,
            };
        }

        // Clean records older than 24h rolling window
        const windowMs = 24 * 60 * 60 * 1000;
        const cutoff = currentTimestamp - windowMs;

        try {
            database.prepare('DELETE FROM daily_losses WHERE timestamp < ?').run(cutoff);
            const sumRow = database.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM daily_losses WHERE timestamp >= ?').get(cutoff) as { total: number };
            const totalLoss24h = sumRow?.total ?? 0;

            if (totalLoss24h >= lossThreshold) {
                const newLockoutUntil = currentTimestamp + lockoutMs;
                log.error(
                    { totalLoss24h, lossThreshold, capital, newLockoutUntil },
                    'EMERGENCY STOP TRIGGERED: 24-hour rolling loss exceeded drawdown limit'
                );
                return {
                    isHalted: true,
                    isLockedOut: true,
                    totalLoss24h,
                    lockoutUntil: newLockoutUntil,
                    lossThreshold,
                    reason: `Lost $${totalLoss24h.toFixed(2)} in the last 24h (over ${(maxDrawdownPct * 100).toFixed(1)}% of $${capital.toFixed(2)} balance)`,
                };
            }

            return {
                isHalted: false,
                isLockedOut: false,
                totalLoss24h,
                lockoutUntil: 0,
                lossThreshold,
            };
        } catch (err) {
            log.warn({ err }, 'Error checking circuit breaker');
            return {
                isHalted: false,
                isLockedOut: false,
                totalLoss24h: 0,
                lockoutUntil,
                lossThreshold,
            };
        }
    }

    /**
     * Records a realized loss into the daily_losses table.
     */
    public static recordDailyLoss(database: Database.Database, timestamp: number, lossAmount: number): void {
        if (lossAmount <= 0) return;
        try {
            database.prepare('INSERT INTO daily_losses (timestamp, amount) VALUES (?, ?)').run(timestamp, lossAmount);
        } catch (err) {
            log.error({ err }, 'Error recording daily loss');
        }
    }

    /**
     * Calculates adaptive dynamic risk percentage based on self-learning strategy performance.
     * Scales between 1.0% (for win rate < 40%) and 2.5% (for win rate > 55%).
     */
    public static calculateAdaptiveRiskPct(
        database: Database.Database,
        setupType: SetupType,
        symbol: string,
        baseRiskPct: number = config.risk.maxRiskPct
    ): number {
        return RiskManager.calculateAdaptiveRiskDetails(database, setupType, symbol, baseRiskPct).riskPct;
    }

    public static calculateAdaptiveRiskDetails(
        database: Database.Database,
        setupType: SetupType,
        symbol: string,
        baseRiskPct: number = config.risk.maxRiskPct
    ): { riskPct: number; multiplier: number; winRate: number; tradesCount: number } {
        try {
            const row = database.prepare(`
                SELECT trades_count, wins_count, win_rate, risk_multiplier
                FROM strategy_performance
                WHERE setup_type = ? AND symbol = ?
            `).get(setupType, symbol) as any;

            if (!row || Number(row.trades_count) < 1) {
                return { riskPct: baseRiskPct, multiplier: 1.0, winRate: 0.5, tradesCount: 0 };
            }

            const tradesCount = Number(row.trades_count);
            const winRate = Number(row.win_rate);
            const rawMultiplier = Number(row.risk_multiplier || 1.0);

            // Shrink learner weight towards 1.0 prior until at least 50 trades per setup
            const minSamples = config.risk.learnerMinSampleSize || 50;
            const credibility = Math.min(1.0, tradesCount / minSamples);
            const shrunkMultiplier = 1.0 + (rawMultiplier - 1.0) * credibility;

            let adaptiveRisk = baseRiskPct * shrunkMultiplier;
            adaptiveRisk = Math.max(config.risk.minAdaptiveRiskPct, Math.min(config.risk.maxAdaptiveRiskPct, adaptiveRisk));

            return {
                riskPct: adaptiveRisk,
                multiplier: shrunkMultiplier,
                winRate,
                tradesCount,
            };
        } catch {
            return { riskPct: baseRiskPct, multiplier: 1.0, winRate: 0.5, tradesCount: 0 };
        }
    }

    /**
     * Records a closed trade and adapts setup weighting, logging adjustments to activity_log.
     */
    public static recordClosedTradeAndAdapt(
        database: Database.Database,
        setupTypeOrTrade: SetupType | { setupType: SetupType; symbol: string; pnl: number },
        paramSymbol?: string,
        paramRealizedPnl?: number
    ): { winRate: number; newMultiplier: number; logMessage: string; adjusted: boolean; message: string } {
        let setupType: SetupType = 'EMA_CROSSOVER';
        let symbol = '';
        let realizedPnl = 0;

        if (typeof setupTypeOrTrade === 'object' && setupTypeOrTrade !== null) {
            setupType = setupTypeOrTrade.setupType;
            symbol = setupTypeOrTrade.symbol;
            realizedPnl = setupTypeOrTrade.pnl;
        } else {
            setupType = setupTypeOrTrade;
            symbol = paramSymbol || '';
            realizedPnl = paramRealizedPnl || 0;
        }

        const isWin = realizedPnl > 0;
        const now = Date.now();

        try {
            const existing = database.prepare(`
                SELECT trades_count, wins_count, losses_count, expectancy
                FROM strategy_performance
                WHERE setup_type = ? AND symbol = ?
            `).get(setupType, symbol) as any;

            const tradesCount = (existing ? Number(existing.trades_count) : 0) + 1;
            const winsCount = (existing ? Number(existing.wins_count) : 0) + (isWin ? 1 : 0);
            const lossesCount = (existing ? Number(existing.losses_count) : 0) + (isWin ? 0 : 1);
            const winRate = tradesCount > 0 ? winsCount / tradesCount : 0;
            const oldExpectancy = existing ? Number(existing.expectancy || 0) : 0;
            const newExpectancy = oldExpectancy + (realizedPnl - oldExpectancy) / tradesCount;

            // Dynamically scale multiplier: > 55% win rate -> up to 1.25x (2.5% risk), < 40% -> down to 0.5x (1.0% risk)
            let newMultiplier = 1.0;
            if (tradesCount >= 3) {
                if (winRate > 0.55) {
                    newMultiplier = Math.min(1.25, 1.0 + (winRate - 0.55) * 1.5);
                } else if (winRate < 0.40) {
                    newMultiplier = Math.max(0.5, 1.0 - (0.40 - winRate) * 1.5);
                }
            }

            database.prepare(`
                INSERT INTO strategy_performance (setup_type, symbol, trades_count, wins_count, losses_count, win_rate, expectancy, risk_multiplier, last_adjusted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(setup_type, symbol) DO UPDATE SET
                    trades_count = excluded.trades_count,
                    wins_count = excluded.wins_count,
                    losses_count = excluded.losses_count,
                    win_rate = excluded.win_rate,
                    expectancy = excluded.expectancy,
                    risk_multiplier = excluded.risk_multiplier,
                    last_adjusted_at = excluded.last_adjusted_at;
            `).run(setupType, symbol, tradesCount, winsCount, lossesCount, winRate, newExpectancy, newMultiplier, now);

            const effectiveRiskPct = (config.risk.maxRiskPct * newMultiplier * 100).toFixed(1);
            const logMessage = `Adaptive Engine: Adjusted ${setupType} weight to ${effectiveRiskPct}% risk (${(winRate * 100).toFixed(0)}% win rate over ${tradesCount} trades on ${symbol})`;

            const nowIso = new Date().toISOString();
            database.prepare(`
                INSERT INTO activity_log (timestamp, type, message, cause, dismissed)
                VALUES (?, 'STATE_CHANGE', ?, 'Self-learning performance adaptation', 0)
            `).run(nowIso, logMessage);

            log.info({ setupType, symbol, winRate, newMultiplier, tradesCount }, logMessage);
            return { winRate, newMultiplier, logMessage, adjusted: true, message: logMessage };
        } catch (err) {
            log.warn({ err }, 'Error in recordClosedTradeAndAdapt');
            return { winRate: 0.5, newMultiplier: 1.0, logMessage: '', adjusted: false, message: '' };
        }
    }
}

export default StrategyEngine;

