import Database from 'better-sqlite3';
import { db } from '../db';
import config from '../config';
import { createLogger } from '../utils/logger';
import { SetupType } from './core';

const log = createLogger('strategy-learner');

export type Playbook = SetupType;
export type SymbolTier = 'CORE' | 'SATELLITE';
export type VolatilityRegime = 'LOW_VOL' | 'NORMAL_VOL' | 'HIGH_VOL';

export interface StrategyLearningRecord {
    playbook: string;
    symbol_tier: SymbolTier;
    volatility_regime: VolatilityRegime;
    trades_count: number;
    wins: number;
    losses: number;
    win_rate: number;
    profit_factor: number;
    avg_r_multiple: number;
    confidence_weight: number;
    last_updated: number;
}

export interface ShadowTradeRecord {
    id?: number;
    symbol: string;
    playbook: string;
    direction: 'LONG' | 'SHORT';
    rejected_filter: string;
    filter_value: number;
    filter_threshold: number;
    entry_price: number;
    atr: number;
    timestamp: number;
    eval_candle_count?: number;
    outcome_pnl?: number | null;
    outcome_r?: number | null;
    status?: 'OPEN' | 'RESOLVED';
}

export interface SetupProximity {
    symbol: string;
    playbook: string;
    readinessPct: number;
    statusText: string;
}

export class StrategyLearner {
    /**
     * Categorizes volatility regime based on ATR/Price and ADX metrics.
     */
    public static detectVolatilityRegime(atr: number, price: number, adx: number): VolatilityRegime {
        if (price <= 0) return 'NORMAL_VOL';
        const atrPct = atr / price;
        if (adx >= 28 || atrPct >= 0.015) return 'HIGH_VOL';
        if (adx < 18 || atrPct < 0.006) return 'LOW_VOL';
        return 'NORMAL_VOL';
    }

    /**
     * Determines whether the bot is in EXPLORATION mode or EXPLOITATION mode.
     * Activates EXPLORATION_MODE if:
     * - Total open trades == 0, AND
     * - No trade placed in the last 60 minutes.
     */
    public static getLearnerMode(openPositionsCount: number, lastTradeTime: number): 'EXPLORE' | 'EXPLOIT' {
        const now = Date.now();
        const sixtyMinutesMs = 60 * 60 * 1000;
        const noRecentTrades = lastTradeTime === 0 || (now - lastTradeTime >= sixtyMinutesMs);

        if (openPositionsCount === 0 && noRecentTrades) {
            return 'EXPLORE';
        }
        return 'EXPLOIT';
    }

    /**
     * Returns exploration-adjusted ADX and RSI window thresholds.
     * Lower ADX by 3 points (down to 16) and widen RSI window by 4 points in EXPLORE mode.
     */
    public static getExplorationThresholds(isExplore: boolean, baseAdx: number = 20) {
        if (!isExplore) {
            return {
                adxThreshold: baseAdx,
                rsiDelta: 0,
            };
        }
        return {
            adxThreshold: Math.max(16, baseAdx - 3),
            rsiDelta: 4,
        };
    }

    /**
     * Retrieves the learned confidence weight for a (playbook, symbol_tier, volatility_regime) arm.
     * Default: 1.0, bounded between 0.5 and 1.75.
     */
    public static getConfidenceWeight(
        database: Database.Database = db,
        playbook: string,
        symbolTier: SymbolTier = 'CORE',
        volatilityRegime: VolatilityRegime = 'NORMAL_VOL'
    ): number {
        try {
            const row = database.prepare(`
                SELECT confidence_weight, trades_count
                FROM strategy_learning
                WHERE playbook = ? AND symbol_tier = ? AND volatility_regime = ?
            `).get(playbook, symbolTier, volatilityRegime) as { confidence_weight: number; trades_count: number } | undefined;

            if (!row || Number(row.trades_count) < 1) {
                return 1.0;
            }

            const tradesCount = Number(row.trades_count);
            const rawWeight = Number(row.confidence_weight) || 1.0;
            const minSamples = config.risk.learnerMinSampleSize || 50;
            const credibility = Math.min(1.0, tradesCount / minSamples);
            const effectiveWeight = 1.0 + (rawWeight - 1.0) * credibility;

            return Math.max(0.5, Math.min(1.75, effectiveWeight));
        } catch {
            return 1.0;
        }
    }

