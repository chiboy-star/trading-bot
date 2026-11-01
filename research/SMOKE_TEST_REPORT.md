# Bybit Market Data Recorder - 90-Second Smoke Test & Reconnection Report

**Execution Mode:** Forward-Looking Unbiased Market Data Recorder (LIVE RECONNECTION SMOKE TEST)  
**Execution Duration:** **90 Seconds** (Executed on live Bybit public endpoints)  
**Outage Method:** WebSocket-only network severing injected at T+35s for 8 seconds  
**Scope Notice:** This was a **short-duration mechanical smoke test (90s)** verifying WebSocket shard distribution, deliberate socket severing, and automated reconnection backoff. **It is NOT a long-run validation.** True long-run validation will be established across the real recorder's initial 24 and 72 hours of uninterrupted forward execution.  
**Execution Environment:** Node.js v24.18.0, Windows 11, SQLite 3 WAL Mode  
**Test Profile:** Full Linear USDT Universe (808 Contracts, 9 Sharded WebSockets)

---

## 1. System Stability & Memory Profile (90-Second Window)

| Metric | Start | End | Delta | Assessment |
| :--- | :--- | :--- | :--- | :--- |
| **Heap Memory Used** | **14.60 MB** | **16.92 MB** | **+2.32 MB** | Bounded in short run; requires 24h/72h observation |
| **Process RSS** | **90.83 MB** | **97.76 MB** | **+6.93 MB** | Normal V8 engine runtime buffer |
| **Database File Size** | **0.00 MB** | **1.55 MB** | **+1.55 MB** | Clean initial table writes & WAL allocation |

---

## 2. Ingestion Record Totals During 90s Smoke Run

| Table / Stream | Recorded (90s) | Notes |
| :--- | :--- | :--- |
| **Hourly Contract Snapshots** | **808** | All 808 linear USDT contracts snapshotted append-only |
| **1-Minute Klines** | **995** | Ingested via continuous round-robin poller across contracts |
| **Funding Rates** | **814** | Periodic rates across universe |
| **Open Interest** | **4,884** | 6 batch polls across 814 contracts |
| **Public Liquidations** | **3** | Real-time events captured via Bybit V5 WS (`JCTUSDT`, `INJUSDT`) |
| **Order-Book Depth (Top 25)** | **43** | Sampled at 10s for BTC, ETH |
| **Heartbeats Logged** | **6** | Periodic health and silence records |

---

## 3. Deliberate WebSocket Severing & Reconnection Audit

- **Deliberate Outage Injected:** YES (All 9 WebSocket shards disconnected at T+35s; restored at T+43s).
- **Outage Scope:** WebSocket-only socket drop (REST polling remained active in background).
- **Reconnection Attempts Handled:** **18** (2 attempts per shard).
- **Recovery Behavior:**
  - Sockets detected disconnection immediately upon socket severing.
  - Sockets initiated exponential backoff (`1s → 2s → 4s`).
  - Dual-host fallback (`stream.bybit.com` ↔ `stream.bytick.com`) engaged.
  - All 9 shards restored to `CONNECTED` status within ~8 seconds of socket restoration.
- **Data Gaps Detected:** **0**
- **Data Gaps Unresolved:** **0**

---

## 4. Next Validation Step: Real 24h & 72h Soak

Mechanical reconnection, sharding, and trigger immutability are verified in this smoke test. Long-term memory stability, connection drift under ISP disruptions, and full multi-hour kline continuity will be measured and reported directly from the recorder's first 24-hour and 72-hour operational logs.
