#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/trading-bot}"
DB_DIR="${PROJECT_DIR}/data"
ALERT_THRESHOLD_PCT=80 # Alert when disk usage >= 80% (free space < 20%)

mkdir -p "${DB_DIR}"

# Get disk usage percentage of partition hosting DB
USAGE_PCT="$(df -P "${DB_DIR}" | awk 'NR==2 {sub(/%/, "", $5); print $5}')"
AVAILABLE_GB="$(df -BG "${DB_DIR}" | awk 'NR==2 {sub(/G/, "", $4); print $4}')"

echo "[DISK_GUARD] Partition usage: ${USAGE_PCT}% | Available: ${AVAILABLE_GB}GB"

if [ "${USAGE_PCT}" -ge "${ALERT_THRESHOLD_PCT}" ]; then
    MSG="[WARNING] Recorder storage disk usage reached ${USAGE_PCT}% (${AVAILABLE_GB}GB free). Free disk space is below 20% threshold!"
    echo "[DISK_GUARD] ALERT: ${MSG}" >&2

    # Send Discord webhook if configured
    if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
        curl -s -X POST -H "Content-Type: application/json" \
            -d "{\"content\":\"**[DISK GUARD ALERT]** ${MSG}\"}" \
            "${DISCORD_WEBHOOK_URL}" || true
    fi
    exit 1
fi

echo "[DISK_GUARD] Disk capacity healthy."
exit 0
