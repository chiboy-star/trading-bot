import { describe, it, expect } from 'vitest';
import { PaperFillSimulator } from '../src/simulation/paper_fill_simulator';
import { FillRequest } from '../src/simulation/types';
import { OrderbookSnapshot } from '../src/recorder/types';

describe('Paper Fill Simulator Suite', () => {
    const simulator = new PaperFillSimulator();

    const mockBook: OrderbookSnapshot = {
        symbol: 'BTCUSDT',
        timestamp: 1700000000000,
        depth: 5,
        bids: [
            [80000, 1.0], // Best Bid
            [79990, 2.0],
            [79980, 3.0]
        ],
        asks: [
            [80010, 1.0], // Best Ask
            [80020, 2.0],
            [80030, 3.0]
        ],
        bestBid: 80000,
        bestAsk: 80010,
        spread: 10,
        midPrice: 80005,
        recordedAt: 1700000000000
    };

    describe('1. Realistic Book Walking (Market Orders)', () => {
        it('should walk ask book for BUY order across multiple levels', () => {
            // Request to buy 2.5 BTC:
            // Fills 1.0 @ 80,010 = 80,010
            // Fills 1.5 @ 80,020 = 120,030
            // Total cost = 200,040 / 2.5 = 80,016.00
            const request: FillRequest = {
                symbol: 'BTCUSDT',
                side: 'BUY',
                type: 'MARKET',
                quantity: 2.5,
                signalPrice: 80010,
                timestamp: 1700000000000
            };

            const fill = simulator.simulateFill(request, mockBook);

            expect(fill.simulatedFromBook).toBe(true);
            expect(fill.fillPrice).toBe(80016.00);
            expect(fill.slippage).toBe(6.00);
            expect(fill.feeTier).toBe('TAKER');
            expect(fill.feeRate).toBe(0.00055);
            // Fee: 80016 * 2.5 * 0.00055 = 110.022
            expect(fill.fee).toBeCloseTo(110.022, 2);
        });

        it('should walk bid book for SELL order across multiple levels', () => {
            // Request to sell 2.0 BTC:
            // Fills 1.0 @ 80,000 = 80,000
            // Fills 1.0 @ 79,990 = 79,990
            // Total = 159,990 / 2.0 = 79,995.00
            const request: FillRequest = {
                symbol: 'BTCUSDT',
                side: 'SELL',
                type: 'MARKET',
                quantity: 2.0,
                signalPrice: 80000,
                timestamp: 1700000000000
            };

            const fill = simulator.simulateFill(request, mockBook);

            expect(fill.simulatedFromBook).toBe(true);
            expect(fill.fillPrice).toBe(79995.00);
            expect(fill.slippage).toBe(5.00);
            expect(fill.feeTier).toBe('TAKER');
            expect(fill.fee).toBeCloseTo(79995 * 2 * 0.00055, 2);
        });

        it('should penalize remainder if order size exceeds total top depth', () => {
            // Total ask depth is 6.0 BTC. Requesting 8.0 BTC:
            // 6.0 filled in book; 2.0 filled with 0.08% adverse extension on worst ask (80,030 * 1.0008)
            const request: FillRequest = {
                symbol: 'BTCUSDT',
                side: 'BUY',
                type: 'MARKET',
                quantity: 8.0,
                signalPrice: 80010,
                timestamp: 1700000000000
            };

            const fill = simulator.simulateFill(request, mockBook);
            expect(fill.simulatedFromBook).toBe(true);
            expect(fill.fillPrice).toBeGreaterThan(80030);
        });
    });

    describe('2. Conservative Tiered Slippage Model (Non-Depth Fallback)', () => {
        it('should apply 0.03% adverse slippage on BTC when no depth book is recorded', () => {
            const request: FillRequest = {
                symbol: 'BTCUSDT',
                side: 'BUY',
                type: 'MARKET',
                quantity: 1.0,
                signalPrice: 80000,
                timestamp: 1700000000000
            };

            const fill = simulator.simulateFill(request, null);

            expect(fill.simulatedFromBook).toBe(false);
            expect(fill.slippagePct).toBe(0.03);
            expect(fill.fillPrice).toBe(80000 * 1.0003);
            expect(fill.feeTier).toBe('TAKER');
        });

        it('should apply 0.12% adverse slippage on unlisted altcoins', () => {
            const request: FillRequest = {
                symbol: 'NEWCOINUSDT',
                side: 'SELL',
                type: 'MARKET',
                quantity: 1000,
                signalPrice: 1.00,
                timestamp: 1700000000000
            };

            const fill = simulator.simulateFill(request, null);

            expect(fill.simulatedFromBook).toBe(false);
            expect(fill.slippagePct).toBe(0.12);
            expect(fill.fillPrice).toBeCloseTo(1.00 * (1 - 0.0012), 4);
        });

        it('should apply maker fee rate when postOnly is specified', () => {
            const request: FillRequest = {
                symbol: 'BTCUSDT',
                side: 'BUY',
                type: 'LIMIT',
                quantity: 1.0,
                signalPrice: 79900,
                timestamp: 1700000000000,
                postOnly: true
            };

            const fill = simulator.simulateFill(request, null);
            expect(fill.feeTier).toBe('MAKER');
            expect(fill.feeRate).toBe(0.00020);
        });
    });
});
