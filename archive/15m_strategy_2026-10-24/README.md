# Archived 15m Intraday Strategy (Retired 2026-10-24)

## Executive Summary
This directory archives the state, SQLite database (`market_data.db`), and audit reports (`REPORT.md`, `REPORT_V2.md`, `SANITY.md`) of the legacy 15-minute multi-coin trend-following bot.

The 15m intraday strategy has been formally **RETIRED** and its execution permanently disabled via `STRATEGY_PAUSED=true` in code.

---

## Audited Results & Empirical Summary
Under audited backtesting across the complete historical 15m dataset (accounting for realistic exchange friction: 5.5 bps taker fee per side, slippage, and bidirectional funding costs):

- **Trades Evaluated:** 4,188 trades
- **Fixed-Risk Profit Factor (PF):** 0.41
- **Expectancy:** -0.28R per trade
- **Net Cumulative Return:** Heavily negative after exchange transaction friction.
- **Pre-registered Hypotheses Outcome:** Failed all 5 pre-registered hypotheses (H1–H5):
  - *H1 (15m Multi-Indicator Convergence):* Failed (PF 0.41, zero predictive alpha on 15m noise).
  - *H2 (Daily Trend Filter / 200 EMA):* Failed (Did not improve expectancy on intraday reversals).
  - *H3 (Cross-Sectional Momentum Ranking):* Failed (Turnover and friction eliminated theoretical gains).
  - *H4 (Funding Rate Carry Fade):* Failed (Funding differentials insufficient to overcome taker spread).
  - *H5 (BTC Macro Trend Regime Gate):* Failed (Macro gating reduced trade count but expectancy remained negative).

---

## Rationale for Retirement
1. **Severe Survivorship Bias in Delisted Contracts:** Bybit permanently purges delisted contracts from historical REST endpoints. Any backtest relying on survivorship-biased surviving tokens systematically miscalculates tail risk and drawdown.
2. **Exchange Friction Dominance on 15m Timeframe:** With 11 bps round-trip taker fees and slippage on volatile crypto perps, intraday technical indicator crossovers generate excessive turnover with negative net expectancy.
3. **Strategic Pivot to Forward-Recorded Unbiased Data:** Antigravity development has pivoted to recording forward-looking, high-frequency, survivorship-unbiased market data (`src/recorder/`) to evaluate hypotheses with genuine structural edge (Hypothesis H-A: New Listing Liquidity Dislocation; Hypothesis H-B: Liquidation Cascade Mean Reversion).

---

## Reusable Components Preserved in Shared Codebase
The following robust components developed during this phase have been audited, decoupled, and preserved as shared infrastructure:
- **Risk Management Engine (`src/core/RiskManager.ts`):** Adaptive risk sizing, 6% total portfolio open risk cap, and ATR-based stop calculations.
- **Paper Fill Simulator (`src/simulation/PaperFillSimulator.ts`):** Conservative fill models incorporating limit order depth, slippage penalties, and maker/taker fee accounting.
- **Telegram / Webhook Notifier (`src/services/notifier.ts`):** Asynchronous alerting and heartbeat dispatching.
- **Parity Test Suite (`tests/parity.test.ts`):** Cross-language verification ensuring numerical parity between Python research and TypeScript execution environments.
