#!/usr/bin/env bash
set -euo pipefail

# Configuration
PROJECT_DIR="${PROJECT_DIR:-/opt/trading-bot}"
DB_PATH="${DB_PATH:-${PROJECT_DIR}/data/recorder.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/recorder}"
TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/recorder_backup_${TIMESTAMP}.db"
LOG_PREFIX="[RECORDER_BACKUP]"

mkdir -p "${BACKUP_DIR}"

echo "${LOG_PREFIX} Starting SQLite online backup from ${DB_PATH}..."

if [ ! -f "${DB_PATH}" ]; then
    echo "${LOG_PREFIX} ERROR: Database file does not exist at ${DB_PATH}!" >&2
    exit 1
fi

# 1. Perform online consistent snapshot via SQLite .backup API (safe during WAL writes)
if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"
else
    # Fallback to node backup runner
    cd "${PROJECT_DIR}"
    node -e "
    const Database = require('better-sqlite3');
    const db = new Database('${DB_PATH}');
    db.backup('${BACKUP_FILE}')
        .then(() => { process.exit(0); })
        .catch(err => { console.error(err); process.exit(1); });
    "
fi

# 2. Verify PRAGMA integrity_check on the backup snapshot
echo "${LOG_PREFIX} Verifying integrity of backup snapshot..."
if command -v sqlite3 >/dev/null 2>&1; then
    INTEGRITY="$(sqlite3 "${BACKUP_FILE}" "PRAGMA integrity_check;")"
    if [ "${INTEGRITY}" != "ok" ]; then
        echo "${LOG_PREFIX} FATAL: Integrity check failed! Got: ${INTEGRITY}" >&2
        rm -f "${BACKUP_FILE}"
        exit 1
    fi
fi

BACKUP_SIZE="$(du -h "${BACKUP_FILE}" | cut -f1)"
echo "${LOG_PREFIX} Backup successful: ${BACKUP_FILE} (${BACKUP_SIZE})"

# 3. Retention: keep last 7 days of backups locally, delete older
echo "${LOG_PREFIX} Pruning backups older than 7 days..."
find "${BACKUP_DIR}" -name "recorder_backup_*.db" -type f -mtime +7 -delete

# 4. Optional: Offsite sync to free cloud tier if rclone remote is configured
if [ -n "${RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
    echo "${LOG_PREFIX} Syncing backup to free remote storage: ${RCLONE_REMOTE}..."
    rclone copy "${BACKUP_FILE}" "${RCLONE_REMOTE}" --transfers 2
    echo "${LOG_PREFIX} Remote offsite sync complete."
fi

echo "${LOG_PREFIX} Backup job finished cleanly at $(date -u)."
