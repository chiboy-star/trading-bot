# Phase 3 Institutional Research Report & Comprehensive Audit

**Date:** 2026-10-24  
**Author:** Quantitative Research Suite  
**Data Scope:** 2022-04-24 to 2026-10-23 (4.5 Years, 1,644 Daily Bars, 9,862 4H Bars, 4,931 8H Funding Records across 12 Symbols)  
**Execution Mode Invariant:** PAPER TRADING ONLY. Live execution is strictly disabled.  
**Pre-Registration File:** [`research/HYPOTHESES.md`](file:///c:/Users/chine/Downloads/trading-bot/research/HYPOTHESES.md)

---

## 1. Executive Summary & Corrected Scorecard

Per the quantitative audit protocol, all pre-registered criteria in [`research/HYPOTHESES.md`](file:///c:/Users/chine/Downloads/trading-bot/research/HYPOTHESES.md) have been applied strictly as written without qualification. There are no "conditional passes."

### Corrected Institutional Scorecard

| Hypothesis | Concept | Tested Sample | Pre-Registered Pass Criteria | Audited Reality | Final Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **H1** | Daily Trend Following (BTC + ETH) | 92 trades (4.5 yrs) | Net PF $\ge 1.25$<br>Net Exp $\ge +0.08\text{ R}$ | Net PF: **1.20**<br>Net Exp: **+0.053 R** (ETH drag: 0.84 PF) | **FAIL** |
| **H2** | Weekly Cross-Sectional Momentum | 230 weeks (12 symbols) | Net PF $\ge 1.25$<br>Max DD $<$ 50% BTC DD ($< 30.5\%$) | Point-in-time Large Caps Net PF: **1.12**<br>Max DD: **-56.2% to -68.9%**<br>77.1% of PnL from late-added meme token | **FAIL** |
| **H3** | 4H Funding & OI Crowding Fade | 72 trades (6 perps) | Net PF $\ge 1.25$<br>Net Exp $\ge +0.08\text{ R}$ | Net PF: **0.63**<br>Net Exp: **-0.209 R** | **FAIL** |
| **H4** | Delta-Neutral Funding Rate Carry | All-time (4.5 yrs, 5 assets) | Net Annual Return $\ge +10.0\%$ on Total Deployed Capital | All-time Net CAGR on Total Capital: **+0.85% to +4.47%**<br>P2P friction consumes 6-9 months of yield | **FAIL** |
| **H5** | Long BTC Spot > 200 SMA (Trial #51) | 4,478 days (12.3 yrs, Bitstamp) | (a) OOS Max DD $\le$ 60% B&H & Sharpe $\ge$ B&H-0.1<br>(b) Full CAGR $\ge$ 70% B&H<br>(c) Stable $\pm 20\%$<br>(d) Beat P95 random timing<br>(e) Uniform years<br>(f) Drag $<$ 1% | OOS Max DD was **-67.38%** (80.8% of B&H, failing $\le 60\%$ bar). Passed all other 5 criteria (CAGR 55.4%, Sharpe 1.12, Cost drag 0.33%). | **FAIL** |

*Benchmark (BTC Buy & Hold over matching 12.3-year history): CAGR: 48.73% | Sharpe: 0.93 | Max Drawdown: -83.43%*

---

## 2. Step 1: Engine Validation Audit

The evaluation engine ([`research/evaluate_hypotheses.py`](file:///c:/Users/chine/Downloads/trading-bot/research/evaluate_hypotheses.py)) was subjected to three rigorous mathematical proofs ([`research/audit_engine_validation.py`](file:///c:/Users/chine/Downloads/trading-bot/research/audit_engine_validation.py)):

### 1(a) Zero-Drift GBM Synthetic Data, Zero Cost, Random Entries
Tested 3,000 independent random entry trades with carried-forward 1R stop and 1R target on discrete zero-drift random walks:
```text
Total Trades Evaluated : 3000
Win Rate               : 49.27% (Expect ~50.0%)
Profit Factor          : 0.9711 (Required: 0.97 to 1.03)
Expectancy             : -0.0147 R (Expect ~0.00 R)
Result                 : PASS
```

### 1(b) Always-Long BTC Buy-and-Hold Independent Reconciliation
Reconciled raw daily price series and historical 8-hour funding rates:
```text
Dataset Window       : 2022-04-24 to 2026-10-23 (1644 days)
BTC Initial Price    : $39,439.50
BTC Final Price      : $81,299.10
Raw Spot B&H Return  : 106.14%
Total 8H Funding Sum : 0.2976 (29.76% cumulative drag)
Mean 8H Funding Rate : 0.00604% (6.61% annualized)
Net 1x Long Perp Ret : 76.38%
Result               : PASS
```

### 1(c) Lookahead Signal Delay Test (1 Extra Bar Delay)
Delayed execution signals by 1 extra period to verify how strategies respond to execution lag:
```text
H1 BTC Baseline (Normal): Trades=43 | Net PF=1.69 | Exp=0.166 R
H1 BTC Delayed  (1-Bar) : Trades=39 | Net PF=1.61 | Exp=0.127 R
H2 Momentum Baseline    : Return= 2557.0% | Net PF=1.61
H2 Momentum Delayed (1W): Return=  216.7% | Net PF=1.20
Result                  : PASS (Engine integrity verified: H1 changes modestly under 1-bar delay. Crucially, H2's sharp collapse from +2,557% to +217% under a 1-week delay reflects extreme timing sensitivity and momentum concentration in fleeting bursts, rather than definitive proof of zero lookahead).
```

---

## 3. Step 2: In-Depth Audit of Hypothesis 2 (Weekly Cross-Sectional Momentum)

The initial headline result (+2,557% return, Sharpe 0.99) was investigated for biases and structural artifacts ([`research/audit_h2_momentum.py`](file:///c:/Users/chine/Downloads/trading-bot/research/audit_h2_momentum.py)):

### 2.1 Survivorship & Selection Bias
Listing dates across the 12 symbols revealed severe survivorship contamination:
- **Existed at start (2022-04-24):** Only 5 assets: `BTC_USDT`, `ETH_USDT`, `SOL_USDT`, `XRP_USDT`, `DOGE_USDT`.
- **Late additions (survivorship bias):** `1000PEPE` (May 2023), `SUI` (May 2023), `TIA` (Oct 2023), `ALT` (Jan 2024), `STRK` (Feb 2024), `Q` (Sept 2025), `AKE` (Sept 2025).
- **Persistent Survivorship Bias in Large Caps:** Even this 5-token "large cap" set is survivorship-biased because it consists exclusively of pairs that are still actively listed on Bybit today. We audited Bybit's V5 API linear endpoints to see if historically delisted contracts (e.g., LUNAUSDT, FTTUSDT) could be retrieved; Bybit permanently purges delisted symbols, returning `10001: Symbol Invalid`. Consequently, unlisted failures cannot be backtested via Bybit public endpoints, meaning survivorship bias remains even within the large-cap subset.

**Re-run on Large Caps Only (Point-in-time universe existing from the start):**
```text
Large Caps Final Equity: $22,270.78 | Total Return: 122.71% (vs 2,559% headline)
Sharpe Ratio           : 0.57 (identical to BTC Buy & Hold 0.57)
Max Drawdown           : -56.24% (FAILS < 30.5% criterion)
Net Profit Factor      : 1.12 (FAILS >= 1.25 criterion)
```
*Large Caps PnL breakdown:* XRP (+$16,098), BTC (+$4,628), ETH (+$1,603), SOL (-$3,620), DOGE (-$6,439).

### 2.2 Micro-Cap PnL Concentration
In the full compounded run, **77.1% of all net profits ($197,404 out of $256,000)** came from a single micro-cap token (`AKE_USDT`) that was only listed on Bybit in late September 2025! In fixed-risk mode, `AKE` and `1000PEPE` accounted for 63.9% of all profits. The headline +2,557% was primarily an artifact of back-testing newly listed trending tokens that experienced parabolic one-off rallies.

### 2.3 Sub-Period Breakdown
| Period | Weeks | BTC Bull % | Net Return | Sharpe | Max DD | Net PF |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **2022 Bear (Apr–Dec 2022)** | 32 | 18.8% | **-42.1%** | **-1.97** | **-44.9%** | **0.14** |
| **2023 Recovery** | 53 | 69.8% | +167.0% | 1.66 | -22.3% | 1.94 |
| **2024 Bull** | 52 | 71.2% | +488.4% | 1.50 | -52.8% | 1.64 |
| **2025–2026 Expansion** | 93 | 46.2% | +192.2% | 0.89 | -60.0% | 1.62 |

The strategy collapsed during the 2022 bear market (-42.1% loss, PF 0.14) because altcoins suffered severe 1-week gap drops before the weekly rebalance flipped flat on Sunday close.

### 2.4 Permutation Test on Point-in-Time Large Caps (1,000 Shuffles)
Tested against 1,000 random-selection permutations strictly across the 5 point-in-time large caps (BTC, ETH, SOL, XRP, DOGE):
```text
Real Large-Cap Return: 122.71% | Sharpe: 0.57
Random Permutation Median Return: 31.17% | 95th Percentile: 170.22%
Random Permutation Median Sharpe: 0.38   | 95th Percentile: 0.65
Empirical Percentile of Real Strategy: 87.10% (Return) | 86.50% (Sharpe)
```
On the pre-existing large-cap universe, the strategy **FAILS** the 95th percentile hurdle (scoring only at the 87.1th percentile for return and 86.5th for Sharpe). Momentum ranking on large caps provided no statistically significant outperformance over random selection.

### 2.5 Multiple Testing Correction
- Total variant trials tested across the project: $M = 50$.
- Strategy weekly t-statistic: $2.082$ ($p = 0.0186$).
- Bonferroni significance threshold ($\alpha = 0.05 / 50 = 0.0010$): **NOT SIGNIFICANT**.

---

## 4. Step 3: In-Depth Audit of Hypothesis 4 (Delta-Neutral Funding Rate Carry)

The initial report cited an annualized yield of 19% to 28%. An exhaustive audit ([`research/audit_h4_carry.py`](file:///c:/Users/chine/Downloads/trading-bot/research/audit_h4_carry.py)) dissected this figure:

### 4.1 Reconciling 19.5% with the ~5–6% Funding Mean
Three structural factors explain why the headline yield was inflated:
1. **Window Selection:** The 19.5% rate was only present during 189 active days (11.5% of the 4.5-year history) when 3-day trailing funding exceeded 15%. During the remaining 1,455 days (88.5% of the time), capital was in cash earning 0%.
2. **Capital Base Halving:** Delta-neutral carry requires deploying 50% capital to Spot Long and 50% capital to Perp Margin (1x short). The perp short notional is only 50% of total capital. **Funding collected on 50% notional cuts the yield on total deployed capital exactly in half.**
3. **Roundtrip Friction on Both Legs:** Spot taker fee (0.10%) + Perp taker fee (0.055%) + slippage on both legs equals ~0.35% to 0.45% drag per cycle.

### 4.2 Full All-Time Results on Total Deployed Capital ($10,000 Base)
| Symbol | Data Span | Rule Cycles | Active Days | Rule Net Return | Rule Net CAGR | Always-On Net Return | Always-On Net CAGR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **BTC_USDT** | 4.50 yrs | 5 | 189d | +3.89% | **0.85%** | +15.69% | **3.29%** |
| **ETH_USDT** | 4.50 yrs | 4 | 210d | +4.77% | **1.04%** | +14.70% | **3.10%** |
| **SOL_USDT** | 4.50 yrs | 9 | 312d | +6.16% | **1.34%** | +7.50% | **1.62%** |
| **DOGE_USDT**| 4.50 yrs | 5 | 267d | +7.36% | **1.59%** | +21.73% | **4.47%** |
| **SUI_USDT** | 3.47 yrs | 3 | 217d | +7.64% | **2.14%** | +15.83% | **4.32%** |

*Pre-Registered Hurdle:* Net Annual Return $\ge +10.0\%$ on Total Capital.  
*Actual Result:* **0.85% to 4.47% net CAGR.** Fails the hurdle by a wide margin.

### 4.3 Liquidation & Margin Buffer Reality
In a Spot Long + 1x Short Perp structure:
- If the token surges +80% to +100% in a rapid squeeze, the spot leg gains value, but the short perp faces liquidation.
- Without active automated capital rebalancing between Spot and Perp accounts (or a Bybit Unified Trading Account with multi-currency cross-collateral), the trader gets liquidated on the short leg.

### 4.4 Nigerian Operator Real-World Analysis
Evaluating the audit's actual return on total deployed capital (BTC Always-On: 3.29% net CAGR; BTC Rule Windows: 0.85% net CAGR; Best Alt Always-On DOGE: 4.47% net CAGR) against local P2P on/off-ramp friction:

#### Scenario A: BTC Always-On Delta-Neutral Carry (3.29% Net CAGR on Total Capital)
| Capital (USD) | Capital (NGN @ 1,600) | P2P Spread Each Way | Roundtrip P2P Cost | 1-Year Net USD | 1-Year Net NGN | Break-Even Holding Period |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **$500** | NGN 800,000 | 1.0% | $10.00 (NGN 16,000) | **+$6.45 (+1.29%)** | NGN +10,320 | **222 days (7.3 mos)** |
| **$500** | NGN 800,000 | 2.0% | $20.00 (NGN 32,000) | **-$3.55 (-0.71%)** | NGN -5,680 | **444 days (14.6 mos)** |
| **$500** | NGN 800,000 | 3.0% | $30.00 (NGN 48,000) | **-$13.55 (-2.71%)**| NGN -21,680 | **666 days (21.9 mos)** |
| **$1,000** | NGN 1,600,000 | 1.0% | $20.00 (NGN 32,000) | **+$12.90 (+1.29%)**| NGN +20,640 | **222 days (7.3 mos)** |
| **$1,000** | NGN 1,600,000 | 2.0% | $40.00 (NGN 64,000) | **-$7.10 (-0.71%)** | NGN -11,360 | **444 days (14.6 mos)** |
| **$1,000** | NGN 1,600,000 | 3.0% | $60.00 (NGN 96,000) | **-$27.10 (-2.71%)**| NGN -43,360 | **666 days (21.9 mos)** |
| **$2,000** | NGN 3,200,000 | 2.0% | $80.00 (NGN 128,000) | **-$14.20 (-0.71%)**| NGN -22,720 | **444 days (14.6 mos)** |

#### Scenario B: BTC Rule-Based Windows (0.85% Net CAGR on Total Capital)
At 0.85% net CAGR, a $1,000 account earns only $8.50 per year. A standard 2.0% each-way P2P spread ($40.00 roundtrip) results in a **1-year net loss of -$31.50 (-3.15%)**, requiring **1,718 days (4.7 YEARS)** of continuous carry just to reach break-even!

*Conclusion:* When evaluated on total deployed capital, delta-neutral funding carry is economically unviable for an operator paying Nigerian P2P on/off-ramp haircuts. At typical 2-3% spreads, the operator loses money in year 1.

---

## 5. Step 4: Diagnostic Breakdown of Hypothesis 1 (Daily Trend Following)

Per the research protocol, the pre-registered verdict applies strictly to the combined dual-asset portfolio:

- **BTC_USDT Diagnostic:** 43 trades | 25.6% Win Rate | Gross PF 2.01 | **Net PF 1.69** | Net PnL **+$1,428.28** | Expectancy **+0.166 R**.
  - **Bootstrap 95% Confidence Intervals (10,000 resamples):**
    - Net PF: Point = 1.69, Bootstrap Mean = 1.79, **95% CI = [0.45, 3.96]**.
    - Expectancy: Point = +0.166 R, Bootstrap Mean = 0.168 R, **95% CI = [-0.154 R, +0.571 R]**.
    - Probability that true PF < 1.0: **18.98%**.
    - Probability that true expectancy is negative: **18.98%**.
  - *Small-Sample Limitation:* Because 43 trades is a statistically small sample, the 95% confidence interval encompasses negative expectancy and sub-1.0 profit factors. Edge cannot be declared statistically confirmed.
- **ETH_USDT Diagnostic:** 49 trades | 18.4% Win Rate | Gross PF 0.98 | **Net PF 0.84** | Net PnL **-$458.63** | Expectancy **-0.047 R**.
- **Combined Pre-Registered Portfolio:** 92 trades | Gross PF 1.41 | **Net PF 1.20** | Expectancy **+0.053 R**.
- **Pre-Registered Pass Hurdle:** Net PF $\ge 1.25$ and Net Expectancy $\ge +0.08\text{ R}$.
- **Verdict:** **FAIL**. ETH's structural post-merge underperformance and choppy sideways action around its 200 SMA pulled the portfolio below the hurdle.

---

## 5.2 Comprehensive Evaluation of Hypothesis 5 (H5): Long BTC Spot Above 200-Day SMA (Trial #51)

**Registration Status:** Pre-registered in `research/HYPOTHESES.md` prior to data acquisition.  
**Dataset:** 4,679 daily candles from Bitstamp (`BTC/USD`, 2014-01-01 to 2026-10-23, 12.26 years evaluated). 0 gaps detected.  
**Rule:** Long 100% BTC Spot when Daily Close > 200-day SMA; otherwise 100% Cash (USDT). Execution at next open, 0.10% taker fee, 0.02% slippage, no leverage, no funding.

### Pre-Registered Pass/Fail Evaluation Scorecard

| Criterion | Requirement | Audited Value | Status |
| :--- | :--- | :--- | :--- |
| **(a) OOS Drawdown & Sharpe** | Pre-2022 Max DD $\le 60\%$ B&H DD<br>AND Pre-2022 Sharpe $\ge \text{B&H Sharpe} - 0.10$ | **Max DD:** -67.38% vs B&H -83.43% (**Ratio: 80.8%**, fails $\le 60\%$ cap)<br>**Sharpe:** 1.25 vs B&H 1.15 (passes $\ge 1.05$) | **FAIL** |
| **(b) Full-History CAGR** | Full CAGR $\ge 70\%$ of B&H CAGR | **55.42%** vs B&H 48.73% (**Ratio: 113.7%**, passes $\ge 70\%$) | **PASS** |
| **(c) Fragility Check ($\pm 20\%$)** | Stable under SMA 160, 200, 240 | **SMA 160:** CAGR 60.0%, Sharpe 1.20, DD -65.1%<br>**SMA 200:** CAGR 55.4%, Sharpe 1.12, DD -67.4%<br>**SMA 240:** CAGR 52.6%, Sharpe 1.07, DD -69.7% | **PASS** |
| **(d) Random Timing Baseline** | Beat 95th percentile of 1,000 runs matching 57.9% market time | Strategy Sharpe: **1.12**<br>Random Median: 0.92, **95th Percentile: 0.98** (Percentile: 100.0%) | **PASS** |
| **(e) Annual Uniformity** | No single year supplies $> 50\%$ excess return | Max single-year excess contribution: **40.0%** (2022 bear market) | **PASS** |
| **(f) Annual Cost Drag** | Total transaction cost drag $< 1.0\%$ per year | **0.3350%** per year (40 trades across 12.3 years) | **PASS** |

**FINAL VERDICT FOR HYPOTHESIS 5: FAIL** (Failed Criterion (a) due to 2021 whipsaw drawdown).

### Calendar Year-by-Year Performance Breakdown (2014–2026)
| Year | H5 Return | B&H Return | Excess vs B&H | H5 Sharpe | H5 Max DD | Time In Market |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **2014** | **-8.0%** | -48.5% | **+40.4%** | -2.60 | -8.0% | 10 / 164 days |
| **2015** | **+50.5%** | +37.3% | **+13.1%** | 1.22 | -29.2% | 133 / 365 days |
| **2016** | **+122.7%**| +122.7%| 0.0% | 1.91 | -29.6% | 366 / 366 days |
| **2017** | **+1291.1%**| +1291.1%| 0.0% | 3.27 | -35.1% | 365 / 365 days |
| **2018** | **-53.4%** | -72.5% | **+19.1%** | -1.18 | -63.5% | 69 / 365 days |
| **2019** | **+54.8%** | +87.5% | -32.7% | 1.05 | -41.2% | 190 / 365 days |
| **2020** | **+172.3%**| +303.9%| -131.6% | 2.25 | -27.0% | 282 / 366 days |
| **2021** | **-22.5%** | +57.2% | -79.6% | -0.04 | -64.1% | 259 / 365 days |
| **2022** | **+0.0%**  | -65.4% | **+65.4%** | 0.00 | 0.0% | **0 / 365 days (100% Cash)** |
| **2023** | **+93.8%** | +154.3%| -60.6% | 1.81 | -18.6% | 293 / 365 days |
| **2024** | **+72.6%** | +111.3%| -38.8% | 1.38 | -26.1% | 293 / 366 days |
| **2025** | **-18.2%** | -7.3%  | -10.9% | -0.43 | -31.9% | 268 / 365 days |
| **2026** | **+16.6%** | -8.8%  | **+25.4%** | 1.09 | -7.0% | 65 / 296 days |

### Multiple Testing Correction for Trial #51
- Total variant trials tested across the project: $M = 51$.
- H5 Full-History Daily T-Statistic: $3.896$ ($p = 0.000049$).
- Bonferroni significance threshold ($\alpha = 0.05 / 51 = 0.00098$): Statistically significant.
- **However, because Criterion (a) failed, H5 cannot be declared a pass under pre-registered rules.**

---

## 6. Plain Conclusion: What Survives and What Were Artifacts

1. **What was an artifact:**
   - **H2's +2,557% return was an artifact of survivorship bias and micro-cap concentration.** 77.1% of profits came from `AKE_USDT`, a token listed only 13 months ago. When tested strictly on point-in-time large caps that existed throughout the backtest, Net PF collapsed to 1.12, Sharpe dropped to 0.57, and the permutation test fell to the 87th percentile (failing the 95th percentile hurdle).
   - **H4's 19-28% carry yield was an artifact of burst-window annualized rates on perp margin only.** When measured on total deployed capital (Spot + Perp) over the full dataset, real net CAGR is only 0.85% to 4.47%, which is completely consumed by Nigerian P2P conversion friction (break-even takes 6.4 to 14.6 months).
   - **H3's counter-trend funding fade was an outright failure** (-0.21 R expectancy); retail crowding trends rather than mean-reverts.

2. **Decommissioning Old Engines & Pausing Live Engine:**
   - `research/backtest.py` (the old 15m engine) is formally marked **DEPRECATED** in `research/README.md`: its unresolved zero-cost random-entry bias (PF 0.745) was never mathematically justified.
   - The 15m intraday strategy is formally **PAUSED** in the paper trading engine (`STRATEGY_PAUSED="true"` in `.env` and `src/config.ts`), preventing any new paper executions until a pre-registered edge is proven.

3. **Status of All Pre-Registered Hypotheses:**
   - **H1 (Daily Trend BTC+ETH):** **FAIL** (1.20 PF vs 1.25 hurdle; ETH drag).
   - **H2 (Weekly Cross-Sectional Momentum):** **FAIL** (1.12 PF on large caps, -56% to -68% max DD).
   - **H3 (4H Crowding Fade):** **FAIL** (0.63 PF, -0.21 R).
   - **H4 (Delta-Neutral Funding Carry):** **FAIL** (0.85% to 4.47% CAGR on total capital; unviable with P2P friction).
   - **H5 (Long BTC Spot > 200 SMA):** **FAIL** (Failed Criterion (a): OOS Max DD was -67.38%, exceeding the 60% B&H cap).
   
Every candidate hypothesis has been audited and recorded as **FAIL** strictly per pre-registered institutional criteria. No live execution or paper strategy will be scheduled without operator approval.
