import { describe, it, expect } from 'vitest';
import {
    SignalDetectorV3,
    LOCKED_HA_PARAMS,
    LOCKED_HB_PARAMS,
    HA_PARAMS_HASH,
    HB_PARAMS_HASH,
    computeParamsHash,
    Bar5m,
    Bar1m
} from '../src/simulation/signals_v3';

describe('Hypotheses V3 Signal Detectors Suite (Synthetic Data)', () => {
    const detector = new SignalDetectorV3('TEST_RUN_001');

    describe('1. Parameter Version Hashing & Anti-Tamper Invariance', () => {
        it('should generate deterministic 16-character hex hashes for locked parameter dictionaries', () => {
            expect(HA_PARAMS_HASH.length).toBe(16);
            expect(HB_PARAMS_HASH.length).toBe(16);

            // Re-computing with identical params yields exact same hash
            expect(computeParamsHash(LOCKED_HA_PARAMS)).toBe(HA_PARAMS_HASH);
            expect(computeParamsHash(LOCKED_HB_PARAMS)).toBe(HB_PARAMS_HASH);
        });

        it('should change hash if any parameter is altered (anti-tuning guard)', () => {
            const tamperedHa = { ...LOCKED_HA_PARAMS, targetMultiplierR: 2.1 };
            expect(computeParamsHash(tamperedHa)).not.toBe(HA_PARAMS_HASH);

            const tamperedHb = { ...LOCKED_HB_PARAMS, btcLiqVolumeThresholdUsd: 1400000 };
            expect(computeParamsHash(tamperedHb)).not.toBe(HB_PARAMS_HASH);
        });
    });

    describe('2. Hypothesis A (H-A): New-Listing Supply Overhang Breakdown', () => {
        const launchTime = 1700000000000;
        const interval5m = 5 * 60 * 1000;

        // Generate 12 initial bars (minutes 0 to 60) establishing range: High = 10.0, Low = 8.0, VWAP ~ 9.0
        const synthetic5mBars: Bar5m[] = [];
        for (let i = 0; i < 12; i++) {
            synthetic5mBars.push({
                timestamp: launchTime + i * interval5m,
                open: 9.0,
                high: 10.0,
                low: 8.0,
                close: 9.0,
                volume: 1000
            });
        }

        it('should reject signal if fewer than 12 discovery bars are present', () => {
            const shortBars = synthetic5mBars.slice(0, 10);
            const signal = detector.detectListingBreakdown('NEWUSDT', launchTime, shortBars, 9, 0.5);
            expect(signal).toBeNull();
        });

        it('should reject signal if price remains inside discovery range', () => {
            // Bar 12 (T+60m) closes at 8.50 (above Low 8.0)
            const bars = [...synthetic5mBars, {
                timestamp: launchTime + 12 * interval5m,
                open: 8.6,
                high: 8.8,
                low: 8.4,
                close: 8.5,
                volume: 1000
            }];
            const signal = detector.detectListingBreakdown('NEWUSDT', launchTime, bars, 12, 0.5);
            expect(signal).toBeNull();
        });

        it('should trigger Short entry on breakdown below discovery low and VWAP within hours 1 to 6', () => {
            // Bar 14 (T+70m) closes at 7.50 (< Low 8.0 and < VWAP 9.0)
            const bars = [...synthetic5mBars,
                { timestamp: launchTime + 12 * interval5m, open: 8.5, high: 8.7, low: 8.1, close: 8.2, volume: 1000 },
                { timestamp: launchTime + 13 * interval5m, open: 8.2, high: 8.3, low: 7.8, close: 7.9, volume: 1000 },
                { timestamp: launchTime + 14 * interval5m, open: 7.9, high: 8.0, low: 7.4, close: 7.5, volume: 2000 }
            ];

            const atr14 = 0.5;
            const signal = detector.detectListingBreakdown('NEWUSDT', launchTime, bars, 14, atr14);

            expect(signal).not.toBeNull();
            expect(signal?.hypothesis).toBe('H-A');
            expect(signal?.direction).toBe('SHORT');
            expect(signal?.signalPrice).toBe(7.50);
            expect(signal?.paramsHash).toBe(HA_PARAMS_HASH);
            expect(signal?.runId).toBe('TEST_RUN_001');

            // Initial Stop = min(VWAP 9.0, Close 7.5 + 2*0.5 = 8.5) -> 8.50
            expect(signal?.initialStopPrice).toBe(8.50);
            // 1.0 R = 8.50 - 7.50 = 1.00
            expect(signal?.riskUnitsR).toBe(1.00);
            // Target (+2.0 R) = 7.50 - 2.0 * 1.00 = 5.50
            expect(signal?.targetPrice).toBe(5.50);
        });

        it('should reject signal if breakdown occurs after hour 6 post-listing', () => {
            // Minute 400 is > 360m (hour 6.67)
            const lateBarIndex = 80;
            const bars = [...synthetic5mBars];
            for (let i = 12; i <= lateBarIndex; i++) {
                bars.push({
                    timestamp: launchTime + i * interval5m,
                    open: 7.8,
                    high: 7.9,
                    low: 7.4,
                    close: 7.5,
                    volume: 1000
                });
            }

            const signal = detector.detectListingBreakdown('NEWUSDT', launchTime, bars, lateBarIndex, 0.5);
            expect(signal).toBeNull();
        });
    });

    describe('3. Hypothesis B (H-B): Liquidation Cascade Exhaustion Snapback', () => {
        const cascadeLow = 79000;
        const atr14 = 500;

        const prevBar: Bar1m = {
            timestamp: 1700000000000,
            open: 79500,
            high: 79600,
            low: 79000,
            close: 79100, // sharp selloff
            volume: 50
        };

        const greenConfirmationBar: Bar1m = {
            timestamp: 1700000060000,
            open: 79100,
            high: 79700,
            low: 79050,
            close: 79650, // Green, closes above prevBar.high (79600)
            volume: 80
        };

        it('should trigger Long entry when all cluster thresholds and green confirmation bar are met', () => {
            const signal = detector.detectLiquidationExhaustion(
                'BTCUSDT',
                2000000, // $2.0M > $1.5M threshold
                -2.2,    // -2.2% < -1.5% threshold
                greenConfirmationBar,
                prevBar,
                cascadeLow,
                atr14
            );

            expect(signal).not.toBeNull();
            expect(signal?.hypothesis).toBe('H-B');
            expect(signal?.direction).toBe('LONG');
            expect(signal?.signalPrice).toBe(79650);
            expect(signal?.paramsHash).toBe(HB_PARAMS_HASH);

            // Stop = cascadeLow (79000) - 0.3 * 500 = 78850
            expect(signal?.initialStopPrice).toBe(78850);
            // 1.0 R = 79650 - 78850 = 800
            expect(signal?.riskUnitsR).toBe(800);
            // Target (+1.5 R) = 79650 + 1.5 * 800 = 80850
            expect(signal?.targetPrice).toBe(80850);
        });

        it('should reject signal if liquidation volume is below threshold', () => {
            const signal = detector.detectLiquidationExhaustion(
                'BTCUSDT',
                1200000, // $1.2M < $1.5M hurdle
                -2.2,
                greenConfirmationBar,
                prevBar,
                cascadeLow,
                atr14
            );
            expect(signal).toBeNull();
        });

        it('should reject signal if open interest contraction is insufficient', () => {
            const signal = detector.detectLiquidationExhaustion(
                'BTCUSDT',
                2000000,
                -0.8, // -0.8% > -1.5% hurdle
                greenConfirmationBar,
                prevBar,
                cascadeLow,
                atr14
            );
            expect(signal).toBeNull();
        });

        it('should reject signal if confirmation candle is red', () => {
            const redBar: Bar1m = {
                timestamp: 1700000060000,
                open: 79650,
                high: 79700,
                low: 79050,
                close: 79100, // Red
                volume: 80
            };

            const signal = detector.detectLiquidationExhaustion(
                'BTCUSDT',
                2000000,
                -2.2,
                redBar,
                prevBar,
                cascadeLow,
                atr14
            );
            expect(signal).toBeNull();
        });

        it('should reject signal if green candle fails to break above prior high', () => {
            const weakGreenBar: Bar1m = {
                timestamp: 1700000060000,
                open: 79100,
                high: 79400,
                low: 79050,
                close: 79300, // Green, but < prevBar.high (79600)
                volume: 80
            };

            const signal = detector.detectLiquidationExhaustion(
                'BTCUSDT',
                2000000,
                -2.2,
                weakGreenBar,
                prevBar,
                cascadeLow,
                atr14
            );
            expect(signal).toBeNull();
        });

        it('should reject signal on un-eligible altcoins (only BTC and ETH permitted for H-B)', () => {
            const signal = detector.detectLiquidationExhaustion(
                'SOLUSDT', // Not eligible for H-B
                2000000,
                -2.2,
                greenConfirmationBar,
                prevBar,
                cascadeLow,
                atr14
            );
            expect(signal).toBeNull();
        });
    });
});
