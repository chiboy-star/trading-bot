# Formal Statistical Power Analysis & Sample-Size Determination

**Registration Date:** 2026-11-03  
**Document Status:** LOCKED PRE-REGISTRATION ADDENDUM  
**Governance Scope:** Evaluates candidate hypotheses H-A (New-Listing Supply Overhang Breakdown) and H-B (Liquidation Cascade Exhaustion Snapback) on clean forward-recorded Bybit data.  
**Strict Research Protocol:** NO-PEEKING GOVERNANCE ACTIVE. Zero interim PnL, equity curve, or trade return inspection permitted.

---

## 1. No-Peeking Governance Rationale

### Why Early Peeking Is Scientifically Fatal
In systematic quantitative finance and empirical asset pricing (Harvey, Liu, Zhu 2016; Bailey & López de Prado 2014), **interim inspection of cumulative returns or equity curves while a dataset is forming dramatically inflates the False Discovery Rate (FDR)**:

1. **Optional Stopping Bias (Data-Peeking Penalty):**
   If an experimenter repeatedly inspects trade outcomes and stops data collection as soon as the empirical Sharpe ratio or t-statistic looks favorable, the true type I error rate ($\alpha$) inflates from nominal $5\%$ to over $30\%–40\%$. The likelihood of observing a temporary high-water mark purely by random Brownian motion is substantial.
2. **Cognitive Narrative Contamination:**
   Seeing early trade wins or losses leads researchers to retroactively rationalize outcomes ("this token had unusual unlock dynamics", "liquidation cascades in high volatility behave differently"), tempting post-hoc parameter tweaks. This destroys out-of-sample purity.
3. **Pre-Commitment Mandate:**
   To preserve institutional integrity:
   - Sample sizes ($N$) and decision gates must be fixed mathematically in advance based on statistical power.
   - Event frequency may be audited to track dataset accumulation rate, but **zero return or PnL calculations are executed until target $N$ is reached**.

---

## 2. Statistical Power Formulation

Let trade outcomes $X_i$ be independent and identically distributed random variables denominated in units of risk ($R$-multiples), where $1.0R$ equals the initial stop-loss distance:
$$X_i \sim \mathcal{D}(\mu, \sigma^2)$$

We test the null hypothesis of zero economic edge against the directional alternative of positive expectancy:
$$H_0: \mu \le 0 \quad \text{vs.} \quad H_1: \mu \ge \delta > 0$$

Where:
- $\delta$: Minimum Detectable Effect size (net expectancy in $R$-units, e.g., $+0.20R$, $+0.30R$, $+0.40R$).
- $\sigma$: Standard deviation of trade returns in $R$-units ($\sigma \in \{1.0R, 1.5R, 2.0R\}$).
- $\alpha$: Significance level. For two forward candidate hypotheses ($m = 2$), Bonferroni correction yields $\alpha_{\text{forward}} = \frac{0.05}{2} = 0.025$ (two-sided critical value $z_{1-\alpha/2} = 2.24$; one-sided $z_{1-\alpha} = 1.96$).
- $1 - \beta$: Statistical power (probability of correctly rejecting $H_0$ when true expectancy is $\ge \delta$). We compute requirements for both standard $80\%$ power ($z_{1-\beta} = 0.8416$) and high $90\%$ power ($z_{1-\beta} = 1.2816$).

The required sample size $N$ is given by:
$$N = \left( \frac{z_{1 - \alpha} + z_{1 - \beta}}{\delta / \sigma} \right)^2 = \left( \frac{(z_{1-\alpha} + z_{1-\beta}) \cdot \sigma}{\delta} \right)^2$$

---

## 3. Required Sample Size Matrices

### 3.1 Standard Test ($\alpha = 0.05$, Single Hypothesis Benchmark)

#### Target Power: $80\%$ ($1 - \beta = 0.80$, $z_{0.80} = 0.8416$)
| Outcome Volatility ($\sigma$) | MDE $\delta = +0.20R$ | MDE $\delta = +0.30R$ | MDE $\delta = +0.40R$ |
| :--- | :--- | :--- | :--- |
| **Low Volatility ($\sigma = 1.0R$)** | **155 trades** | **69 trades** | **39 trades** |
| **Typical Volatility ($\sigma = 1.5R$)** | **348 trades** | **155 trades** | **87 trades** |
| **Fat-Tailed Volatility ($\sigma = 2.0R$)** | **618 trades** | **275 trades** | **155 trades** |

