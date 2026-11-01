import crypto from 'crypto';
import { SignalEvent } from './types';

// Pre-registered locked parameter dictionaries
export const LOCKED_HA_PARAMS = {
    hypothesis: 'H-A',
    trial: 52,
    discoveryWindowBars: 12, // 12 x 5m = 60 minutes
    triggerWindowMinMinutes: 60,
    triggerWindowMaxMinutes: 360, // 6 hours
    targetMultiplierR: 2.0,
    atrMultiplierStop: 2.0,
    atrPeriod: 14,
    maxHoldMinutes: 1440 // 24 hours
};

export const LOCKED_HB_PARAMS = {
    hypothesis: 'H-B',
    trial: 53,
    clusterWindowMinutes: 5,
    btcLiqVolumeThresholdUsd: 1500000,
    ethLiqVolumeThresholdUsd: 750000,
    oiContractionPctThreshold: -1.5,
    priceExtensionAtrMultiplier: 1.8,
    targetMultiplierR: 1.5,
    stopAtrBufferMultiplier: 0.3,
    atrPeriod: 14,
    maxHoldMinutes: 45
};

export function computeParamsHash(params: Record<string, any>): string {
    const serialized = JSON.stringify(params, Object.keys(params).sort());
    return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}

export const HA_PARAMS_HASH = computeParamsHash(LOCKED_HA_PARAMS);
export const HB_PARAMS_HASH = computeParamsHash(LOCKED_HB_PARAMS);

export interface Bar5m {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface Bar1m {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export class SignalDetectorV3 {
    public readonly runId: string;

    constructor(runId?: string) {
        this.runId = runId || `RUN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Detector for H-A: New-Listing Initial Supply Overhang Breakdown
     * Evaluated on 5m candles.
     */
    public detectListingBreakdown(
        symbol: string,
        launchTime: number,
        bars5m: Bar5m[],
        currentBarIndex: number,
        atr14: number
    ): SignalEvent | null {
        // Need at least 12 bars (60m) to establish discovery range
        if (bars5m.length < LOCKED_HA_PARAMS.discoveryWindowBars || currentBarIndex < LOCKED_HA_PARAMS.discoveryWindowBars) {
            return null;
        }

        const currentBar = bars5m[currentBarIndex];
        const elapsedMinutes = (currentBar.timestamp - launchTime) / (60 * 1000);

        // Must be within hours 1 to 6 post-listing
        if (elapsedMinutes < LOCKED_HA_PARAMS.triggerWindowMinMinutes || elapsedMinutes > LOCKED_HA_PARAMS.triggerWindowMaxMinutes) {
            return null;
        }

        // Establish 60m discovery range [H_init, L_init] and VWAP
        const discoveryBars = bars5m.slice(0, LOCKED_HA_PARAMS.discoveryWindowBars);
        let hInit = -Infinity;
        let lInit = Infinity;
        let cumulativeTypicalVol = 0;
        let cumulativeVol = 0;

        for (const b of discoveryBars) {
            if (b.high > hInit) hInit = b.high;
            if (b.low < lInit) lInit = b.low;
            const typical = (b.high + b.low + b.close) / 3;
            cumulativeTypicalVol += typical * b.volume;
            cumulativeVol += b.volume;
        }

        const vwapInit = cumulativeVol > 0 ? (cumulativeTypicalVol / cumulativeVol) : ((hInit + lInit) / 2);

        // Short Entry Trigger: 5m Close below discovery Low AND below discovery VWAP
        if (currentBar.close < lInit && currentBar.close < vwapInit) {
            const stopPrice = Math.min(vwapInit, currentBar.close + LOCKED_HA_PARAMS.atrMultiplierStop * atr14);
            const riskR = parseFloat((stopPrice - currentBar.close).toFixed(6));

            if (riskR <= 0) return null; // Invalidation

            const targetPrice = parseFloat((currentBar.close - LOCKED_HA_PARAMS.targetMultiplierR * riskR).toFixed(6));

            return {
                runId: this.runId,
                paramsHash: HA_PARAMS_HASH,
                hypothesis: 'H-A',
                symbol,
                direction: 'SHORT',
                timestamp: currentBar.timestamp,
                signalPrice: currentBar.close,
                initialStopPrice: parseFloat(stopPrice.toFixed(6)),
                targetPrice,
                riskUnitsR: riskR,
                metrics: {
                    hInit,
                    lInit,
                    vwapInit: parseFloat(vwapInit.toFixed(6)),
                    atr14,
                    elapsedMinutes
                }
            };
        }

        return null;
    }

    /**
     * Detector for H-B: Liquidation Cascade Exhaustion Snapback
     * Evaluated on 1m candles.
     */
    public detectLiquidationExhaustion(
        symbol: string,
        rolling5mLiqVolumeUsd: number,
        rolling5mOiChangePct: number,
        currentBar: Bar1m,
        prevBar: Bar1m,
        cascadeLow: number,
        atr14: number
    ): SignalEvent | null {
        const isBtc = symbol.toUpperCase() === 'BTCUSDT';
        const isEth = symbol.toUpperCase() === 'ETHUSDT';

        if (!isBtc && !isEth) return null;

        const volumeThreshold = isBtc ? LOCKED_HB_PARAMS.btcLiqVolumeThresholdUsd : LOCKED_HB_PARAMS.ethLiqVolumeThresholdUsd;

        // 1. Check liquidation cluster volume
        if (rolling5mLiqVolumeUsd < volumeThreshold) {
            return null;
        }

        // 2. Check Open Interest contraction
        if (rolling5mOiChangePct > LOCKED_HB_PARAMS.oiContractionPctThreshold) {
            return null;
        }

        // 3. Exhaustion confirmation candle: first green 1m candle closing above prior high
        const isGreen = currentBar.close > currentBar.open;
        const brokePriorHigh = currentBar.close > prevBar.high;

        if (isGreen && brokePriorHigh) {
            const stopPrice = parseFloat((cascadeLow - LOCKED_HB_PARAMS.stopAtrBufferMultiplier * atr14).toFixed(6));
            const riskR = parseFloat((currentBar.close - stopPrice).toFixed(6));

            if (riskR <= 0) return null;

            const targetPrice = parseFloat((currentBar.close + LOCKED_HB_PARAMS.targetMultiplierR * riskR).toFixed(6));

            return {
                runId: this.runId,
                paramsHash: HB_PARAMS_HASH,
                hypothesis: 'H-B',
                symbol,
                direction: 'LONG',
                timestamp: currentBar.timestamp,
                signalPrice: currentBar.close,
                initialStopPrice: stopPrice,
                targetPrice,
                riskUnitsR: riskR,
                metrics: {
                    rolling5mLiqVolumeUsd,
                    rolling5mOiChangePct,
                    cascadeLow,
                    atr14
                }
            };
        }

        return null;
    }
}
