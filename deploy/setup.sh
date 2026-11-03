#!/usr/bin/env bash
set -euo pipefail

# Check root privileges
if [ "${EUID}" -ne 0 ]; then
    echo "ERROR: Please run setup.sh as root (e.g. sudo bash deploy/setup.sh)" >&2
    exit 1
fi

echo "================================================================="
echo "BYBIT MARKET DATA RECORDER - ZERO-COST 24/7 UBUNTU HOST SETUP"
echo "================================================================="

# 1. Update system packages and install core build tools
echo "--> Updating APT packages and installing system tools..."
apt-get update -y
apt-get install -y --no-install-recommends \
    curl \
    git \
    build-essential \
    python3 \
    sqlite3 \
    ca-certificates \
    gnupg

# 2. Install Node.js 22 LTS if not present or < 22
NODE_NEEDS_INSTALL=0
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -v | cut -d'.' -f1 | tr -d 'v')"
    if [ "${NODE_MAJOR}" -lt 22 ]; then
        NODE_NEEDS_INSTALL=1
    fi
else
    NODE_NEEDS_INSTALL=1
fi

if [ "${NODE_NEEDS_INSTALL}" -eq 1 ]; then
    echo "--> Installing Node.js 22 LTS from NodeSource..."
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
    apt-get update -y
    apt-get install -y nodejs
fi

echo "--> Node version: $(node -v) | NPM version: $(npm -v)"

# 3. Create dedicated system user 'recorder'
if ! id -u recorder >/dev/null 2>&1; then
    echo "--> Creating dedicated service user 'recorder'..."
    useradd -r -m -s /bin/bash recorder
fi

# 4. Configure application directories
INSTALL_DIR="/opt/trading-bot"
BACKUP_DIR="/var/backups/recorder"

mkdir -p "${INSTALL_DIR}" "${INSTALL_DIR}/data" "${BACKUP_DIR}"

# If running setup.sh from within a checked-out repo, copy or sync files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ "${REPO_ROOT}" != "${INSTALL_DIR}" ]; then
    echo "--> Copying project repository to ${INSTALL_DIR}..."
    rsync -av --exclude 'node_modules' --exclude '.git' --exclude 'dist' "${REPO_ROOT}/" "${INSTALL_DIR}/"
fi

# 5. Build application
echo "--> Installing npm dependencies and building TypeScript bundle..."
cd "${INSTALL_DIR}"
npm ci
npm run build

# 6. Configure permissions
chown -R recorder:recorder "${INSTALL_DIR}" "${BACKUP_DIR}"
chmod +x "${INSTALL_DIR}/deploy/backup.sh" "${INSTALL_DIR}/deploy/disk_guard.sh"

# 7. Install and enable systemd services and timers
echo "--> Installing systemd unit files..."
cp "${INSTALL_DIR}/deploy/recorder.service" /etc/systemd/system/recorder.service
cp "${INSTALL_DIR}/deploy/recorder-backup.service" /etc/systemd/system/recorder-backup.service
cp "${INSTALL_DIR}/deploy/recorder-backup.timer" /etc/systemd/system/recorder-backup.timer

systemctl daemon-reload
systemctl enable --now recorder.service
systemctl enable --now recorder-backup.timer

# 8. Setup hourly disk guard cron
DISK_GUARD_CRON="/etc/cron.hourly/recorder-disk-guard"
cat << 'EOF' > "${DISK_GUARD_CRON}"
#!/bin/bash
PROJECT_DIR=/opt/trading-bot /opt/trading-bot/deploy/disk_guard.sh >/dev/null 2>&1
EOF
chmod +x "${DISK_GUARD_CRON}"

echo "================================================================="
echo "SETUP COMPLETED SUCCESSFULLY!"
echo "Service status:"
systemctl status recorder.service --no-pager -n 5 || true
echo ""
echo "To monitor recorder live logs: journalctl -u recorder.service -f"
echo "To check backup timer status:  systemctl list-timers recorder-backup.timer"
echo "================================================================="