#### Target Power: $90\%$ ($1 - \beta = 0.90$, $z_{0.90} = 1.2816$)
| Outcome Volatility ($\sigma$) | MDE $\delta = +0.20R$ | MDE $\delta = +0.30R$ | MDE $\delta = +0.40R$ |
| :--- | :--- | :--- | :--- |
| **Low Volatility ($\sigma = 1.0R$)** | **214 trades** | **95 trades** | **54 trades** |
| **Typical Volatility ($\sigma = 1.5R$)** | **481 trades** | **214 trades** | **121 trades** |
| **Fat-Tailed Volatility ($\sigma = 2.0R$)** | **856 trades** | **381 trades** | **214 trades** |

---

### 3.2 FWER-Adjusted Test ($\alpha = 0.025$, Bonferroni-Corrected for $m = 2$ Hypotheses)

For clean forward testing where two candidate hypotheses (H-A and H-B) share the family-wise error budget:
- One-tailed hurdle: $z_{1 - 0.025} = 1.96$
- Two-tailed hurdle: $z_{1 - 0.0125} = 2.24$

#### Target Power: $80\%$ ($1 - \beta = 0.80$, One-Tailed $z = 1.96 + 0.8416 = 2.8016$)
| Outcome Volatility ($\sigma$) | MDE $\delta = +0.20R$ | MDE $\delta = +0.30R$ | MDE $\delta = +0.40R$ |
| :--- | :--- | :--- | :--- |
| **Low Volatility ($\sigma = 1.0R$)** | **197 trades** | **88 trades** | **50 trades** |
| **Typical Volatility ($\sigma = 1.5R$)** | **442 trades** | **197 trades** | **111 trades** |
| **Fat-Tailed Volatility ($\sigma = 2.0R$)** | **785 trades** | **349 trades** | **197 trades** |

#### Target Power: $90\%$ ($1 - \beta = 0.90$, One-Tailed $z = 1.96 + 1.2816 = 3.2416$)
| Outcome Volatility ($\sigma$) | MDE $\delta = +0.20R$ | MDE $\delta = +0.30R$ | MDE $\delta = +0.40R$ |
| :--- | :--- | :--- | :--- |
| **Low Volatility ($\sigma = 1.0R$)** | **263 trades** | **117 trades** | **66 trades** |
| **Typical Volatility ($\sigma = 1.5R$)** | **592 trades** | **263 trades** | **148 trades** |
| **Fat-Tailed Volatility ($\sigma = 2.0R$)** | **1,051 trades** | **467 trades** | **263 trades** |

---

## 4. Application to Hypothesis A (H-A: New-Listing Supply Overhang)

### Strategy Parameters & Economic Profile
- **Structural Model:** Institutional spot delta hedging and foundation unlock selling vs. retail FOMO buyers.
- **Pre-Registered Net Expectancy Hurdle:** $\delta \ge +0.40R$ (net of $0.11\%$ taker fees, slippage, and accrued funding).
- **Assumed Outcome Volatility:** Because positions utilize a fixed $4.0\%$ ATR trailing stop with 24-hour time stop, return variance is moderately bounded: $\sigma \approx 1.20R \text{ to } 1.35R$.
- **Required Sample Size for Significance:**
  Under $\delta = +0.40R$ and $\sigma = 1.25R$:
  $$N = \left( \frac{2.8016 \times 1.25}{0.40} \right)^2 \approx 77 \text{ trades (for } 80\% \text{ power)}$$
  The pre-registered Stage 1 threshold $N = 30$ represents the **minimum statistical hurdle** for Tier 2 evaluation ($t \ge 2.24 \implies \bar{x} \ge 2.24 \times \frac{1.25}{\sqrt{30}} = +0.511R$). At $N = 30$, a large economic edge ($\ge +0.51R$) is mandatory to clear noise. If expectancy is moderate ($+0.30R$), power analysis mandates extending collection to $N \approx 88$ events.

