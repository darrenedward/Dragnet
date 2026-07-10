#!/bin/bash
set -euo pipefail

echo "=== Podman Rootless Setup Verification ==="
echo ""

DRAGNET_USER="${DRAGNET_USER:-dragnet}"

# Check podman is installed
if ! command -v podman &>/dev/null; then
  echo "FAIL: podman not found. Install podman first."
  exit 1
fi
echo "PASS: podman found: $(podman --version)"

# Check the dragnet user exists
if ! id "$DRAGNET_USER" &>/dev/null; then
  echo "FAIL: user $DRAGNET_USER does not exist. Run install.sh first."
  exit 1
fi
echo "PASS: user $DRAGNET_USER exists"

# Check subuid/subgid for rootless podman
SUBUID=$(grep "^$DRAGNET_USER:" /etc/subuid 2>/dev/null || true)
SUBGID=$(grep "^$DRAGNET_USER:" /etc/subgid 2>/dev/null || true)
if [ -z "$SUBUID" ]; then
  echo "WARN: no subuid mapping for $DRAGNET_USER (needed for rootless podman)"
  echo "  Run: usermod --add-subuids 100000-165535 $DRAGNET_USER"
else
  echo "PASS: subuid configured: $SUBUID"
fi
if [ -z "$SUBGID" ]; then
  echo "WARN: no subgid mapping for $DRAGNET_USER (needed for rootless podman)"
  echo "  Run: usermod --add-subgids 100000-165535 $DRAGNET_USER"
else
  echo "PASS: subgid configured: $SUBGID"
fi

# Check linger is enabled for the dragnet user
LINGER=$(loginctl show-user "$DRAGNET_USER" 2>/dev/null | grep Linger= || true)
if echo "$LINGER" | grep -q "yes"; then
  echo "PASS: linger enabled for $DRAGNET_USER"
else
  echo "WARN: linger not enabled for $DRAGNET_USER (podman systemd services need it)"
  echo "  Run: loginctl enable-linger $DRAGNET_USER"
fi

# Podman socket check (rootless)
PODMAN_SOCKET="/run/user/$(id -u "$DRAGNET_USER")/podman/podman.sock"
if [ -S "$PODMAN_SOCKET" ]; then
  echo "PASS: podman socket exists at $PODMAN_SOCKET"
else
  echo "INFO: podman socket not found (podman may not be running as $DRAGNET_USER)"
fi

echo ""
echo "=== Summary ==="
echo "Review the WARN messages above. Fix if running containerized workloads."
echo "All PASS entries are requirements for rootless podman operation."
