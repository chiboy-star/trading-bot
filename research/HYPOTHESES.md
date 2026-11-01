# Institutional Pre-Registered Research Hypotheses

**Document Version:** 1.0.0  
**Registration Date:** 2026-10-23  
**Status:** PRE-REGISTERED (Locked prior to backtest execution)  
**Execution Mode Invariant:** PAPER TRADING ONLY. No live execution.

---

## 1. Research Protocol & Anti-P-Hacking Commitments

In accordance with institutional quantitative standards (Harvey, Liu, Zhu 2016; Bailey et al. 2014 on Pseudo-Mathematics and Backtest Overfitting):
1. **Pre-Registration:** All hypotheses, indicator formulas, parameters, entry/exit mechanics, and cost models are explicitly locked in this document before running backtest scripts.
2. **No Post-Hoc Tuning:** Parameters will NOT be altered after inspecting returns. If a hypothesis fails its pre-registered criteria, it will be classified as **FAIL** without searching for ad-hoc parameter tweaks.
3. **Zero Lookahead:** All signals are computed exclusively on fully closed bars (bar $t$). Entries execute at bar $t+1$ Open. Stop loss and profit targets are carried over from bar $t$ and tested before updating stops on bar $t+1$ close.
4. **Full Cost Realism:**
   - Standard Bybit VIP0 Taker fee: 0.055% ($0.00055$).
   - Standard Bybit VIP0 Maker fee: 0.02% ($0.00020$) with fill probability constraint.
   - Tiered Slippage: Major (BTC/ETH: 0.02%), Mid-cap (SOL/DOGE/XRP: 0.05%), Alts (1000PEPE, SUI, TIA, STRK, ALT, etc.: 0.10%).
   - Actual Bybit 8-hour historical funding rates accrued directly from parquet records.
   - Real-world operator constraint: Nigeria P2P deposit/withdrawal friction (1.5% to 3.0% drag) evaluated for capital viability.

---

## 2. Pre-Registered Hypotheses

### Hypothesis 1 (H1): Daily Trend Following (BTC & ETH Long/Flat)
- **Economic Rationale:** Crypto markets are characterized by heavy right-tail momentum during secular bull runs and severe -70% to -80% multi-quarter drawdowns. A slow daily trend filter allows full participation in bull runs while preserving capital in cash during bear regimes. Long-only avoids the negative skew of shorting secularly growing assets.
- **Universe:** `BTC_USDT`, `ETH_USDT` (1D Daily Timeframe).
- **Indicators:**
  - Fast Trend Filter: 50-day Exponential Moving Average (EMA 50) on Daily Close.
  - Slow Trend Filter: 200-day Simple Moving Average (SMA 200) on Daily Close.
  - Volatility Metric: 20-day Average True Range (ATR 20).
- **Signal Logic (Evaluated at Daily Close bar $t$):**
  - **Long Entry:** `Close[t] > EMA50[t]` AND `Close[t] > SMA200[t]` AND `EMA50[t] > EMA50[t-1]`.
  - **Execution:** Long filled at `Open[t+1]` with 0.055% fee + 0.02% slippage.
- **Exit Logic:**
  - **Trend Exit:** `Close[t] < EMA50[t]`. Exit filled at `Open[t+1]`.
  - **Trailing Stop:** Initial stop at $3.0 \times \text{ATR}(20)$ below entry price. Ratchets upward to $3.0 \times \text{ATR}(20)$ below the highest close since entry.
- **Position Sizing:** Fixed risk (1.5% portfolio risk per trade based on distance to initial stop) or unleveraged 100% equity allocation (1.0x gross leverage).
- **Pre-Registered Parameters:** Fast EMA = 50, Slow SMA = 200, Trailing ATR Multiplier = 3.0, ATR Period = 20.

---

### Hypothesis 2 (H2): Weekly Cross-Sectional Momentum (Altcoins vs. BTC Regime)
- **Economic Rationale:** High-beta altcoins exhibit strong momentum divergence during risk-on crypto phases. When Bitcoin is in an established upward trend, capital cascades into relative-strength leaders. When Bitcoin is below its 50-day trend, altcoins suffer extreme beta drag.
- **Universe:** 12 symbols (`BTC_USDT`, `ETH_USDT`, `SOL_USDT`, `SUI_USDT`, `XRP_USDT`, `DOGE_USDT`, `1000PEPE_USDT`, `TIA_USDT`, `STRK_USDT`, `ALT_USDT`, `AKE_USDT`, `Q_USDT`).
- **Rebalance Frequency:** Weekly (Every Monday 00:00 UTC, evaluated on Sunday close).
- **Regime Filter:**
  - `BTC_USDT Daily Close[t] > BTC_USDT 50-day EMA[t]`.
  - If FALSE: Portfolio is 100% Flat / Cash.
