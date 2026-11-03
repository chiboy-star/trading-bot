# 24/7 Zero-Cost Deployment Guide

This guide details how to run the Bybit Market Data Recorder 24/7 at **$0.00 total monthly cost** with automated systemd management, online backups, and dead-man's switch alerting.

---

## 1. Hosting Architecture: Oracle Cloud Always Free

Oracle Cloud Infrastructure (OCI) offers an **Always Free Tier** that provides ample compute and disk capacity permanently for zero cost.

### Compute Specification
- **Shape:** `VM.Standard.A1.Flex` (ARM Ampere A1 Architecture)
- **Allocation:** Up to 4 OCPUs and 24 GB RAM (can be partitioned into 1–4 VMs)
- **Boot Volume:** Up to 200 GB total storage included free
- **Bandwidth:** 10 TB/month outbound data transfer free

### Crucial Region Selection (Non-US Regions Only)
> [!IMPORTANT]
> **Do NOT select a US data center** (such as US East Ashburn, US West Phoenix, or San Jose).
> Bybit enforces strict geographic IP restrictions and blocks incoming connections originating from United States IP ranges.
> 
> **Recommended Non-US Always Free Regions:**
> - **Singapore:** `ap-singapore-1` (optimal proximity to Bybit matching engines)
> - **Tokyo:** `ap-tokyo-1`
> - **Seoul:** `ap-seoul-1`
> - **Frankfurt:** `eu-frankfurt-1`
> - **Amsterdam:** `eu-amsterdam-1`

### Oracle Idle VM Reclamation Avoidance
Oracle Cloud will automatically reclaim idle Always Free instances if, over a 7-day span:
1. CPU utilization is less than 20%
2. Network utilization is less than 20%
3. Memory utilization is less than 20%

**Why the Recorder Naturally Avoids Reclamation:**
The Bybit Market Data Recorder actively runs 9 concurrent WebSocket connections streaming depth snapshots, liquidations, and ticker updates across 808+ perpetual contracts. This persistent network I/O and event loop processing keeps the instance actively engaged, preventing idle reclamation.

---

## 2. Automated Bootstrap (Ubuntu 22.04 / 24.04 LTS)

On your freshly provisioned Ubuntu cloud instance, clone the repository and run the idempotent setup script:

```bash
# 1. Clone repository
sudo git clone https://github.com/<your-username>/trading-bot.git /opt/trading-bot
cd /opt/trading-bot

# 2. Configure environment
sudo cp .env.example .env
sudo nano .env  # Optional: Add DISCORD_WEBHOOK_URL or HEALTHCHECK_URL

# 3. Run bootstrap script
sudo bash deploy/setup.sh
```

The `setup.sh` script automatically:
- Installs Node.js 22 LTS, build-essential, git, and sqlite3
- Creates a dedicated non-root service user `recorder`
- Compiles the TypeScript bundle (`npm run build`)
- Installs and enables `recorder.service` (auto-restarts on boot/failure)
- Installs and enables `recorder-backup.timer` (daily online SQLite backup at 03:00 UTC)
- Configures an hourly disk guard cron job to monitor free disk capacity

---

## 3. Operational Commands & Maintenance

### Monitor Live Logs
```bash
# Follow live recorder service output
journalctl -u recorder.service -f

# Follow backup timer output
journalctl -u recorder-backup.service -f
```

### Service Controls
```bash
# Check service status
sudo systemctl status recorder.service

# Restart recorder
sudo systemctl restart recorder.service

# Stop recorder
sudo systemctl stop recorder.service
```

### Generate Data Quality Report Remotely
```bash
cd /opt/trading-bot
npm run recorder:report
```

---

## 4. Dead-Man's Switch (healthchecks.io)

To receive immediate alerts if the server crashes, power drops, or internet fails without paying for monitoring services:

1. Create a free account at [healthchecks.io](https://healthchecks.io) (free tier includes 20 checks).
2. Create a new check with:
   - **Period:** `5 minutes`
   - **Grace Time:** `2 minutes`
3. Copy your unique ping URL: `https://hc-ping.com/<uuid>`.
4. Add the URL to `/opt/trading-bot/.env`:
   ```env
   HEALTHCHECK_URL=https://hc-ping.com/your-uuid-here
   ```
5. Restart the service (`sudo systemctl restart recorder.service`).
The recorder service pings this URL on every heartbeat cycle when all streams are confirmed healthy. If the recorder halts or dies, healthchecks.io will notify you via email, Discord, or Telegram within 7 minutes.

---

## 5. Daily Backup & Disaster Recovery

### Automatic Daily Backup
- `deploy/recorder-backup.timer` triggers `deploy/backup.sh` every day at `03:00 UTC`.
- It executes a non-blocking online snapshot using SQLite's backup API (`.backup`), safe during concurrent WAL writes.
- Verifies integrity of the backup file via `PRAGMA integrity_check`.
- Retains 7 days of local backups in `/var/backups/recorder/` and automatically deletes older files.

### Manual Database Restore
To restore from a backup:
```bash
# 1. Stop recorder
sudo systemctl stop recorder.service

# 2. Restore desired snapshot
sudo cp /var/backups/recorder/recorder_backup_YYYYMMDD_HHMMSS.db /opt/trading-bot/data/recorder.db

# 3. Ensure proper permissions
sudo chown recorder:recorder /opt/trading-bot/data/recorder.db

# 4. Restart recorder
sudo systemctl start recorder.service
```

### Optional Offsite Sync (Free Cloud Tiers)
You can automatically sync daily backups offsite using `rclone` (e.g. to a free 10 GB Backblaze B2 bucket or 15 GB Google Drive):
```bash
# Configure rclone remote
rclone config  # name it e.g. "b2-free"

# In /opt/trading-bot/.env, set:
RCLONE_REMOTE=b2-free:my-recorder-backups
```
`deploy/backup.sh` will automatically upload the verified snapshot to your remote bucket after each local backup.

---

## 6. Windows Local Fallback (NSSM Service)

If you prefer to run the recorder on a local Windows machine instead of Linux:

1. Download **NSSM** (Non-Sucking Service Manager) from [nssm.cc](https://nssm.cc/download).
2. Open Administrator PowerShell and install the service:
   ```powershell
   # Install service
   nssm install BybitRecorder "C:\Program Files\nodejs\node.exe" "C:\Users\<user>\Downloads\trading-bot\dist\src\recorder\index.js"
   
   # Set working directory
   nssm set BybitRecorder AppDirectory "C:\Users\<user>\Downloads\trading-bot"
   
   # Configure auto-restart
   nssm set BybitRecorder AppRestartDelay 5000
   
   # Start service
   nssm start BybitRecorder
   ```
3. To view service status in Windows:
   ```powershell
   Get-Service BybitRecorder
   ```