### Empirical Arrival Rate & Timeline
- **Mean Crypto Listing Rate:** $\lambda \approx 7.42 \text{ listings / month}$ (~$1.71 \text{ listings / week}$).
- **Depth Capture Qualification Rate:** Mandates top-25 orderbook depth from $t = \text{launch} + 1\text{h}$ to $t = \text{launch} + 6\text{h}$ (~$85\%$ qualification yield).
- **Expected Calendar Time for $N \ge 30$:** ~4.76 months (145 days) from clean data start.
- **Pre-Registered Decision Date:** **March 15, 2027**.

### Current Dataset State (Audited Post-Epoch Count)
- **Clean Data Epoch (`clean_data_phase2`):** Established `2026-11-03`.
- **Pre-Epoch Historical Listings:** 6 contracts captured during prior development testing.
- **Post-Epoch Qualifying Listings:** **0 contracts** (Recording commences post-cleanup).
- **PnL Inspection Status:** **BLINDED (Zero trade returns or PnL inspected).**

---

## 5. Application to Hypothesis B (H-B: Liquidation Cascade Exhaustion)

### Strategy Parameters & Frictional Realities
- **Structural Model:** Forced margin liquidations trigger transient orderbook depletion; mean reversion follows exhaustion bar.
- **Pre-Registered Net Expectancy Hurdle:** $\delta \ge +0.32R$.
- **Severe Frictional Drag Reality:**
  - Roundtrip VIP0 taker fee: $0.110\%$.
  - Adverse execution slippage in cascade: $0.050\%$.
  - Total friction: $0.160\%$.
  - With typical cascade stop distance of $0.80\%$, **frictional drag consumes exactly $0.200R$ (20% of risk budget) per trade**.
  - A gross expectancy of $+0.52R$ is required simply to yield a net $+0.32R$.
- **Assumed Outcome Volatility:** Liquidations exhibit fat tails and high variance: $\sigma \approx 1.50R \text{ to } 2.00R$.
- **Required Sample Size for Significance:**
  Under $\delta = +0.32R$ and $\sigma = 1.50R$:
  $$N = \left( \frac{2.8016 \times 1.50}{0.32} \right)^2 \approx 173 \text{ trades (for } 80\% \text{ power)}$$
  Under $\sigma = 2.00R$:
  $$N = \left( \frac{2.8016 \times 2.00}{0.32} \right)^2 \approx 307 \text{ trades}$$
  The pre-registered minimum hurdle of $N = 50$ trades represents an initial screening threshold. If $\sigma \ge 1.5R$, reaching statistical significance requires between 173 and 307 verified cascade events.

### Current Dataset State (Audited Post-Epoch Count)
- **Total Historical Liquidations in DB:** 78,041 raw liquidation records.
- **Post-Epoch Qualifying Cascades ($\ge \$1.5\text{M}$ on BTC or $\ge \$750\text{k}$ on ETH):** **0 events**.
- **PnL Inspection Status:** **BLINDED (Zero trade returns or PnL inspected).**

---

## 6. Pre-Commitment Summary Table

| Evaluation Dimension | Hypothesis A (H-A) | Hypothesis B (H-B) |
| :--- | :--- | :--- |
| **Core Asset Universe** | Forward Linear Crypto Perps | `BTCUSDT`, `ETHUSDT` |
| **Locked Target Sample Size** | **$N \ge 30$** (screen) / **$N \ge 77$** (full power) | **$N \ge 50$** (screen) / **$N \ge 173$** (full power) |
| **Required Net Expectancy ($\bar{x}$)** | $\ge +0.40R$ (net of funding & friction) | $\ge +0.32R$ (net of 20% drag) |
| **Target Decision Milestone** | **March 15, 2027** | Upon reaching $N \ge 50$ clean cascades |
| **Post-Epoch Sample Count to Date** | **0 / 30** | **0 / 50** |
| **Unblinding Condition** | Reaching $N \ge 30$ clean qualified events | Reaching $N \ge 50$ clean qualified events |
| **Interim PnL Inspection Rule** | **STRICTLY PROHIBITED (Zero Peeking)** | **STRICTLY PROHIBITED (Zero Peeking)** |
