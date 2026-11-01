# Quantitative Strategy Validation & Research Report

**Version:** 3.0 (Audited, Lookahead-Free & Parity Verified)  
**Date:** October 2026  
**Dataset:** 2 Years (October 2024 – October 2026), 15-minute OHLCV, 12 Cryptocurrency Pairs (7 Core + 5 Satellite)  
**Execution Environment:** Python Research Workspace (`/research`), 100% parity verified against TypeScript engine (`src/strategy/core.ts`)  
**Cost Model:** Bybit Taker Fees (0.06%), Liquidity Slippage (0.05% Core, 0.12% Satellite), 8-Hour Funding Rates  

---

## 1. Executive Verdict

### **Does this 15-minute strategy have an edge after costs?**
# **NO.**

Following deep institutional audits of the backtesting engine, elimination of intra-bar same-candle lookahead bugs, and full synthetic martingale validation:
- **Capital Depletion:** Under compounding risk, the strategy loses 100% of capital ($10,000 $\rightarrow$ ruin), failing to survive beyond early months.
- **Uncompounded Full 2-Year Horizon:** Across 70,134 bars on 12 pairs in clean fixed-risk mode ($200 per 1R trade), the strategy executed **4,231 genuine trades**, generating a **Profit Factor of 0.61** and an average expectancy of **-0.18 R per trade**.
- **True Win Rate:** Across all 4,231 trades, the win rate is **29.35%** (1,242 wins / 2,989 losses).
- **Average Win & Loss:** Average win is **+$175.97** (+0.88 R) and average loss is **-$120.33** (-0.60 R) (Win/Loss payout ratio: 1.46:1).
- **Gross Alpha Audit (Zero-Cost Baseline):** With zero fees, zero slippage, and zero funding, the strategy produced a **Gross Profit Factor of 0.92** and an expectancy of **-0.03 R**, confirming that even before exchange friction, the indicators generate zero positive alpha.
- **Random-Entry Monte Carlo (200 Runs):** 
  - At full cost, random coin-flip entries produced a median PF of **0.640** ([0.590, 0.699]). The real strategy (PF 0.61) falls within the random distribution (~25th percentile).
  - At zero cost, random coin-flip entries produced a median PF of **1.020** with **+0.008 R** expectancy. The real strategy (PF 0.92) falls near the 4th percentile due to slight adverse selection from lagging indicators buying local exhaustion tops.
- **Walk-Forward Failure:** Across all 6 rolling Out-of-Sample Walk-Forward windows, **100% of windows failed** (OOS Profit Factors ranged from 0.40 to 0.86, never reaching 1.0).
- **Parameter Sensitivity:** Parameter sweeps across ATR multipliers ($1.8\times$ to $3.8\times$) and ADX thresholds ($16$ to $28$) confirmed failure across all combinations, with profit factors never exceeding 0.86.

---

## 2. Baseline Performance Overview

### 2.1 Uncompounded Fixed-Risk Baseline (Full 2-Year Dataset)
*Evaluated with fixed $200 per 1R risk without compounding, allowing uncorrupted measurement of statistical expectancy across all 70,134 bars:*

| Metric | Fixed-Risk Baseline (15m Full 2-Yr) | Zero-Cost Baseline (Fees=0, Slip=0) | Benchmark (BTC Buy & Hold) | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Initial Capital Basis** | $10,000.00 | $10,000.00 | $10,000.00 | — |
| **Net Realized PnL** | **-$141,107.68** | **-$27,976.17** | **+$645.64** | Catastrophic loss |
| **Total Genuine Trades** | **4,231** | **5,445** | 1 | Uncontaminated |
| **True Win Rate** | **29.35%** (1,242 W / 2,989 L) | **35.26%** (1,919 W / 3,524 L) | N/A | Sub-statistical |
| **Profit Factor** | **0.61** | **0.92** | N/A | Structurally negative |
| **Average Expectancy (R)** | **-0.18 R** | **-0.03 R** | N/A | Monotonically losing |
| **Average Win / Avg Loss** | **$175.97 / $120.33** | **$166.57 / $98.67** | N/A | Win/Loss ratio 1.46:1 |
| **Total Taker Fees Paid** | **$62,208.74** | $0.00 | ~$13.28 | 622% of initial capital |
| **Total Slippage Incurred** | **$70,832.06** | $0.00 | ~$11.06 | 708% of initial capital |
| **Total Funding Payments** | **-$305.46** | -$305.46 | -$1,457.51 | Net funding paid |
| **Combined Friction** | **$133,346.26** | **$0.00** | ~$24.34 | Massive drag |

