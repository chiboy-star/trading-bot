# Quantitative Strategy Research & Validation Workspace

This workspace (`/research`) provides Python-based tools for data acquisition, quantitative backtesting, walk-forward analysis, parameter sensitivity testing, and parity validation against the live TypeScript trading engine.

---

## 1. Environment Setup

The Python virtual environment uses **Python 3.12** located at `research/.venv`.

### Install Dependencies
```bash
# Activate virtual environment
# Windows PowerShell:
.\research\.venv\Scripts\Activate.ps1

# Install requirements
pip install -r research/requirements.txt
```

### Dependencies
- `pandas` & `numpy`: High-performance numerical and time series operations.
- `ccxt`: Cryptocurrency exchange market data API (Bybit public endpoints).
- `pyarrow`: Apache Parquet columnar storage format.
- `ta` & `scipy`: Technical indicators and statistical calculations.
- `matplotlib`: Strategy equity curves, drawdown plots, and distribution visualizers.
- `dnspython`: Resilient DNS resolver fallback (Google `8.8.8.8` / Cloudflare `1.1.1.1`) to bypass local ISP domain blocking.

---

## 2. Directory Structure

```
research/
├── data/                  # Downloaded Parquet historical datasets
│   ├── BTC_USDT_15m.parquet
│   ├── BTC_USDT_funding.parquet
│   └── ...
├── .venv/                 # Dedicated Python virtual environment
├── downloader.py          # Bybit public endpoint data fetcher (2+ years, pagination, retry)
├── validator.py           # Dataset integrity, gap detection, and outlier auditor
├── strategy.py            # Python parity implementation of Playbooks A, B, C & Vol Breakout (Phase 2)
├── backtest.py            # [DEPRECATED] Event-driven 15m backtester (DEPRECATED: unresolved zero-cost random-entry bias PF 0.745 was never explained; strategy has no edge)
├── evaluate_hypotheses.py # Audited zero-lookahead evaluation engine for macro/daily strategies
├── walk_forward.py        # Out-of-sample walk-forward optimizer & sensitivity analyzer (Phase 3)
├── parity_test.py         # TS vs Python parity assertion suite (Phase 3)
├── REPORT.md              # Empirical findings, expectancy, and strategy verdict (Phase 3)
├── requirements.txt       # Python package requirements
└── README.md              # Research workspace guide
```

---

## 3. Data Collection Pipeline

### Run Historical Data Downloader
Pulls 2+ years of 15m OHLCV and 8-hour funding rates for all 12 monitored pairs:
- **7 Core Pairs:** `BTC/USDT`, `ETH/USDT`, `SOL/USDT`, `SUI/USDT`, `XRP/USDT`, `DOGE/USDT`, `1000PEPE/USDT`
- **5 Satellite Pairs:** `STRK/USDT`, `AKE/USDT`, `TIA/USDT`, `ALT/USDT`, `Q/USDT`

```bash
python research/downloader.py --years 2.0 --timeframe 15m
```

### Run Data Validator
Audits the downloaded Parquet files for duplicate timestamps, candle gaps, corrupt OHLC bounds, and price spikes:
```bash
python research/validator.py --data-dir research/data
```
