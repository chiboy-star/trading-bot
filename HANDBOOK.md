# Market Data Recorder — Operational Handbook

A practical guide for operating, monitoring, and maintaining the Bybit market data recorder 24/7.

---

## 1. System Overview

The recorder is a single Node.js process (`src/recorder/index.ts`) that runs continuously to collect public Bybit data without authentication:
- **WebSocket connections:** 9 parallel shards connected to Bybit public linear stream, subscribing to liquidation events and top-25 order book depth.
- **REST polling:** Periodic requests to retrieve tickers, klines, open interest, and hourly contract specifications.
- **Storage:** Local SQLite database at `data/recorder.db` with WAL mode enabled.

---

## 2. Common Operational Commands

```bash
# Compile TypeScript code
npm run build

# Start continuous recording
npm run recorder

# Run startup self-check and exit
npm run recorder:dry-run

# Print a 24-hour data quality and gap report
npm run recorder:report

# Perform an online SQLite backup of recorder.db
npm run recorder:backup

# Run test suite
npm test
```

---

## 3. Database Maintenance & Backups

### Consistent Online Backups
Because SQLite runs in WAL mode, do not copy the `.db` file directly while the process is writing. Use the built-in backup script, which calls SQLite's Online Backup API:
```bash
npm run recorder:backup
```
Backups are saved by default to `data/backups/recorder_backup_<timestamp>.db`. The script performs a `PRAGMA integrity_check` on the completed copy and keeps the 7 most recent backups.

### Checking Database Health
```bash
# Verify integrity of database
sqlite3 data/recorder.db "PRAGMA integrity_check;"

# Check recent heartbeats
sqlite3 data/recorder.db "SELECT timestamp, active_symbols_count, status, details FROM recorder_heartbeats ORDER BY id DESC LIMIT 5;"

# Check active gaps
sqlite3 data/recorder.db "SELECT * FROM data_gaps WHERE resolved_at IS NULL;"
```

---

## 4. Web Telemetry Dashboard

A minimal Next.js telemetry dashboard is included in `dashboard/`:
- Binds strictly to `127.0.0.1:3000` for security.
- Contains only read-only views querying `data/recorder.db`.
- To access remotely, use an SSH tunnel:
  ```bash
  ssh -L 3000:127.0.0.1:3000 user@remote-server
  ```
  Then open `http://localhost:3000` in your local browser.

---

## 5. Troubleshooting & Recovery

### Rate Limiting (Error 10006 or HTTP 429)
The internal `GlobalRestRateLimiter` enforces a 20 req/s rate limit with an automatic 10-second cooldown on error. If Bybit throttles requests, the recorder will pause and log warnings until tokens refill.

### IP Bans (HTTP 403)
If Bybit blocks public requests with HTTP 403, the client pauses all REST traffic for 30 minutes, then probes with `/v5/market/time` before resuming normal operations.

### Network Outages
When a WebSocket disconnects, the recorder attempts reconnects with exponential backoff and jitter. Once the connection is re-established, the `GapFiller` queries REST endpoints to identify and fill missing 1-minute candle bars.