    /**
     * Updates learning statistics for a completed trade and recalculates the bandit confidence weight.
     */
    public static recordTradeOutcome(
        database: Database.Database = db,
        trade: {
            playbook: string;
            symbolTier: SymbolTier;
            volatilityRegime: VolatilityRegime;
            netPnl: number;
            rMultiple: number;
        }
    ): { confidenceWeight: number; winRate: number; tradesCount: number } {
        const { playbook, symbolTier, volatilityRegime, netPnl, rMultiple } = trade;
        const isWin = netPnl > 0;
        const now = Date.now();

        try {
            const existing = database.prepare(`
                SELECT trades_count, wins, losses, win_rate, profit_factor, avg_r_multiple, confidence_weight
                FROM strategy_learning
                WHERE playbook = ? AND symbol_tier = ? AND volatility_regime = ?
            `).get(playbook, symbolTier, volatilityRegime) as StrategyLearningRecord | undefined;

            const tradesCount = (existing ? Number(existing.trades_count) : 0) + 1;
            const wins = (existing ? Number(existing.wins) : 0) + (isWin ? 1 : 0);
            const losses = (existing ? Number(existing.losses) : 0) + (isWin ? 0 : 1);
            const winRate = tradesCount > 0 ? wins / tradesCount : 0.5;

            const oldAvgR = existing ? Number(existing.avg_r_multiple || 0) : 0;
            const newAvgR = oldAvgR + (rMultiple - oldAvgR) / tradesCount;

            // Multi-Armed Bandit Confidence Weight calculation (Upper Confidence Bound + Expectancy)
            // Shrunk towards 1.0 prior until at least 50 trades per setup
            const expectancyBonus = (winRate - 0.50) * 1.5;
            const rBonus = newAvgR > 0 ? Math.min(0.25, newAvgR * 0.1) : Math.max(-0.25, newAvgR * 0.1);
            const rawWeight = Math.max(0.5, Math.min(1.75, 1.0 + expectancyBonus + rBonus));

            const minSamples = config.risk.learnerMinSampleSize || 50;
            const credibility = Math.min(1.0, tradesCount / minSamples);
            const newWeight = Math.max(0.5, Math.min(1.75, 1.0 + (rawWeight - 1.0) * credibility));

            database.prepare(`
                INSERT INTO strategy_learning (
                    playbook, symbol_tier, volatility_regime, trades_count, wins, losses,
                    win_rate, profit_factor, avg_r_multiple, confidence_weight, last_updated
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(playbook, symbol_tier, volatility_regime) DO UPDATE SET
                    trades_count = excluded.trades_count,
                    wins = excluded.wins,
                    losses = excluded.losses,
                    win_rate = excluded.win_rate,
                    avg_r_multiple = excluded.avg_r_multiple,
                    confidence_weight = excluded.confidence_weight,
                    last_updated = excluded.last_updated;
            `).run(
                playbook,
                symbolTier,
                volatilityRegime,
                tradesCount,
                wins,
                losses,
                winRate,
                1.0,
                newAvgR,
                newWeight,
                now
            );

            log.info(
                { playbook, symbolTier, volatilityRegime, winRate, newWeight, tradesCount },
                `Bandit Learner adapted: Weight ${newWeight.toFixed(2)}x (Win Rate: ${(winRate * 100).toFixed(0)}% over ${tradesCount} trades)`
            );

            return { confidenceWeight: newWeight, winRate, tradesCount };
        } catch (err) {
            log.warn({ err }, 'Error recording bandit trade outcome');
            return { confidenceWeight: 1.0, winRate: 0.5, tradesCount: 1 };
        }
    }

