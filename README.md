# Bybit Market Data Recorder

A continuous, zero-cost market data recorder capturing forward, survivorship-unbiased cryptocurrency futures data from public Bybit V5 endpoints.

No live trading code exists in this repository. No API keys or paid services are required.

---

## 1. Overview & Data Collected

The service records continuous public exchange data directly into an append-only SQLite database (`data/recorder.db` in WAL mode):

- **Contract Snapshots:** Hourly snapshot of all active linear perpetual contracts (~808 symbols), recording launch timestamps, contract specifications, and status changes.
- **Listing Events:** Detection log capturing new listings within their first hour of trading to avoid survivorship bias.
- **1-Minute Klines:** Closed 1-minute OHLCV candles across active symbols.
- **Funding Rates:** 8-hour / 4-hour historical settled funding rates.
- **Open Interest:** Aggregated contract open interest in base asset and quote USD terms.
- **Liquidations:** Real-time forced market liquidation events streamed via public WebSocket (`allLiquidation`).
- **Order Book Depth:** Top-25 bid and ask depth snapshots for BTC, ETH, and newly listed contracts ($< 72\text{h}$).

Historical directional trading strategies have been decommissioned; see [docs/RETIRED_STRATEGY.md](docs/RETIRED_STRATEGY.md).

---

## 2. Quick Start

### Prerequisites
- Node.js 22 LTS or newer
- npm 10+

### Setup & Run
```bash
# 1. Install dependencies
npm install

# 2. Build TypeScript sources
npm run build

# 3. Start the recorder daemon
npm run recorder

# Or run a single startup self-check dry run
npm run recorder:dry-run
```

### Quality Reports & Telemetry
```bash
# Generate a terminal data quality report
npm run recorder:report

# Run the local read-only web dashboard (bound to 127.0.0.1:3000)
npm run dashboard:build
npm run dashboard:start
```

---

## 3. Storage & Immutability

Data is stored in `data/recorder.db` using SQLite with Write-Ahead Logging (`WAL` mode). 
Row-level append-only triggers prevent accidental updates or deletions on recorded datasets (`klines_1m`, `liquidations`, `orderbook_snapshots`, `funding_rates`, `open_interest`, `contract_snapshots`).

Backups can be generated without stopping the recorder using:
```bash
npm run recorder:backup
```

---

## 4. Testing

Run the test suite:
```bash
npm test
```
All tests use in-memory SQLite instances and mock network clients.
