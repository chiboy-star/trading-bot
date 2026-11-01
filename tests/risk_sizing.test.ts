import { describe, it, expect } from 'vitest';
import { RiskManager } from '../src/core/risk';
import { StrategyEngine } from '../src/core/strategy';

describe('Risk & Position Sizing Math', () => {
    it('calculates fixed 2% portfolio risk correctly', () => {
        const capital = 10000;
        const executionPrice = 2000;
        const stopDistance = 50; // 2.5% stop distance
        const maxRiskPct = 0.02; // 2% risk = $200

        const sizing = RiskManager.calculatePositionSize({
            capital,
            executionPrice,
            stopDistance,
            maxRiskPct,
            mode: 'fixed',
            takerFee: 0.00075,
        });

        expect(sizing.isAffordable).toBe(true);
        expect(sizing.riskAmount).toBe(200);
        // Size = riskAmount / stopDistance = 200 / 50 = 4.0 units
        expect(sizing.positionSize).toBeCloseTo(4.0, 4);
        // Total cost = 4 * 2000 * (1 + 0.00075) = 8006
        expect(sizing.totalCost).toBeCloseTo(8006, 2);
    });

    it('caps position size by maximum affordable capital when stop distance is extremely tight', () => {
        const capital = 5000;
        const executionPrice = 100;
        const stopDistance = 0.01; // Tiny stop distance would ask for huge position size

        const sizing = RiskManager.calculatePositionSize({
            capital,
            executionPrice,
            stopDistance,
            maxRiskPct: 0.02,
            takerFee: 0.00075,
        });

        // Max affordable size = 5000 * (1 - 0.00075) / 100 = 49.9625
        expect(sizing.positionSize).toBeLessThanOrEqual(50);
        expect(sizing.totalCost).toBeLessThanOrEqual(capital);
        expect(sizing.isAffordable).toBe(true);
    });

    it('rejects position calculation when capital or price is invalid', () => {
        const zeroCapital = RiskManager.calculatePositionSize({
            capital: 0,
            executionPrice: 100,
            stopDistance: 5,
        });
        expect(zeroCapital.positionSize).toBe(0);
        expect(zeroCapital.isAffordable).toBe(false);

        const negativeCapital = RiskManager.calculatePositionSize({
            capital: -500,
            executionPrice: 100,
            stopDistance: 5,
        });
        expect(negativeCapital.positionSize).toBe(0);
        expect(negativeCapital.isAffordable).toBe(false);
    });

    it('calculates Kelly Criterion sizing bounded by max risk', () => {
        const capital = 10000;
        const executionPrice = 500;
        const stopDistance = 20;

        // Kelly params: winRate 60%, rewardRatio 2.0 -> Full Kelly = (2 * 0.6 - 0.4) / 2 = 0.40 (40%)
        // Half Kelly = 20%
        // Bounded by maxRiskPct = 2%
        const sizing = RiskManager.calculatePositionSize({
            capital,
            executionPrice,
            stopDistance,
            mode: 'kelly',
            maxRiskPct: 0.02,
            kellyFraction: 0.5,
            kellyWinRate: 0.6,
            kellyRewardRatio: 2.0,
            takerFee: 0.00075,
        });

        expect(sizing.isAffordable).toBe(true);
        expect(sizing.riskAmount).toBe(200); // Capped by max risk of 2%
        expect(sizing.positionSize).toBeCloseTo(10, 2);
    });

    it('handles negative expectancy in Kelly mode safely without blowing up', () => {
        const capital = 10000;
        const executionPrice = 100;
        const stopDistance = 10;

        // Negative expectancy: winRate 30%, rewardRatio 1.0 -> Full Kelly is negative
        const sizing = RiskManager.calculatePositionSize({
            capital,
            executionPrice,
            stopDistance,
            mode: 'kelly',
            maxRiskPct: 0.02,
            kellyFraction: 0.5,
            kellyWinRate: 0.3,
            kellyRewardRatio: 1.0,
        });

        expect(sizing.isAffordable).toBe(true);
        // Falls back safely to conservative 0.5% risk
        expect(sizing.riskAmount).toBe(50);
        expect(sizing.positionSize).toBe(5);
    });
});