---

## 3. Per-Playbook Breakdown (Fixed-Risk 2-Year Run)

| Playbook Setup | Trades | Win Rate | Net PnL | Profit Factor | Avg Expectancy (R) | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Playbook A: TREND_PULLBACK** | 2,585 | 29.48% | -$80,527.77 | 0.64 | **-0.16 R** | Negative Edge |
| **Playbook B: EMA_CROSSOVER** | 612 | 28.76% | -$21,871.16 | 0.60 | **-0.18 R** | Whipsawed |
| **Playbook C: EXTREME_RSI_REVERSAL** | 364 | 31.04% | -$9,013.97 | 0.55 | **-0.25 R** | Severe Loss |
| **Fallback: VOLATILITY_BREAKOUT** | 670 | 28.51% | -$29,694.78 | 0.54 | **-0.22 R** | Severe Loss |

### Playbook Insights:
1. **Playbook A (`TREND_PULLBACK`):** Dominates volume (61% of all trades). Despite strict RSI bounce filters ($35 \le RSI \le 55$ for Longs, $45 \le RSI \le 65$ for Shorts), price pullbacks on 15m charts regularly resume the counter-trend move or get stopped out in chop, yielding PF 0.64.
2. **Playbook B (`EMA_CROSSOVER`):** Moving average crossover on 15m bars enters late. Fast EMA crossing Slow EMA triggers after the bulk of the short-term swing has completed, capturing small gains while suffering full stop-outs on whipsaws.
3. **Playbook C (`EXTREME_RSI_REVERSAL`):** Scalp attempts to catch exhaustion extremes on RSI (<22 or >78) fail because strong 15m momentum continuation pushes past the 1.2*ATR stop before reaching the 2.0*ATR target.
4. **Fallback (`VOLATILITY_BREAKOUT`):** 10-candle breakout with rising ADX buys local tops and sells local bottoms during false breakouts in range-bound environments.

---

## 4. Per-Symbol Breakdown (Fixed-Risk 2-Year Run)

| Symbol | Market Tier | Trades | Win Rate | Net PnL | Profit Factor | Avg Expectancy (R) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **SUI_USDT** | CORE | 333 | 30.33% | -$3,691.84 | 0.86 | -0.07 R |
| **XRP_USDT** | CORE | 378 | 31.22% | -$8,048.50 | 0.74 | -0.13 R |
| **STRK_USDT** | SATELLITE | 353 | 33.99% | -$7,386.93 | 0.73 | -0.12 R |
| **SOL_USDT** | CORE | 369 | 27.37% | -$9,738.38 | 0.69 | -0.14 R |
| **Q_USDT** | SATELLITE | 245 | 29.39% | -$7,604.39 | 0.64 | -0.16 R |
| **DOGE_USDT** | CORE | 397 | 30.73% | -$11,529.44 | 0.61 | -0.15 R |
| **TIA_USDT** | SATELLITE | 346 | 26.88% | -$13,375.09 | 0.57 | -0.21 R |
| **ALT_USDT** | SATELLITE | 408 | 26.96% | -$15,945.70 | 0.57 | -0.20 R |
| **AKE_USDT** | SATELLITE | 213 | 33.33% | -$7,022.39 | 0.57 | -0.16 R |
| **1000PEPE_USDT** | CORE | 396 | 31.57% | -$15,245.57 | 0.53 | -0.19 R |
| **ETH_USDT** | CORE | 400 | 29.25% | -$17,271.24 | 0.51 | -0.24 R |
| **BTC_USDT** | CORE | 393 | 23.41% | -$24,248.21 | 0.39 | -0.33 R |

*Note: All 12 symbols generated net losses across the 2-year testing window. Even high-liquidity pairs (BTC, ETH) suffered heavy drag from 15m whipsaw and trading friction.*