- **Selection & Sizing (Evaluated Weekly):**
  - Compute 4-week (28-day) cumulative log return for all universe pairs having $\ge 45$ days of history.
  - Select Top $N = 2$ relative strength leaders.
  - Allocate 50% capital to each selected leader.
  - Sizing adjusted by inverse 14-day ATR to equalize risk.
- **Execution:** Rebalance filled at Monday 00:00 UTC open with tiered slippage and taker fees.
- **Pre-Registered Parameters:** Momentum Lookback = 28 days (4 weeks), Top $N = 2$, BTC Regime = 50 EMA, Rebalance = 7 days.

---

### Hypothesis 3 (H3): 4H Funding Rate & Open Interest Crowding Fade
- **Economic Rationale:** Perpetual contracts trade with retail leverage. When funding rates become excessively positive alongside surging Open Interest, market makers and smart money take the other side while retail longs become vulnerable to cascade liquidation flushes. Conversely, deeply negative funding with high OI indicates crowded retail shorts ripe for a squeeze.
- **Universe:** Liquid perps: `BTC_USDT`, `ETH_USDT`, `SOL_USDT`, `DOGE_USDT`, `XRP_USDT`, `1000PEPE_USDT` (4H Timeframe).
- **Indicators:**
  - 8H Funding Rate annualized: $\text{FR}_{\text{annual}} = \text{FR} \times 3 \times 365$.
  - 20-period Rolling Z-Score of Funding Rate: $Z_{\text{FR}} = \frac{\text{FR} - \mu_{20}}{\sigma_{20}}$.
  - 24H (6-bar 4h) Percentage Change in Open Interest ($\Delta \text{OI}_{24\text{h}}$).
  - 14-period RSI on 4H Close.
  - 14-period ATR on 4H.
- **Signal Logic (Evaluated at 4H bar $t$ Close):**
  - **Short Entry (Fade Crowded Longs):**
    - $Z_{\text{FR}} > +2.0$ (or $\text{FR}_{\text{annual}} > +30\%$) AND $\Delta \text{OI}_{24\text{h}} > +8\%$ AND $\text{RSI}(14) > 70$.
  - **Long Entry (Fade Crowded Shorts):**
    - $Z_{\text{FR}} < -2.0$ (or $\text{FR}_{\text{annual}} < -15\%$) AND $\Delta \text{OI}_{24\text{h}} > +5\%$ AND $\text{RSI}(14) < 30$.
- **Exit Logic:**
  - Profit Target: $2.0 \times \text{ATR}(14)$ or when Funding Rate normalizes ($|Z_{\text{FR}}| < 0.5$).
  - Stop Loss: $1.5 \times \text{ATR}(14)$ from entry price.
  - Time Stop: 12 bars (48 hours) max hold.
- **Pre-Registered Parameters:** $Z$-threshold = $\pm 2.0$, OI change threshold = $+8\% / +5\%$, RSI threshold = $70 / 30$, Profit Target = $2.0 \times \text{ATR}$, Stop Loss = $1.5 \times \text{ATR}$, Max Bars = 12.

---

### Hypothesis 4 (H4): Delta-Neutral Funding Rate Carry
- **Economic Rationale:** Perpetual futures trade at a structural premium due to long leverage demand. Long spot + Short perp creates an economically delta-neutral position that collects the positive funding rate 3 times daily (00:00, 08:00, 16:00 UTC) with zero price exposure.
- **Universe:** `BTC_USDT`, `ETH_USDT`, `SOL_USDT`, `DOGE_USDT`, `SUI_USDT`.
- **Mechanism:**
  - Open Position: Buy Spot, Sell 1x Perp when 3-day trailing annualized funding rate $> 15.0\%$.
  - Close Position: When 3-day trailing annualized funding rate drops $< 4.0\%$ or goes negative.
- **Cost Deductions:**
  - Spot Taker: 0.10% (or 0.055% perp + spot).
  - Perp Taker: 0.055%.
  - Slippage on both legs: 2x taker roundtrip $\approx 0.20\%$ total roundtrip entry/exit friction.
  - Funding cashflow: Exact 8-hour funding rates collected or paid.
