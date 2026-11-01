# Quantitative Crypto Trading Platform & Bybit Market Data Recorder

> [!CAUTION]
> **OPERATIONAL SAFETY DIRECTIVE:** `EXECUTION_MODE` is strictly locked to `PAPER`. Live trading is forbidden. Live execution requires explicit written operator approval following full review of forward-recorded statistical validation.

---

## 1. Strategy Status & Deprecation Notice

### ⚠️ Legacy 15m Strategy: DEPRECATED & RETIRED
The legacy 15-minute multi-coin directional trend-following strategy (`src/live_runner.ts`) is **DEPRECATED** and permanently retired.

- **Enforcement:** `STRATEGY_PAUSED=true` is enforced by default in `src/config.ts` and hard-coded at entry execution in `src/live_runner.ts` (`executeEntry`), preventing new positions from opening even if the runner is accidentally executed.
- **Audited Backtest Results:**
  - Evaluated trades: 4,188 trades across linear perpetual markets.
  - Fixed-risk Profit Factor (PF): **0.41**
  - Expectancy: **-0.28R** per trade
  - Failed all 5 pre-registered hypotheses (H1 indicators, H2 daily trend filter, H3 momentum ranking, H4 funding fade, H5 BTC macro regime gate).
- **Survivorship Bias in Delisted Contracts:** Bybit permanently purges delisted contracts from historical REST endpoints, meaning historical backtests on surviving tokens are survivorship-biased.
- **Archive:** Historical database and audited reports are preserved under [archive/15m_strategy_2026-10-24/](file:///c:/Users/chine/Downloads/trading-bot/archive/15m_strategy_2026-10-24/).

---

## 2. Reusable Shared Components

The following audited, production-grade components have been decoupled and preserved as shared infrastructure:

1. **Risk Management Engine ([RiskManager.ts](file:///c:/Users/chine/Downloads/trading-bot/src/core/RiskManager.ts)):**
   - Dynamic volatility-adjusted position sizing with leverage constraints.
   - Total portfolio open risk cap (hard-capped at 6% of total equity).
   - Dynamic ATR-based trailing stop calculations and circuit breakers.
2. **Paper Fill Simulator ([PaperFillSimulator.ts](file:///c:/Users/chine/Downloads/trading-bot/src/simulation/PaperFillSimulator.ts)):**
   - Realistic exchange simulation with depth checks, taker fee accounting (5.5 bps), and liquidity-adjusted adverse slippage.
3. **Alerting & Notification Service ([notifier.ts](file:///c:/Users/chine/Downloads/trading-bot/src/services/notifier.ts)):**
   - Asynchronous webhook/notifier for trade executions, heartbeats, and circuit breaker activations.
4. **Parity Testing Framework ([parity.test.ts](file:///c:/Users/chine/Downloads/trading-bot/tests/parity.test.ts)):**
   - Cross-language mathematical assertions ensuring exact numerical parity between Python research and TypeScript production execution.

---

## 3. Active Forward-Looking System Architecture

### High-Frequency Bybit Market Data Recorder (`src/recorder/`)
To eliminate survivorship bias, the active focus is forward-recording complete, tick-level, unbiased exchange data:
- **Coverage:** All 808+ active Bybit linear contracts.
- **Data Streams:** 1-minute OHLCV klines, funding rates, open interest, real-time liquidation clusters, and orderbook depth (top 25 levels for BTC, ETH, and new listings $<72\text{h}$).
- **WebSocket Sharding:** 9 parallel WebSocket shards dynamically load-balanced under Bybit's per-connection limits.
- **Immutability:** SQLite database in WAL mode (`data/recorder.db`) with row-level append-only triggers preventing mutation or deletion.
- **Pre-Registered Hypotheses:** [HYPOTHESES_V3.md](file:///c:/Users/chine/Downloads/trading-bot/research/HYPOTHESES_V3.md) (Hypothesis H-A: New Listing Liquidity Dislocation; Hypothesis H-B: Liquidation Cascade Mean Reversion).

### Operator Dashboards
- **Main Trading Dashboard:** `http://127.0.0.1:3000/` (Paper trading portfolio overview, equity curve, circuit breakers).
- **Recorder Status Page:** `http://127.0.0.1:3000/recorder` (Strictly read-only WAL-safe monitor: stream health, WebSocket shards, table row counts, worst 20 kline coverage, gaps/outages, DNS failures, liquidation velocity, and disk growth).
- **Control Security:** Protected endpoints (`/api/control`) require `Authorization: Bearer <CONTROL_API_KEY>` or `x-api-key`.

---

## 4. Key Commands

```bash
# Build TypeScript codebase
npm run build

# Run unit and integration test suite
npm test

# Launch high-frequency market data recorder
npm run recorder

# Generate recorder data quality audit summary
npm run recorder:summary

# Launch Next.js operator dashboard (bound to 127.0.0.1)
npm run dashboard:dev

# Build Next.js operator dashboard for production
npm run dashboard:build
```
