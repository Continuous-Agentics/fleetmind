#!/bin/bash
set -euo pipefail

FLEET_NAME="${fleet_name}"
AWS_REGION="${aws_region}"
NODE_VERSION="${node_version}"
OPENCLAW_VERSION="${openclaw_version}"
WORKSPACE_BASE="/opt/openclaw/workspace"

# Agent config (passed from Terraform templatefile)
# agent_names and agent_ports are rendered as bash arrays below
AGENT_NAMES=(${join(" ", agent_names)})
declare -A AGENT_PORTS
%{ for name, port in agent_ports ~}
AGENT_PORTS[${name}]=${port}
%{ endfor ~}

# ── Logging ───────────────────────────────────────────────────────────────────
exec > >(tee /var/log/fleetmind-bootstrap.log | logger -t fleetmind-bootstrap) 2>&1
echo "[bootstrap] Starting FleetMind bootstrap for fleet: $FLEET_NAME"

# ── System updates ────────────────────────────────────────────────────────────
dnf update -y
dnf install -y git curl tar unzip

# ── Node.js via nvm ───────────────────────────────────────────────────────────
export NVM_DIR="/opt/nvm"
mkdir -p "$NVM_DIR"

curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | NVM_DIR="$NVM_DIR" bash

export NVM_DIR="$NVM_DIR"
source "$NVM_DIR/nvm.sh"

nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use default

NODE_BIN=$(dirname $(which node))
echo "export NVM_DIR=\"$NVM_DIR\"" >> /etc/profile.d/nvm.sh
echo "source \"\$NVM_DIR/nvm.sh\"" >> /etc/profile.d/nvm.sh

# ── AWS CLI v2 ────────────────────────────────────────────────────────────────
if ! aws --version 2>&1 | grep -q "aws-cli/2"; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install --update
  rm -rf /tmp/aws /tmp/awscliv2.zip
fi

# ── OpenClaw ──────────────────────────────────────────────────────────────────
echo "[bootstrap] Installing openclaw@$OPENCLAW_VERSION"
npm install -g openclaw@$OPENCLAW_VERSION

OPENCLAW_BIN=$(which openclaw)
echo "[bootstrap] openclaw installed at: $OPENCLAW_BIN"

# ── EBS workspace volume (/dev/xvdf → /opt/openclaw/workspace) ────────────────
for i in $(seq 1 30); do
  [ -b /dev/xvdf ] && break
  echo "[bootstrap] Waiting for EBS volume... ($i/30)"
  sleep 2
done

[ -b /dev/xvdf ] || { echo "[bootstrap] ERROR: /dev/xvdf not found"; exit 1; }

if ! blkid /dev/xvdf > /dev/null 2>&1; then
  echo "[bootstrap] Formatting EBS volume (first use)"
  mkfs.ext4 -F /dev/xvdf
else
  echo "[bootstrap] EBS already formatted — skipping mkfs (data preserved)"
fi

mkdir -p "$WORKSPACE_BASE"

FSTAB_ENTRY="/dev/xvdf $WORKSPACE_BASE ext4 defaults,nofail 0 2"
grep -qF "$FSTAB_ENTRY" /etc/fstab || echo "$FSTAB_ENTRY" >> /etc/fstab

mount "$WORKSPACE_BASE" || mount -a
echo "[bootstrap] Workspace mounted at $WORKSPACE_BASE"

# ── Secret fetch helper ───────────────────────────────────────────────────────
cat > /usr/local/bin/fetch-agent-secrets << 'FETCH_EOF'
#!/bin/bash
# Usage: fetch-agent-secrets <agent_name> <output_env_file>
set -euo pipefail
AGENT="$1"
OUT="$2"
FLEET="FLEET_NAME_PLACEHOLDER"
REGION="AWS_REGION_PLACEHOLDER"

install -m 600 /dev/null "$OUT"

fetch_secret() {
  aws secretsmanager get-secret-value \
    --secret-id "$1" --region "$REGION" \
    --query SecretString --output text 2>/dev/null || echo "{}"
}

SHARED=$(fetch_secret "$FLEET/shared/anthropic")
AGENT_SECRET=$(fetch_secret "$FLEET/agents/$AGENT/slack")

python3 - << PYEOF > "$OUT"
import json
def parse(s):
    try: return json.loads(s)
    except: return {}
combined = {**parse('''$SHARED'''), **parse('''$AGENT_SECRET''')}
for k, v in combined.items():
    print(f"{k}={v}")
PYEOF

echo "[secrets] Loaded $(wc -l < $OUT) vars for agent: $AGENT"
FETCH_EOF

sed -i \
  -e "s|FLEET_NAME_PLACEHOLDER|$FLEET_NAME|g" \
  -e "s|AWS_REGION_PLACEHOLDER|$AWS_REGION|g" \
  /usr/local/bin/fetch-agent-secrets

chmod +x /usr/local/bin/fetch-agent-secrets

# ── Create workspace dirs + systemd service per agent ─────────────────────────
for AGENT in "$${AGENT_NAMES[@]}"; do
  PORT=$${AGENT_PORTS[$AGENT]}
  WORKSPACE="$WORKSPACE_BASE/$AGENT"
  ENV_FILE="/run/openclaw-$AGENT.env"

  mkdir -p "$WORKSPACE"
  chown -R ec2-user:ec2-user "$WORKSPACE"

  echo "[bootstrap] Creating systemd service for agent: $AGENT (port $PORT)"

  cat > "/etc/systemd/system/openclaw-$AGENT.service" << EOF
[Unit]
Description=OpenClaw Agent ($AGENT) — $FLEET_NAME fleet
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
Restart=always
RestartSec=10
StartLimitBurst=5
StartLimitIntervalSec=60

Environment=HOME=/home/ec2-user
Environment=NVM_DIR=$NVM_DIR
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin

# Fetch fresh secrets before each start
ExecStartPre=/usr/local/bin/fetch-agent-secrets $AGENT $ENV_FILE

EnvironmentFile=$ENV_FILE

ExecStart=$OPENCLAW_BIN start \
  --workspace $WORKSPACE \
  --port $PORT

StandardOutput=journal
StandardError=journal
SyslogIdentifier=openclaw-$AGENT

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "openclaw-$AGENT"
  systemctl start "openclaw-$AGENT"

  echo "[bootstrap] Started openclaw-$AGENT on port $PORT"
done

echo "[bootstrap] Done. Fleet $FLEET_NAME is live with agents: $${AGENT_NAMES[*]}"
