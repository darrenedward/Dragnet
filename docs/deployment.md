# VPS Deployment Guide

Deploy Dragnet on a VPS as a hardened systemd service running as the `dragnet` user.

## Prerequisites

- A Linux VPS (Debian/Ubuntu recommended)
- Node.js 20+ and npm
- PostgreSQL 15+ (Supabase or self-managed)
- Git (for cloning repos)

## Installation

### 1. Clone and build

```bash
git clone https://github.com/your-org/dragnet.git /opt/dragnet
cd /opt/dragnet
npm install
npm run build
```

### 2. Run the install script

```bash
sudo ./deployment/install.sh
```

This creates the `dragnet` system user, sets up `/var/lib/dragnet` and `/run/dragnet` directories, copies the systemd unit, and enables + starts the service.

The script is idempotent — running it again is safe.

### 3. Initialize the master key

```bash
sudo -u dragnet npx tsx /opt/dragnet/src/tools/generateMasterKey.ts
```

This writes a 32-byte hex key to `/var/lib/dragnet/master.key` with mode 400, owner `dragnet:dragnet`.

> **Important:** Always prefix with `sudo -u dragnet` so the key file is owned by dragnet:dragnet. Running as root produces a root-owned key that the dragnet user cannot read.

### 4. Configure environment

The systemd unit sources no env file — hardcoded env vars are set directly in `dragnet.service`. For secrets, create `/etc/dragnet.env`:

```env
DATABASE_URL=postgresql://user:password@host:5432/dragnet
DRAGNET_REPO_KEY=your-project-api-key
```

Set permissions: `chmod 600 /etc/dragnet.env && chown dragnet:dragnet /etc/dragnet.env`.

Add an `EnvironmentFile=/etc/dragnet.env` line to `dragnet.service` under the `[Service]` section to load it at boot.

### 5. Start the service

```bash
sudo systemctl start dragnet
sudo systemctl status dragnet
sudo journalctl -u dragnet -f
```

## Master Key Rotation

Keys are rotated with the built-in tool:

```bash
# The tool reads the current key from the default path, decrypts all
# encrypted secrets, generates a new key, re-encrypts, and does an
# atomic swap of the key file.
sudo -u dragnet npx tsx /opt/dragnet/src/tools/rotateMasterKey.ts
```

> **Note:** The rotate tool currently handles in-memory re-encryption. Integration with the database (querying encrypted columns, writing back new cipher/iv/tag tuples) is planned — for now, run `npm run lint` and verify tests pass before/after rotation.

## Container Escape Mitigation

The systemd unit is hardened (`NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `CapabilityBoundingSet=` empty) so any container escape from a workload lands as the `dragnet` user — not root. Combined with `RestrictNamespaces=yes` and `PrivateDevices=yes`, kernel-level breakout primitives are blocked. Verify with:

```bash
systemd-analyze verify /etc/systemd/system/dragnet.service
```

## Podman Rootless Setup (Optional)

For running containerized workloads (e.g., build containers per repo):

```bash
sudo ./deployment/podman-rootless-setup.sh
```

The script checks for:
- Podman installation
- `subuid`/`subgid` mappings for the `dragnet` user
- Linger (enables user systemd services on boot)

Fix any WARN messages per the script's guidance.

## Reverse Proxy (Caddy)

```caddyfile
dragnet.example.com {
    reverse_proxy localhost:3300
}
```

## Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name dragnet.example.com;

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
