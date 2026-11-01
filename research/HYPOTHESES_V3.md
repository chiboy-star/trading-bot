# Institutional Pre-Registered Research Hypotheses (Version 3)

**Document Version:** 3.2.0  
**Registration Date:** 2026-10-24  
**Registration Status:** PRE-REGISTERED (Locked prior to forward data collection)  
**Execution Invariant:** PAPER TRADING ONLY. Zero live execution.  
**Multiple-Testing Scope:** Applies strictly to hypotheses evaluated on clean forward-recorded data ($m = 2$ candidate hypotheses).  
- **Hypothesis A (H-A):** Forward Hypothesis #1 (New-Listing Supply Overhang Breakdown)  
- **Hypothesis B (H-B):** Forward Hypothesis #2 (Liquidation Cascade Exhaustion Snapback)  

---

## 1. Research Protocol & Anti-P-Hacking Commitments

In accordance with institutional standards for eliminating backtest overfitting and data mining bias (Harvey, Liu, Zhu 2016; Bailey et al. 2014):

1. **Pure Forward-Recorded Out-of-Sample Requirement:**
   - **Critical Survivorship Bias Disclosure:** Historical Bybit backtest datasets are intrinsically survivorship-biased because Bybit permanently purges delisted and failed contracts from its API and historical candle endpoints. Surviving tokens exhibit artificial resilience.
   - Consequently, **only forward-recorded listings and events captured by our standalone recorder service count as clean out-of-sample data.** Historical data is permanently disqualified.
2. **Fixed Parameters Locked in Advance:**
   - All indicators, thresholds, cluster definitions, stop distances, and holding times are locked in this document purely from theoretical structural reasoning.
   - **Rule:** Parameters will NOT be tuned, tweaked, or iterated after inspecting initial results. Any parameter modification constitutes a new trial and increments the multiple-testing penalty.
3. **Execution Friction & Cost Realism (Including Actual Funding):**
   - Bybit VIP0 Taker fee: **0.055%** ($0.00055$).
   - Bybit VIP0 Maker fee: **0.020%** ($0.00020$) with post-only fill verification.
   - Bounded Order-Book Fill Simulation: For `BTCUSDT`, `ETHUSDT`, and new listings within 72h, fills must be realistically simulated by walking the recorded top-25 depth book. For other contracts, a conservative tiered slippage model is mandatory.
   - **Explicit New-Listing Funding Cost Model:** New listings on Bybit frequently experience volatile funding rates ($\pm 0.50\%$ to $\pm 2.00\%$ per 8h/4h interval). Because H-A holds Short positions for up to 24 hours, the trade spans up to three funding intervals. All accrued funding must be computed directly from forward-recorded `funding_rates` records:
     $$\text{Net Trade PnL} = \text{Gross Price Return} - \text{Taker Roundtrip (0.11\%)} - \text{Slippage} + \sum_{i} \text{Funding Accrued}_i$$
     *(If funding is positive, holding short collects funding; if funding is negative, holding short pays funding).*
