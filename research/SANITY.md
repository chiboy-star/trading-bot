# Backtester Sanity Audit & Benchmark Verification (Phase 1)

**Date:** October 2026  
**Audit Purpose:** Mathematical audit, bug fixes, and baseline verification of the quantitative backtester.

---

## 1. Audit Findings & Bugs Identified

### 1.1 Root Cause of Backtester Bias: Same-Bar Trailing Stop Lookahead
- **Verdict:** **TRUE BUG FOUND & FIXED.**
- **Mechanism:**
  - In the previous code, within each 15-minute bar, the trailing stop was ratcheted using the current bar's `candle_high` (for Longs) before evaluating whether the current bar's `candle_low` breached the stop.
  - As a result, any candle whose range satisfied `candle_high - candle_low >= atr_multiplier * atr` immediately stopped out on its own low intrabar, even if the candle was a large bullish green bar that closed at the high.
  - This intra-bar sequence lookahead caused the zero-cost random-entry baseline to artificially collapse to PF 0.745 and -0.09 R.
- **Correction Implemented:**
  - Enforced strict order per bar:
    1. **(a) Evaluate exits against the stop carried from the PREVIOUS bar (`trailing_stop`)**, including gap-through fills at the open (`min(candle_open, trailing_stop)` for Longs, `max(candle_open, trailing_stop)` for Shorts).
    2. If both stop and take-profit target are touched in the same bar, conservatively assume the worse outcome (stop hit), applied consistently and symmetrically for Longs and Shorts.
    3. **(b) Only if NO exit occurred**, update `highest_price` / `lowest_price` and ratchet the trailing stop using the current bar's high/low for use from the **NEXT bar**.
  - Ported identically to both Python (`research/strategy.py`, `research/backtest.py`) and TypeScript (`src/strategy/core.ts`).

### 1.2 Entry Sizing ATR Lookahead Bug
- **Verdict:** **TRUE BUG FOUND & FIXED.**
- **Mechanism:**
  - When an order filled at `bar_open` of bar $t+1$, the backtester was reading `arrs['atr'][idx]` (the ATR of bar $t+1$, which includes the future high, low, and close of bar $t+1$).
- **Correction Implemented:**
  - Entry sizing and initial stop distance now strictly read `arrs['atr'][sig_idx]` (the ATR of closed bar $t$, index `idx - 1`). Zero lookahead into future price or volatility.

---

## 2. Synthetic Test Benchmarks (Zero-Drift & Unbiased Verification)

All tests automated in `research/synthetic_tests.py` and integrated into CI via `npm test` (`tests/synthetic_benchmarks.test.ts`):

### 2.1 Fixed 1R Stop & 1R Target Benchmark (Zero Cost)
- **Dataset:** 40,000 zero-drift random-walk bars, random entry direction.
- **Trades Evaluated:** 1,284
- **Win Rate:** **50.00%** (Theoretical expectation: 50.0%)
- **Profit Factor:** **1.0000** (Theoretical expectation: 1.000)
- **Expectancy:** **-0.0000 R** (Theoretical expectation: 0.000 R)
- **Status:** **PASS.** Verifies that the order fill and stop/target evaluation logic has zero directional or structural bias.

### 2.2 Random Entry with Trailing Stop on 12 Zero-Drift Symbols (Zero Cost)
- **Dataset:** 12 independent symbols, 30,000 bars each (360,000 bars total) generated via discrete zero-drift random walks.
- **Trades Evaluated:** 13,531
- **Win Rate:** **37.53%**
- **Profit Factor:** **1.061**
- **Expectancy:** **+0.0227 R** (Strictly within required [-0.03 R, +0.03 R] tolerance)
- **Status:** **PASS.** Confirms that on a driftless martingale, the corrected trailing stop engine produces unbiased expectancy within statistical sampling error.

### 2.3 Independent Always-Long BTC Buy & Hold Verification
- **Method:** Evaluated directly from raw parquet files (`BTC_USDT_15m.parquet` and `BTC_USDT_funding.parquet`) outside the backtest engine:
  - Raw Price Return: **+21.27%** ($66,931.00 $\rightarrow$ $81,170.50)
  - Total Taker Fees: **$13.28**
  - Total Slippage Drag: **$11.06**
  - Cumulative 8-Hour Funding Paid: **-$1,457.51** (-14.58% on appreciated notional)
  - Independent Net Return: **+6.46%**
  - Engine Simulation Return: **+6.51%**
- **Status:** **PASS.** Reconciles within 0.05% floating precision.

---

## 3. Real 2-Year Dataset Benchmark Results (Audited & Uncontaminated)

### 3.1 Uncompounded Fixed-Risk Baseline ($200 per 1R Risk, Full 2-Year Run)
- **Total Genuine Trades:** **4,231**
- **True Win Rate:** **29.35%** (1,242 W / 2,989 L)
- **Profit Factor:** **0.61**
- **Average Expectancy:** **-0.18 R per trade**
- **Average Win / Average Loss:** **+$175.97** (+0.88 R) / **-$120.33** (-0.60 R) (Win/Loss ratio: 1.46:1)
- **Net Realized PnL:** **-$141,107.68**
- **Exchange Friction:** Taker Fees: $62,208.74 | Slippage: $70,832.06 | Funding: -$305.46

### 3.2 Zero-Cost Baseline (fees=0, slippage=0, funding=0)
- **Total Trades:** 5,445
- **Win Rate:** **35.26%** (1,919 W / 3,524 L)
- **Profit Factor:** **0.92**
- **Average Expectancy:** **-0.03 R per trade**
- **Net Realized PnL:** -$27,976.17
- **Verdict:** Gross Profit Factor of 0.92 confirms that even without exchange friction, the 15m indicator strategy has slightly negative gross expectancy (-0.03 R).

### 3.3 Random-Entry Monte Carlo (200 Runs, Matched Trade Count)

| Baseline Model | Mean PF | Median PF | 5th Pct | 95th Pct | Mean Win Rate | Mean Expectancy | Real Strategy Location |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Random Entry (Full Cost)** | 0.642 | **0.640** | 0.590 | 0.699 | 30.71% | -0.171 R | **25th percentile** (PF 0.61) |
| **Random Entry (Zero Cost)** | 1.023 | **1.020** | 0.939 | 1.112 | 37.02% | +0.008 R | **4th percentile** (PF 0.92) |

#### Honest Statistical Interpretation:
1. **At Full Cost:** The real strategy's Profit Factor of **0.61** falls well inside the random distribution ([0.59, 0.70], ~25th percentile). The strategy does NOT beat random coin flips, nor is it statistically separated from random entry.
2. **At Zero Cost:** Random entries produce a median Profit Factor of **1.02** with expectancy of **+0.008 R**, matching theoretical martingale expectations. The real strategy's Gross PF of **0.92** falls near the 4th percentile, demonstrating mild adverse selection (lagging EMA crossovers and breakout entries trigger late at local momentum exhaustion).
3. **What This Means:** The lack of edge is conclusively confirmed. The strategy's rules generate zero positive alpha above random entries, and exchange friction (0.06% fees + slippage) degrades both random entries and the strategy into steep unprofitability.

### 3.4 Slippage Monotonicity Sweep (Full 12 Pairs)
- **0.01% (1 bps Core):** PF **0.788**, Win Rate 32.30%, Return -757.1%
- **0.02% (2 bps Core):** PF **0.693**, Win Rate 30.77%, Return -1,082.5%
- **0.05% (5 bps Core):** PF **0.608**, Win Rate 29.35%, Return -1,411.6%
- **Monotonicity:** Confirmed strictly monotonic.