---

## 5. Walk-Forward Analysis (Rolling In-Sample vs Out-of-Sample)

Tested across 6 rolling windows (6 months In-Sample training, 3 months Out-of-Sample testing) under clean fixed-risk mode:

| Window | In-Sample (Train) Period | Out-of-Sample (Test) Period | IS Trades | IS Win Rate | IS PF | OOS Trades | OOS Win Rate | OOS PF | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **W1** | 2024-10 to 2025-04 | 2025-04 to 2025-07 | 1,112 | 32.9% | 0.84 | 507 | 27.0% | 0.45 | **FAIL** |
| **W2** | 2025-01 to 2025-07 | 2025-07 to 2025-10 | 1,063 | 29.4% | 0.60 | 528 | 30.1% | 0.67 | **FAIL** |
| **W3** | 2025-04 to 2025-10 | 2025-10 to 2026-01 | 1,005 | 26.4% | 0.44 | 514 | 26.8% | 0.40 | **FAIL** |
| **W4** | 2025-07 to 2026-01 | 2026-01 to 2026-04 | 1,052 | 28.9% | 0.55 | 541 | 30.3% | 0.86 | **FAIL** |
| **W5** | 2025-10 to 2026-04 | 2026-04 to 2026-07 | 1,053 | 28.0% | 0.61 | 484 | 26.7% | 0.45 | **FAIL** |
| **W6** | 2026-01 to 2026-07 | 2026-07 to 2026-10 | 1,039 | 29.7% | 0.69 | 491 | 27.5% | 0.46 | **FAIL** |

### Walk-Forward Findings:
- **100% Out-of-Sample Failure Rate:** Not a single out-of-sample window produced a Profit Factor $\ge 1.0$ (OOS Profit Factors averaged 0.55).
- **Consistent In-Sample and Out-of-Sample Win Rates:** In-sample win rates averaged 29.2% and out-of-sample win rates averaged 28.1%. The previous contaminated report's anomaly (IS win rates 9-18% vs OOS 18-32%) was completely eliminated by fixing post-ruin ghost trades.

---

## 6. Sensitivity Analysis (Monotonicity & Parameter Sweeps)

### 6.1 ATR Multiplier Sweep (Base = 2.8)
| ATR Multiplier | Trades | Win Rate | Profit Factor | Net Return (Fixed Risk) | Avg Expectancy (R) | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1.8** | 4,178 | 27.87% | 0.51 | -1,851.9% | -0.24 R | High Churn |
| **2.2** | 4,346 | 29.99% | 0.58 | -1,577.3% | -0.20 R | Whipsawed |
| **2.8 (Base)** | 4,231 | 29.35% | 0.61 | -1,411.6% | -0.18 R | Baseline |
| **3.2** | 4,330 | 29.10% | 0.68 | -1,129.8% | -0.14 R | Whipsawed |
| **3.8** | 4,414 | 30.56% | 0.86 | -480.5% | -0.07 R | Highest PF, Still Losing |

### 6.2 ADX Threshold Sweep (Base = 20.0)
| ADX Threshold | Trades | Win Rate | Profit Factor | Net Return (Fixed Risk) | Avg Expectancy (R) | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **16.0** | 4,458 | 30.39% | 0.64 | -1,275.3% | -0.15 R | Over-trading |
| **20.0 (Base)** | 4,231 | 29.35% | 0.61 | -1,411.6% | -0.18 R | Baseline |
| **24.0** | 4,074 | 27.88% | 0.53 | -1,678.6% | -0.22 R | Negative Edge |
| **28.0** | 4,151 | 29.06% | 0.57 | -1,509.0% | -0.20 R | Late Momentum Entry |

### 6.3 Slippage Monotonicity Sweep (Full 12 Pairs)
| Core Slippage | Satellite Slippage | Trades | Win Rate | Profit Factor | Total Return (Fixed Risk) | Fees Paid | Slippage Cost |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **0.01% (1 bps)** | 0.024% (2.4 bps) | 4,726 | 32.30% | **0.788** | -757.1% | $70,448 | $15,991 |
| **0.02% (2 bps)** | 0.048% (4.8 bps) | 4,550 | 30.77% | **0.693** | -1,082.5% | $67,589 | $30,842 |
| **0.05% (5 bps)** | 0.120% (12.0 bps) | 4,231 | 29.35% | **0.608** | -1,411.6% | $62,209 | $70,832 |

