#!/bin/bash
set -euo pipefail
exec > >(tee /var/log/nats-bootstrap.log | logger -t nats-bootstrap) 2>&1

NATS_VERSION="${nats_version}"
FLEET_NAME="${fleet_name}"

# ── Detect arch ──────────────────────────────────────────────────────────────
ARCH=$(uname -m)
case "$ARCH" in
  aarch64) NATS_ARCH="linux-arm64" ;;
  x86_64)  NATS_ARCH="linux-amd64" ;;
  *)        echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

# ── Ensure dependencies ─────────────────────────────────────────────────────
# No extra packages needed for tar.gz extraction on AL2023.

# ── Install NATS server ──────────────────────────────────────────────────────
echo "[nats-bootstrap] Installing NATS server v$${NATS_VERSION} ($${NATS_ARCH})..."
cd /tmp
NATS_ARCHIVE="nats-server-v$${NATS_VERSION}-$${NATS_ARCH}.tar.gz"
NATS_BASE_URL="https://github.com/nats-io/nats-server/releases/download/v$${NATS_VERSION}"
NATS_CHECKSUMS="SHA256SUMS"

curl -fsSL "$${NATS_BASE_URL}/$${NATS_ARCHIVE}" -o "$${NATS_ARCHIVE}"
curl -fsSL "$${NATS_BASE_URL}/$${NATS_CHECKSUMS}" -o "$${NATS_CHECKSUMS}"

# Verify SHA256 before installing.
if ! grep -qF "$${NATS_ARCHIVE}" "$${NATS_CHECKSUMS}"; then
  echo "[nats-bootstrap] ERROR: $${NATS_ARCHIVE} not found in $${NATS_CHECKSUMS} — unexpected release format?" >&2
  exit 1
fi
if ! grep -F "$${NATS_ARCHIVE}" "$${NATS_CHECKSUMS}" | sha256sum -c --status; then
  echo "[nats-bootstrap] ERROR: SHA256 mismatch for $${NATS_ARCHIVE} — download may be corrupt or tampered" >&2
  exit 1
fi
echo "[nats-bootstrap] SHA256 verified."

mkdir -p /tmp/nats-extract
tar -xzf "$${NATS_ARCHIVE}" -C /tmp/nats-extract
install -m 755 /tmp/nats-extract/nats-server-v$${NATS_VERSION}-$${NATS_ARCH}/nats-server /usr/local/bin/nats-server
rm -rf "$${NATS_ARCHIVE}" "$${NATS_CHECKSUMS}" /tmp/nats-extract

echo "[nats-bootstrap] NATS server installed: $(nats-server --version)"

# ── NATS configuration ───────────────────────────────────────────────────────
# Single-node server. Listens on all interfaces within the VPC.
# JetStream disabled for the POC (stateless pub/sub only).
mkdir -p /etc/nats
%{ if nats_tls_enabled ~}
mkdir -p /etc/nats/tls

cat > /etc/nats/tls/server.crt <<'NATSCERT'
${nats_tls_cert_pem}
NATSCERT

cat > /etc/nats/tls/server.key <<'NATSKEY'
${nats_tls_key_pem}
NATSKEY

chmod 600 /etc/nats/tls/server.key

%{ if nats_tls_ca_pem != "" ~}
cat > /etc/nats/tls/ca.crt <<'NATSCA'
${nats_tls_ca_pem}
NATSCA
%{ endif ~}
%{ endif ~}

cat > /etc/nats/nats-server.conf <<NATSCONF
# FleetMind NATS server — fleet: $${FLEET_NAME}
# Single-node defaults to VPC-internal use; token auth/TLS are optional via tfvars.

server_name = "$${FLEET_NAME}-nats"

# Listen on all interfaces within the VPC; port 4222 is the standard NATS port.
host = "0.0.0.0"
port = 4222

# Cluster monitoring port (internal; security group blocks external access).
http_port = 8222

%{ if nats_auth_token != "" ~}
authorization {
  token = "${nats_auth_token}"
}
%{ endif ~}

%{ if nats_tls_enabled ~}
tls {
  cert_file = "/etc/nats/tls/server.crt"
  key_file  = "/etc/nats/tls/server.key"
%{ if nats_tls_ca_pem != "" ~}
  ca_file   = "/etc/nats/tls/ca.crt"
  verify    = true
%{ endif ~}
}
%{ endif ~}

# Connection limits — generous for a fleet of bots.
max_connections = 1024
max_payload     = 1MB

# Ping keep-alive: disconnect idle clients after ~3 missed pings.
ping_interval = "20s"
ping_max      = 3
NATSCONF

# ── systemd service ──────────────────────────────────────────────────────────
cat > /etc/systemd/system/nats.service <<SYSD
[Unit]
Description=NATS Server (FleetMind $${FLEET_NAME})
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/nats-server -c /etc/nats/nats-server.conf
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nats

[Install]
WantedBy=multi-user.target
SYSD

systemctl daemon-reload
systemctl enable --now nats.service

echo "[nats-bootstrap] NATS server started."
systemctl status nats.service --no-pager
