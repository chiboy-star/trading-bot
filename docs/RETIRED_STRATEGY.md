# Retired Strategy Summary (15m Intraday Trend Following)

- **Strategy Tested:** 15-minute multi-coin directional trend following using technical indicators (EMA 20/50 crossovers, RSI momentum bounds, ADX trend filtering, Bollinger and Donchian breakouts) across 12 Bybit perpetual contracts.
- **Evaluation Period:** 2-year historical backtest (October 2024 – October 2026) validated with 100.00% numerical parity against the live execution engine.
- **Audited Metrics:**
  - Total Evaluated Trades: 22,969 trades
  - Aggregate Profit Factor: 0.61
  - Max Drawdown: 100% (complete capital depletion)
  - Friction Drag: Over $6,985 lost to taker fees (0.055% to 0.06% per side) and execution slippage.
- **Primary Reasons for Retirement:**
  1. **Negative Net Expectancy:** After realistic taker fee rates, adverse slippage, and bidirectional 8h funding accruals, technical indicator crossovers fail to provide predictive alpha on 15m intraday crypto data.
  2. **Exchange Survivorship Bias:** Bybit permanently deletes delisted, bankrupt, and restructured contracts from its historical REST endpoints. Backtests on survivor coins systematically underestimate tail risks and downside drawdowns.
  3. **Strategic Pivot:** All directional trading execution was terminated. The codebase was repurposed strictly as an institutional market-data recorder capturing forward, survivorship-unbiased exchange data.