- **Operator Assessment:**
  - Minimum viable capital: Minimum contract sizing on Bybit vs $200 capital.
  - Margin safety buffer: Risk of liquidation on the short leg during sharp vertical pumps (requires rebalancing capital from spot to perp margin).
  - Net yield after Nigerian P2P on/off-ramp friction (2% roundtrip).

---

### Hypothesis 5 (H5): Long BTC Spot Above 200-Day SMA, Otherwise Flat (Trial #51)
- **Registration Date:** 2026-10-24 (Pre-registered prior to data acquisition and backtesting)
- **Economic Rationale & Expected Benefit:**
  - **Explicit Expectation:** The expected benefit of this strategy is **drastic drawdown reduction and capital preservation during multi-quarter crypto winter bear markets**, NOT outperforming Bitcoin buy-and-hold during parabolic bull markets. By sitting in cash during secular downtrends (2014-2015, 2018, 2022), the portfolio prevents catastrophic 70-85% drawdowns, allowing small capital operators to compound capital safely without leverage or liquidation risk.
- **Rule (Frozen, Zero Post-Hoc Optimization):**
  - **Long Entry:** Evaluated at Daily Close (Bar $t$, 00:00 UTC). If `Close[t] > SMA200[t]`, enter 100% Long BTC Spot.
  - **Execution:** Filled at Bar $t+1$ Open with Spot Taker Fee (0.10%) + Slippage (0.02%).
  - **Exit:** Evaluated at Daily Close (Bar $t$, 00:00 UTC). If `Close[t] <= SMA200[t]`, exit to 100% Cash (USDT) at Bar $t+1$ Open with Spot Taker Fee (0.10%) + Slippage (0.02%).
  - **Leverage & Funding:** Strictly 1.0x unleveraged spot. Zero debt, zero liquidation risk, zero funding rate cashflows.
- **Dataset & Partitions:**
  - Pull longest continuous public BTC daily history available through CCXT from a tier-1 exchange (Bitstamp or Coinbase, 2014-2017 onward).
  - **Out-of-Sample (OOS) Partition:** Inception through 2021-12-31 (True out-of-sample: parameters were observed on 2022-2026 data).
  - **In-Sample / Audit Partition:** 2022-01-01 through 2026-10-23.
  - **Full History:** Inception through 2026-10-23.
  - OOS metrics reported strictly separately from full-history metrics.
- **Trial Count & Multiple Testing Adjustment:**
  - Counted as **Trial #51** across the research project. Subject to multiple-testing Bonferroni / Deflated Sharpe adjustment.

---

## 3. Hard Pass/Fail Evaluation Criteria

To be declared a **PASS** and qualify for paper execution scheduling, a hypothesis must satisfy ALL of its pre-registered criteria without exception:

### Criteria for Directional Strategies (H1, H2, H3) and Carry (H4)
- **H1, H2, H3:** Net PF $\ge 1.25$, Net Expectancy $\ge +0.08\text{ R}$, Max DD $<$ 50% BTC DD ($< 30.5\%$), beat 95th percentile random baseline. (All recorded as FAIL).
- **H4:** Net Annual Return $\ge +10.0\%$ on Total Deployed Capital. (Recorded as FAIL).

### Hard Pass Criteria for Hypothesis 5 (H5) - ALL 6 REQUIRED:
1. **(a) OOS Drawdown & Sharpe:** Pre-2022 Out-of-Sample Max Drawdown must be at most **60% of Buy-and-Hold's Max Drawdown**, AND Pre-2022 Sharpe must be at least **Buy-and-Hold's Sharpe minus 0.10**.
2. **(b) Full-History CAGR:** Full-history Net CAGR must be at least **70% of Buy-and-Hold's Net CAGR**.
3. **(c) Parameter Robustness (Fragility Check):** Performance must remain stable under $\pm 20\%$ variation to SMA length (tested on SMA 160, SMA 200, SMA 240). This is a fragility check only, not for parameter selection.
4. **(d) Statistical Significance vs. Random Timing:** Must beat a random-timing baseline with identical time-in-market (1,000 runs) on Sharpe Ratio at the **95th percentile**.
5. **(e) Uniformity Across Calendar Years:** No single calendar year or macro event may supply more than **50% of the total excess return** versus Buy-and-Hold. Performance must be shown for every individual calendar year.
6. **(f) Cost Drag:** Total annual transaction cost drag (fees + slippage) must be strictly under **1.0% per year**.

If ANY single criterion (a)-(f) fails, the verdict is **FAIL**. No conditional passes.