    /**
     * Records a near-miss counterfactual "shadow trade" when a setup was rejected by just ONE filter.
     */
    public static recordShadowTrade(
        database: Database.Database = db,
        shadow: Omit<ShadowTradeRecord, 'id'>
    ): void {
        try {
            // Check if there is already an open shadow trade for this symbol/playbook in the last 15 minutes
            const fifteenMinAgo = shadow.timestamp - 15 * 60 * 1000;
            const existing = database.prepare(`
                SELECT id FROM shadow_trades
                WHERE symbol = ? AND playbook = ? AND status = 'OPEN' AND timestamp > ?
            `).get(shadow.symbol, shadow.playbook, fifteenMinAgo);

            if (existing) return;

            database.prepare(`
                INSERT INTO shadow_trades (
                    symbol, playbook, direction, rejected_filter, filter_value,
                    filter_threshold, entry_price, atr, timestamp, eval_candle_count, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'OPEN')
            `).run(
                shadow.symbol,
                shadow.playbook,
                shadow.direction,
                shadow.rejected_filter,
                shadow.filter_value,
                shadow.filter_threshold,
                shadow.entry_price,
                shadow.atr,
                shadow.timestamp
            );

            log.info(
                { symbol: shadow.symbol, playbook: shadow.playbook, filter: shadow.rejected_filter, val: shadow.filter_value, thresh: shadow.filter_threshold },
                `Recorded near-miss shadow trade for counterfactual tracking`
            );
        } catch (err) {
            log.warn({ err }, 'Error recording shadow trade');
        }
    }

    /**
     * Evaluates open shadow trades on every closed candle / tick.
     * Evaluates outcome 4 candles later (approx 1 hour on 15m timeframe),
     * or if price reaches 1.5 ATR trailing stop or 2.0 ATR profit target.
     */
    public static evaluateShadowTrades(
        database: Database.Database = db,
        currentCandlesMap: Map<string, { close: number; high: number; low: number }>
    ): { resolvedCount: number; adjustments: string[] } {
        const adjustments: string[] = [];
        let resolvedCount = 0;

        try {
            const openShadows = database.prepare(`
                SELECT * FROM shadow_trades WHERE status = 'OPEN'
            `).all() as any[];

            if (!openShadows || openShadows.length === 0) {
                return { resolvedCount: 0, adjustments: [] };
            }

            for (const shadow of openShadows) {
                const currentData = currentCandlesMap.get(shadow.symbol);
                if (!currentData) continue;

                const candleCount = (Number(shadow.eval_candle_count) || 0) + 1;
                const entryPrice = Number(shadow.entry_price);
                const atr = Math.max(0.000001, Number(shadow.atr));
                const direction = shadow.direction as 'LONG' | 'SHORT';

                const stopLoss = direction === 'LONG' ? entryPrice - (1.5 * atr) : entryPrice + (1.5 * atr);
                const takeProfit = direction === 'LONG' ? entryPrice + (2.0 * atr) : entryPrice - (2.0 * atr);

                const hitStop = direction === 'LONG' ? currentData.low <= stopLoss : currentData.high >= stopLoss;
                const hitTarget = direction === 'LONG' ? currentData.high >= takeProfit : currentData.low <= takeProfit;

                if (candleCount >= 4 || hitStop || hitTarget) {
                    let exitPrice = currentData.close;
                    if (hitTarget) exitPrice = takeProfit;
                    else if (hitStop) exitPrice = stopLoss;

                    const outcomePnl = direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
                    const outcomeR = outcomePnl / atr;

                    database.prepare(`
                        UPDATE shadow_trades
                        SET eval_candle_count = ?, outcome_pnl = ?, outcome_r = ?, status = 'RESOLVED'
                        WHERE id = ?
                    `).run(candleCount, outcomePnl, outcomeR, shadow.id);

                    resolvedCount++;
                } else {
                    database.prepare(`
                        UPDATE shadow_trades SET eval_candle_count = ? WHERE id = ?
                    `).run(candleCount, shadow.id);
                }
            }

            // Check if shadow trades for a specific filter show consistently profitable performance (win rate > 55% over >= 5 trades)
            const filterStats = database.prepare(`
                SELECT rejected_filter, COUNT(*) as total,
                       SUM(CASE WHEN outcome_r > 0 THEN 1 ELSE 0 END) as wins,
                       AVG(outcome_r) as avg_r
                FROM shadow_trades
                WHERE status = 'RESOLVED'
                GROUP BY rejected_filter
                HAVING COUNT(*) >= 5
            `).all() as { rejected_filter: string; total: number; wins: number; avg_r: number }[];

            for (const fs of filterStats) {
                const winRate = fs.wins / fs.total;
                if (winRate >= 0.55 && fs.avg_r > 0.2) {
                    const msg = `Learner Counterfactual: Shadow trades for filter '${fs.rejected_filter}' won ${(winRate * 100).toFixed(0)}% (avg ${fs.avg_r.toFixed(2)}R) over ${fs.total} tests. Relaxing filter threshold!`;
                    adjustments.push(msg);
                }
            }
        } catch (err) {
            log.warn({ err }, 'Error evaluating shadow trades');
        }

        return { resolvedCount, adjustments };
    }

