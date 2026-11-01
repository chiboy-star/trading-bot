import { describe, it, expect } from 'vitest';
import { calculateRiskAdjustedMetrics } from '../src/backtester';

describe('Backtester Risk-Adjusted Metrics (Sharpe & Sortino)', () => {
    it('returns zero for insufficient data points', () => {
        expect(calculateRiskAdjustedMetrics([])).toEqual({ sharpeRatio: 0, sortinoRatio: 0 });
        expect(calculateRiskAdjustedMetrics([0.01])).toEqual({ sharpeRatio: 0, sortinoRatio: 0 });
    });

    it('calculates positive Sharpe and Sortino for consistently profitable stream', () => {
        // Steady positive returns with minor volatility
        const returns = [0.005, 0.008, 0.004, 0.006, 0.007, 0.005, 0.006, 0.009];
        const metrics = calculateRiskAdjustedMetrics(returns, 8760);

        expect(metrics.sharpeRatio).toBeGreaterThan(0);
        expect(metrics.sortinoRatio).toBe(99.99);
    });

    it('correctly calculates downside deviation and penalizes negative returns in Sortino', () => {
        // Mix of positive and sharp negative returns
        const returns = [0.02, -0.015, 0.01, -0.02, 0.025, -0.01, 0.015, -0.005];
        const metrics = calculateRiskAdjustedMetrics(returns, 8760);

        expect(typeof metrics.sharpeRatio).toBe('number');
        expect(typeof metrics.sortinoRatio).toBe('number');
        expect(metrics.sortinoRatio).toBeGreaterThan(0);
    });

    it('handles negative mean return gracefully with negative Sharpe ratio', () => {
        const losingReturns = [-0.01, -0.02, 0.005, -0.015, -0.008, -0.012];
        const metrics = calculateRiskAdjustedMetrics(losingReturns, 8760);

        expect(metrics.sharpeRatio).toBeLessThan(0);
        expect(metrics.sortinoRatio).toBeLessThan(0);
    });
});
