#!/bin/bash
set -euo pipefail

DRAGNET_USER="${DRAGNET_USER:-dragnet}"
DRAGNET_GROUP="${DRAGNET_GROUP:-dragnet}"
DRAGNET_HOME="${DRAGNET_HOME:-/var/lib/dragnet}"
DRAGNET_RUN="${DRAGNET_RUN:-/run/dragnet}"
SERVICE_SRC="${SERVICE_SRC:-$(dirname "$0")/dragnet.service}"
SERVICE_DST="${SERVICE_DST:-/etc/systemd/system/dragnet.service}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root" >&2
  exit 1
fi

# Create dragnet system user (no login, no home)
if ! id "$DRAGNET_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$DRAGNET_USER"
  echo "Created system user $DRAGNET_USER"
else
  echo "User $DRAGNET_USER already exists"
fi

# Create directories
for dir in "$DRAGNET_HOME" "$DRAGNET_RUN"; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    echo "Created $dir"
  fi
done

chown "$DRAGNET_USER:$DRAGNET_GROUP" "$DRAGNET_HOME"
chmod 0750 "$DRAGNET_HOME"
chown "$DRAGNET_USER:$DRAGNET_GROUP" "$DRAGNET_RUN"
chmod 0750 "$DRAGNET_RUN"

# Copy systemd unit
cp "$SERVICE_SRC" "$SERVICE_DST"
chmod 0644 "$SERVICE_DST"
echo "Installed systemd unit to $SERVICE_DST"

# Reload and enable
systemctl daemon-reload
systemctl enable dragnet.service
systemctl start dragnet.service
echo "Enabled and started dragnet.service"

echo "Installation complete."