    /**
     * Retrieves the top performing playbook by confidence weight / win rate.
     */
    public static getTopPlaybook(database: Database.Database = db): { playbook: string; winRate: number; weight: number } {
        try {
            const row = database.prepare(`
                SELECT playbook, win_rate, confidence_weight, trades_count
                FROM strategy_learning
                WHERE trades_count >= 1
                ORDER BY confidence_weight DESC, win_rate DESC
                LIMIT 1
            `).get() as any;

            if (row) {
                return {
                    playbook: row.playbook || 'TREND_PULLBACK',
                    winRate: Number(row.win_rate) || 0.55,
                    weight: Number(row.confidence_weight) || 1.0,
                };
            }
        } catch {
            // fallback
        }
        return {
            playbook: 'TREND_PULLBACK',
            winRate: 0.55,
            weight: 1.0,
        };
    }

    /**
     * Formats the 2 terminal status update lines for the 5-minute update box.
     */
    public static getStatusLines(
        database: Database.Database = db,
        openPositionsCount: number,
        lastTradeTime: number,
        closestSetup?: SetupProximity
    ): { learnerLine: string; setupLine: string } {
        const mode = this.getLearnerMode(openPositionsCount, lastTradeTime);

        let shadowCount = 0;
        try {
            const countRow = database.prepare('SELECT COUNT(*) as c FROM shadow_trades').get() as { c: number } | undefined;
            shadowCount = countRow?.c || 0;
        } catch {
            shadowCount = 0;
        }

        const top = this.getTopPlaybook(database);
        const winPctStr = (top.winRate * 100).toFixed(0);
        const weightStr = top.weight.toFixed(2);

        const learnerLine = `   🧠 Learner: Mode [${mode}] | Shadow Setups Tracked: ${shadowCount} | Top Playbook: ${top.playbook} (Win: ${winPctStr}%, Weight: ${weightStr}x)`;

        let setupLine = `   🎯 Closest Setup: Scanning 15m active universe for high-probability setups...`;
        if (closestSetup && closestSetup.symbol) {
            setupLine = `   🎯 Closest Setup: ${closestSetup.symbol} ([${closestSetup.playbook}] - ${closestSetup.readinessPct}% ready, ${closestSetup.statusText})`;
        }

        return { learnerLine, setupLine };
    }
}

export default StrategyLearner;