- **Monotonicity:** Confirmed strictly monotonic. Each increase in execution friction proportionally reduces Win Rate, Profit Factor, and Net Return.

---

## 7. Random-Entry Monte Carlo Baseline (200 Runs)

*Matched to real strategy volume (~4,200 trades across 12 pairs):*

| Simulation Baseline | Mean PF | Median PF | 5th Percentile | 95th Percentile | Mean Win Rate | Mean Expectancy | Real Strategy Location |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Random Entry (Full Cost)** | 0.642 | **0.640** | 0.590 | 0.699 | 30.71% | -0.171 R | **25th percentile** (PF 0.61) |
| **Real Strategy (Full Cost)** | 0.608 | **0.608** | — | — | 29.35% | -0.180 R | Inside distribution |
| **Random Entry (Zero Cost)** | 1.023 | **1.020** | 0.939 | 1.112 | 37.02% | +0.008 R | — |
| **Real Strategy (Zero Cost)** | 0.920 | **0.920** | — | — | 35.26% | -0.030 R | Near 4th percentile |

### Statistical Takeaways:
1. **At Full Cost:** The real strategy's Profit Factor of **0.608** sits comfortably within the random entry distribution ([0.590, 0.699], ~25th percentile). The strategy's rules generate performance indistinguishable from random noise under friction.
2. **At Zero Cost:** Random entries produce a median Profit Factor of **1.020** with **+0.008 R** expectancy, confirming the backtesting engine is mathematically unbiased on random series. The real strategy scores **0.920** at zero cost, falling near the 4th percentile due to adverse selection from lagging indicators.

---

## 8. Synthetic Engine Validation & Parity Testing

- **Vitest Parity Suite:** [`tests/parity.test.ts`](file:///c:/Users/chine/Downloads/trading-bot/tests/parity.test.ts) — **100.00% assertion parity** (475/475 closed bars) between TypeScript engine (`src/strategy/core.ts`) and Python research strategy (`research/strategy.py`).
- **Vitest Synthetic Suite:** [`tests/synthetic_benchmarks.test.ts`](file:///c:/Users/chine/Downloads/trading-bot/tests/synthetic_benchmarks.test.ts) — Fully automated CI test:
  - Fixed 1R random entry test: PF = 1.0000, Win Rate = 50.00%, Expectancy = -0.0000 R.
  - Zero-drift random walk 12-symbol portfolio: Expectancy = +0.0227 R (strictly within [-0.03 R, +0.03 R]).
  - Independent BTC Buy & Hold: 6.46% net return, reconciling within 0.05% floating precision.

---

## 9. Explicit Change Log & Audit Corrections

1. **Fixed Same-Bar Exit Ordering Lookahead:**
   - *Previous Bug:* Trailing stop was ratcheted with `candle_high` before testing `candle_low`, causing large candles to trigger phantom stop-outs intrabar on their own lows.
   - *Fix:* Enforced strict two-step sequence: (a) test exits against the stop carried from the PREVIOUS bar; (b) only update trailing stop at the close of the bar for use on the NEXT bar.
2. **Fixed Order Fill ATR Lookahead:**
   - *Previous Bug:* Position sizing and stop distance at `bar_open` of bar $t+1$ read `atr[idx]` (the ATR of unclosed bar $t+1$).
   - *Fix:* Position sizing and stop distance now strictly read `atr[sig_idx]` (the ATR of closed bar $t$).
3. **Conservative Gap-Through Execution:**
   - Evaluated at `min(candle_open, trailing_stop) * (1 - slippage)` for Longs and `max(candle_open, trailing_stop) * (1 + slippage)` for Shorts.
4. **Conservative Intrabar Collision Resolution:**
   - When both stop and take-profit target are touched in the same bar, the engine conservatively executes the stop.
5. **Accurate Zero-Cost Random Baseline:**
   - Demonstrated that random entries with trailing stops on driftless random walks achieve PF 1.00 with 0.00 R expectancy.