describe('PnL, Fee & Slippage Deductions', () => {
    it('correctly calculates Long trade PnL with fee and slippage', () => {
        const amount = 2;
        const entryPrice = 1000;
        const exitPrice = 1100; // 10% gross gain
        const slippage = 0.0005; // 0.05%
        const takerFee = 0.00075; // 0.075%

        const pnl = StrategyEngine.calculatePnL('LONG', amount, entryPrice, exitPrice, { slippage, takerFee });

        // Initial cost: 2 * 1000 = 2000
        // Effective exit price: 1100 * (1 - 0.0005) = 1099.45
        // Gross value: 2 * 1099.45 = 2198.90
        // Fee: 2198.90 * 0.00075 = 1.649175
        // Net proceeds: 2198.90 - 1.649175 = 2197.250825
        // Realized PnL: 2197.250825 - 2000 = +197.25
        expect(pnl.netRealizedPnl).toBeCloseTo(197.25, 2);
        expect(pnl.netRealizedPnlPercent).toBeCloseTo(9.86, 2);
    });

    it('correctly calculates Short trade PnL with fee and slippage', () => {
        const amount = 2;
        const entryPrice = 1000;
        const exitPrice = 900; // 10% price drop (profit for Short)
        const slippage = 0.0005;
        const takerFee = 0.00075;

        const pnl = StrategyEngine.calculatePnL('SHORT', amount, entryPrice, exitPrice, { slippage, takerFee });

        // Initial collateral/notional: 2 * 1000 = 2000
        // Effective buy-to-cover price: 900 * (1 + 0.0005) = 900.45
        // Gross buyback cost: 2 * 900.45 = 1800.90
        // Fee: 1800.90 * 0.00075 = 1.350675
        // Net Realized PnL: 2000 - 1800.90 - 1.350675 = +197.75
        expect(pnl.netRealizedPnl).toBeCloseTo(197.75, 2);
        expect(pnl.netRealizedPnlPercent).toBeCloseTo(9.89, 2);
    });
});

describe('Paper Trading Perpetual Equity & Buying Power Accounting', () => {
    it('calculates 10x leverage margin sizing correctly without false drawdown', () => {
        const capital = 10000;
        const executionPrice = 100;
        const stopDistance = 5; // 5% stop
        const maxRiskPct = 0.02; // $200 risk

        const sizing = RiskManager.calculatePositionSize({
            capital,
            executionPrice,
            stopDistance,
            maxRiskPct,
            leverage: 10,
            takerFee: 0.00075,
        });

        expect(sizing.isAffordable).toBe(true);
        expect(sizing.riskAmount).toBe(200);
        // Position size = 200 / 5 = 40 units
        expect(sizing.positionSize).toBeCloseTo(40, 4);
        // Notional = 40 * 100 = $4,000
        expect(sizing.notionalSize).toBeCloseTo(4000, 2);
        // Margin required at 10x = 4000 / 10 = $400
        expect(sizing.marginRequired).toBeCloseTo(400, 2);
        // Total cost = 400 + 4000 * 0.00075 = $403
        expect(sizing.totalCost).toBeCloseTo(403, 2);
    });

    it('calculates Available Buying Power and Total Equity correctly with open positions', () => {
        const initialCapital = 10000;
        const realizedPnl = 0;
        const unrealizedPnl = 50; // Floating profit
        const openPositionsNotional = 3500; // Open trade with $3,500 notional

        const equity = RiskManager.calculateAccountEquity({
            initialCapital,
            realizedPnl,
            unrealizedPnl,
            openPositionsNotional,
            leverage: 10,
        });

        // Margin used = 3500 / 10 = 350
        expect(equity.marginUsed).toBe(350);
        // Available Buying Power = 10000 + 0 - 350 = 9650
        expect(equity.availableBuyingPower).toBe(9650);
        // Total Equity = 10000 + 0 + 50 = 10050 (NO false 35% drawdown!)
        expect(equity.totalEquity).toBe(10050);
    });
});