4. **Multiple-Testing Correction for Clean Forward Data:**
   - **Scope Distinction:** Earlier trials (#1–#51 documented in `research/REPORT_V2.md`) were executed on historical backtest data that was permanently purged, survivorship-biased, and disqualified. The forward-recorded dataset represents a completely clean, independent, out-of-sample data regime.
   - **Forward Family Family-Wise Error Rate (FWER):** Corrected for the $m = 2$ forward hypotheses tested on recorded data:
     $$\alpha_{\text{forward}} = \frac{0.05}{2} = 0.025$$
   - Two-tailed significance hurdle: **$t \ge 2.24$** (or one-tailed $t \ge 2.05$).

---

## 2. Theoretical Prior Probabilities & Frictional Drag in R Units

### 2.1 Honest Prior Assessment (Subjective Judgment)
> [!NOTE]
> The prior probabilities below represent **subjective Bayesian judgment** based on market microstructure analysis and institutional competition, **not empirical or statistical estimates**.

- **H-A (New-Listing Supply Overhang Breakdown): Moderate Prior (~40% Subjective Judgment).**
  Structural token unlock schedules, private investor delta hedging, and retail launch-day FOMO create genuine, macro-level structural selling pressure that persists over hours and days. Frictional drag is relatively small compared to average listing volatility.
- **H-B (Liquidation Cascade Exhaustion Snapback on BTC/ETH): Low Prior (<=20% Subjective Judgment).**
  High-frequency market makers and institutional prop desks (Wintermute, Flow Traders, Jump) run collocated FPGA/C++ engines directly in Bybit's data center with sub-millisecond execution. An off-exchange retail/cloud bot operating over public REST/WebSocket faces 50–150ms of network latency. By the time our bot confirms a 1-minute exhaustion bar, institutional liquidity providers have already quoted the snapback. Furthermore, trading tight stops in high volatility exposes the strategy to extreme fee drag. **H-B is likely to fail under audited friction.**

### 2.2 Expected Frictional Drag in R Units
Assuming standard Bybit VIP0 fees (0.055% taker $\times 2 = 0.11\%$ roundtrip) plus conservative adverse slippage (0.050% roundtrip) = **0.160% roundtrip execution friction**.

| Hypothesis | Typical Stop Distance ($1.0\text{ R}$) | Execution Friction (Roundtrip) | Frictional Drag in R Units | Impact on Edge |
| :--- | :--- | :--- | :--- | :--- |
| **H-A (Listings)** | $\sim 4.00\%$ ATR distance | $0.160\%$ | **$0.040\text{ R}$ per trade** | $4.0\%$ of risk budget (Manageable) |
| **H-B (Liquidations)** | $\sim 0.80\%$ cascade extreme distance | $0.160\%$ | **$0.200\text{ R}$ per trade** | **$20.0\%$ of risk budget (Severe headwind)** |

*Key Takeaway:* On H-B, execution friction consumes **one-fifth ($20\%$) of the total risk budget on every single trade**. The gross expectancy must exceed $+0.30\text{ R}$ simply to achieve a net $+0.10\text{ R}$.

### 2.3 Required Sample Mean Expectancy for Tier 2 Significance
Under typical crypto outcome variance where trade returns exhibit standard deviation $\sigma \approx 1.25\text{ R}$:
$$t = \frac{\bar{x}}{\sigma / \sqrt{N}} \ge 2.24 \implies \bar{x} \ge 2.24 \times \frac{\sigma}{\sqrt{N}}$$

- **For H-A ($N = 30$, $\sigma = 1.25\text{ R}$):** Required sample mean expectancy is **$\bar{x} \ge +0.511\text{ R}$** (or $\ge +0.409\text{ R}$ if $\sigma = 1.0\text{ R}$).
- **For H-B ($N = 50$, $\sigma = 1.20\text{ R}$):** Required sample mean expectancy is **$\bar{x} \ge +0.380\text{ R}$** (or $\ge +0.317\text{ R}$ if $\sigma = 1.0\text{ R}$).

*Implication:* A marginal edge (e.g. $+0.08\text{ R}$) cannot achieve statistical significance at $N=30$; the strategy must achieve substantial economic expectancy to clear the Tier 2 hurdle.

---

## 3. Pre-Registered Candidate Hypotheses

### 3.1 Hypothesis A (H-A): New-Listing Initial Supply Overhang Breakdown (Forward #1)

#### A. Economic & Structural Rationale: "Who is on the other side?"
1. **The Counterparty Who Loses:** Speculative retail traders entering market long orders driven by launch-day hype and FOMO. Early buyers suffer severe taker slippage and pay massive positive funding rates to hold leveraged longs.
2. **The Structural Seller:** Early venture investors, foundation treasuries, and airdrop recipients who hold spot tokens that are unlocking over launch schedules. These institutions cannot immediately dump spot on illiquid decentralized venues without collapsing price; instead, they hedge their spot holdings by shorting the newly listed perpetual futures contract on Bybit to lock in dollar value.
3. **The Edge:** Once the initial retail buying wave peaks (typically within the first 60 to 120 minutes), the structural hedging supply overhang and lack of continuous natural buy pressure causes a sharp downward breakdown. We trade in the direction of the structural hedging flow (Short).

#### B. Universe & Sample Eligibility
- **Universe:** Any newly listed linear USDT perpetual contract detected by the recorder's hourly snapshot that satisfies the Crypto-Only filter.
- **Out-of-Sample Window:** Evaluated strictly from its recorded launch minute (`launchTime`).
- **Empirical Crypto-Only Listing Frequency (Audited 2026-10-27):** **7.42 crypto listings / month** (~1.71 listings/week).
- **Target Sample Size:** $N \ge 30$ clean forward-recorded listings with verified top-25 depth.
- **Revised Earliest Reachable Date for $N \ge 30$:** **Mid-March 2027 (~4.5 to 5 months from recorder activation)**.

> [!IMPORTANT]
> **Pre-Registered Amendment (Dated: 2026-10-27, Enacted Prior to Outcome Analysis): Empirical Crypto Listing Rate & Feasibility**
> 1. **Empirical Listing Rate Over Last 12 Months (from `launch_time` of the 522 crypto contracts):**
>    - Empirical query of all 522 confirmed crypto perpetual contracts (`symbolType in ['', 'innovation']`) launched across the past 12 completed months yields exactly **89 new crypto listings**:
>      - `2025-10`: 5 listings | `2025-11`: 10 listings | `2025-12`: 11 listings
>      - `2026-01`: 11 listings | `2026-02`: 5 listings | `2026-03`: 6 listings
>      - `2026-04`: 5 listings | `2026-05`: 5 listings | `2026-06`: 10 listings
>      - `2026-07`: 1 listing | `2026-08`: 7 listings | `2026-09`: 9 listings | `2026-10`: 4 listings (MTD)
>    - **Mean Monthly Arrival Rate:** $\lambda = \frac{89}{12} = \mathbf{7.42\text{ crypto listings / month}}$ ($\approx 1.71\text{ listings / week}$).
> 2. **Expected Earliest Date for $N \ge 30$ in H-A:**
>    - Pure arrival timeline: $\frac{30}{7.42} \approx 4.04\text{ months}$ (123 calendar days).
>    - Required margin for depth coverage qualification: H-A strictly mandates full top-25 orderbook depth from `launchTime + 1h` to `launchTime + 6h`. Assuming an 85% capture/qualification rate (accounting for exchange-side delays or network reconnects), reaching 30 qualified events requires $N_{\text{gross}} \approx \frac{30}{0.85} \approx 35.3\text{ listings}$, which requires $\frac{35.3}{7.42} \approx \mathbf{4.76\text{ months}}$ (145 calendar days).
>    - Measured from the start of clean forward recording (2026-10-24 16:18 UTC), the expected earliest date to reach $N \ge 30$ qualified listings is **March 10 – March 20, 2027**.
> 3. **Proposed New Decision Date: March 15, 2027 (2027-03-15)**
>    - The original provisional date (February 15, 2027) provided only ~3.7 months (~27 arrivals), which would fall short of the statistical power requirements. The Decision Date is hereby formally updated to **March 15, 2027**.
> 4. **Feasibility Assessment:**
>    - **Medium-Term Feasibility: FEASIBLE.** At ~7.42 listings per month, gathering a sample of $N=30$ is statistically feasible within 4.5–5 months of continuous, unattended recorder daemon execution.
>    - **Short-Term Feasibility: NOT FEASIBLE.** Any evaluation on a short horizon (e.g. 2 to 6 weeks) is strictly impossible because fewer than 10 crypto listings will occur. Evaluating H-A with $N < 30$ would incur severe small-sample variance, violating the pre-registered sample size requirement and statistical validity. H-A must remain in unattended, passive recording mode until March 2027.
> 5. **Crypto-Only Universe Filter Rule:**
>    - Confirmed: H-A applies exclusively to native crypto perpetual contracts (`symbolType in ['', 'innovation']`). All non-crypto linear contracts (stocks, ETFs, commodities, forex) are permanently excluded. Current baseline: 522 crypto contracts in universe; 289 non-crypto excluded; 0 unknown contracts. Forward snapshots must record `symbolType` and reject `UNKNOWN` contracts.
> 6. **Forward Evaluation Eligibility Criteria:**
>    - Must be detected within 60 minutes of exchange listing (`detected_at - launch_time <= 3600000`).
>    - Must have full top-25 orderbook depth coverage spanning the evaluation window from `launchTime + 1h` (minute 60) to `launchTime + 6h` (minute 360). Contracts first seen > 60m after launch (e.g. 35h post-launch) or missing depth across the hour 1 to hour 6 execution window are disqualified.


#### C. Exact Entry & Signal Logic
- Timeframe: 5-minute candles aggregated from forward-recorded 1-minute klines.
- **Reference Window:** First 60 minutes (twelve 5m bars) from `launchTime` defines the initial price discovery range:
  - $H_{\text{init}} = \max(\text{High}[0..11])$
  - $L_{\text{init}} = \min(\text{Low}[0..11])$
  - $\text{VWAP}_{\text{init}} = \frac{\sum (\text{TypicalPrice} \times \text{Volume})}{\sum \text{Volume}}$ over bars $0..11$.
- **Short Entry Trigger (Evaluated at 5m Close):**
  - Time constraint: Between minute 60 and minute 360 (hours 1 to 6 post-listing).
  - Condition: 5m $\text{Close}[t] < L_{\text{init}}$ AND 5m $\text{Close}[t] < \text{VWAP}_{\text{init}}$.
  - Execution: Market short filled at Open of bar $t+1$ by walking the recorded top-25 order book.

#### D. Exit Logic & Risk Management
- **Initial Stop Loss:** Placed at $\text{VWAP}_{\text{init}}$ or entry price $+ 2.0 \times \text{ATR}(14)$ (whichever is tighter). Distance to stop defines $1.0\text{ R}$.
- **Profit Target:** Fixed $+2.0\text{ R}$ limit order (or book walk).
- **Time Stop:** 24 hours (288 five-minute bars) post-entry. If neither stop nor target is hit within 24h, close position at market.

---

### 3.2 Hypothesis B (H-B): Liquidation Cascade Exhaustion Snapback (Forward #2)

#### A. Economic & Structural Rationale: "Who is on the other side?"
1. **The Counterparty Who Loses:** Over-leveraged long traders whose positions are forcibly liquidated by Bybit's liquidation engine.
2. **The Structural Driver:** During a market flush, cascading margin liquidations are executed as aggressive, non-discretionary market sell orders by the exchange matching engine at bankruptcy price. These forced market orders violently consume bids, punching deep temporary liquidity holes into the order book far below fair equilibrium value.
3. **The Edge:** Forced liquidation orders are completely price-insensitive. The instant the cascade exhausts (the margin deficit is cleared), aggressive forced selling drops to zero. Liquidity providers and cross-exchange arbitrageurs rush into the order book to re-quote bids, producing a rapid, mean-reverting upward snapback. We enter Long immediately upon cascade exhaustion.

#### B. Universe & Sample Eligibility
- **Universe:** `BTCUSDT` and `ETHUSDT` (evaluated on 1-minute klines and high-frequency order books).
- **Target Sample Size:** $N \ge 50$ distinct cascade events.

#### C. Exact Definition of Liquidation Cascade Cluster
- **Cluster Detection Window:** Rolling 5-minute window ($t-4$ to $t$).
- **Thresholds (Fixed in advance):**
  - **Liquidation Cluster:** Total recorded long liquidations in 5 minutes $\ge \$1,500,000$ for `BTCUSDT` (or $\ge \$750,000$ for `ETHUSDT`).
  - **Open Interest Drop:** $\Delta \text{OI}_{5\text{m}} \le -1.5\%$ (confirms genuine margin wipeout rather than spot dumping).
  - **Price Extension:** 5m price change $\le -1.8 \times \text{ATR}(14)$.

#### D. Exact Entry Trigger
- Following a qualified liquidation cluster, wait for the first **1-minute exhaustion confirmation candle**:
  - `Close[t] > Open[t]` (first green 1m candle) AND `Close[t] > High[t-1]`.
- **Execution:** Long filled at Open of bar $t+1$ by walking the recorded order book.

#### E. Exit Logic & Risk Management
- **Initial Stop Loss:** Placed $0.3 \times \text{ATR}(14)$ below the absolute lowest low of the liquidation cascade. Distance defines $1.0\text{ R}$.
- **Profit Target:** $+1.5\text{ R}$ limit order or return to pre-cascade 15m VWAP.
- **Time Stop:** 45 minutes (45 one-minute bars). If neither stop nor target is reached in 45m, close at market.

#### F. Liquidation Feed Completeness Verification Check Plan (7-Day Audit)
> [!IMPORTANT]
> The completeness of Bybit's WebSocket `allLiquidation` stream is treated as **unverified**. To prevent acting on unverified feed assumptions, a 7-day empirical validation audit must be completed before any H-B evaluation:
> 1. **Protocol:** For every 5-minute candle where recorded Open Interest drops by $\Delta \text{OI} \le -1.0\%$ on `BTCUSDT` or `ETHUSDT`:
>    - Sum all recorded liquidation volume $\sum V_{\text{liq}}$ in that window.
>    - Compare against the absolute Open Interest reduction: $|\Delta \text{OI}|$.
>    - Compute the capture ratio: $\text{Ratio} = \frac{\sum V_{\text{liq}}}{|\Delta \text{OI}|}$.
> 2. **Evaluation:** Determine whether the stream captures a stable proportion ($>60\%$) of margin liquidations, or if severe surges trigger exchange packet dropping. If the capture ratio drops below 40% during major cascades, H-B cluster thresholds will be formally documented as under-sampling before any live decision.

---

## 4. Operational Rules: Exclusions & No-Peeking Mandate

### 4.1 Missing Depth Data Exclusion Rule
If a new listing event (for H-A) or a liquidation cascade (for H-B) occurs during an unrecorded period or recorder outage where top-25 depth snapshots are missing during the entry/execution window, **that event is STRICTLY EXCLUDED from the clean evaluation sample.**
- No synthetic interpolation or spot-book proxy fills are permitted.
- The event must be flagged as `EXCLUDED_MISSING_DEPTH` in the append-only research log.

### 4.2 The "No-Peeking" Governance Rule
Until the minimum pre-registered sample size ($N \ge 30$ for H-A; $N \ge 50$ for H-B) is completely fulfilled:
- **STRICT PROHIBITION:** No operator, script, or agent may inspect, compute, or plot cumulative PnL, equity curves, win rates, or trade return outcomes.
- **PERMITTED ONLY:** Operational data-quality reports (record counts, gap audits, ingestion freshness, disk usage, and recorded event counters).
- *Rationale:* Inspecting intermediate trade returns induces psychological bias, encouraging the operator to terminate a valid strategy during early drawdown or prematurely declare victory during early positive variance.

---

## 5. Two-Tier Evaluation Gates & Inconclusive Rule

### 5.1 Two-Tier Pass / Fail Gates

| Criterion | Tier 1: "Continue Paper Trading" Gate | Tier 2: "Eligible for Live" Gate (Strict) |
| :--- | :--- | :--- |
| **Sample Size** | $N \ge 15$ events | $N \ge 30$ (H-A) / $N \ge 50$ (H-B) |
| **Net Expectancy** | $> 0.00\text{ R}$ | $\ge +0.40\text{ R}$ (H-A) / $\ge +0.32\text{ R}$ (H-B) |
| **Net Profit Factor ($PF$)** | $\ge 1.05$ | $\ge 1.30$ |
| **Max Drawdown** | $\le 20.0\%$ | $\le 15.0\%$ (H-A) / $\le 12.0\%$ (H-B) |
| **Bootstrap 95% CI Lower** | $> -0.15\text{ R}$ (trending positive) | $> 0.00\text{ R}$ strictly |
| **Random Baseline Test** | $p < 0.10$ | $p < 0.05$ |
| **1-Bar Delay Test** | Net $PF \ge 0.95$ (no catastrophic decay) | Net $PF \ge 1.10$ |
| **Multiple Testing ($t$-stat)**| Informational ($t > 1.0$) | Forward Family $\alpha = 0.025$ ($t \ge 2.24$) |
| **Outcome Action** | Authorizes continued paper recording | Unlocks Go-Live criteria review |

### 5.2 The INCONCLUSIVE Rule
If by the Decision Date (**2027-03-15**, or when minimum $N \ge 30$ qualified listings is reached), the metrics fall into the gray zone (e.g. Net $PF$ between 1.05 and 1.29, or bootstrap CI spans zero $[-0.05\text{ R}, +0.12\text{ R}]$):
1. The official verdict is **INCONCLUSIVE - CONTINUE COLLECTING**.
2. Live trading remains **STRICTLY PROHIBITED**.
3. Paper recording continues until an expanded sample ($N = 60$ for H-A; $N = 100$ for H-B) is gathered or maximum evaluation horizon (6 months) expires.
4. If the strategy has not cleared Tier 2 hurdles by the end of 6 months, it is permanently classified as **FAIL**.
