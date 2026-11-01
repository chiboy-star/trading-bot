const fs = require('fs');
const path = require('path');
const { StrategyEngine } = require('../dist/src/strategy/core');

const candlesPath = path.resolve(__dirname, '../research/parity_candles.json');
const outputPath = path.resolve(__dirname, '../research/parity_fixture.json');

const candles = JSON.parse(fs.readFileSync(candlesPath, 'utf8'));

const fixture = [];

for (let i = 25; i < candles.length; i++) {
    const subCandles = candles.slice(0, i + 1);
    const tsResult = StrategyEngine.evaluateEntry(subCandles, undefined, {
        isClosed: true,
        allowShorts: true,
        allowIntrabar: false,
        isExploreMode: false
    });

    fixture.push({
        candle_idx: i,
        timestamp: candles[i].timestamp,
        ts_eval: {
            signal: tsResult.signal,
            direction: tsResult.direction,
            setupType: tsResult.setupType,
            reason: tsResult.reason,
            indicators: {
                currentEmaFast: tsResult.indicators.currentEmaFast,
                currentEmaSlow: tsResult.indicators.currentEmaSlow,
                currentRsi: tsResult.indicators.currentRsi,
                currentAdx: tsResult.indicators.currentAdx,
                currentAtr: tsResult.indicators.currentAtr
            }
        }
    });
}

fs.writeFileSync(outputPath, JSON.stringify({ candles, fixture }, null, 2));
console.log(`Successfully exported ${fixture.length} evaluation points to ${outputPath}`);
