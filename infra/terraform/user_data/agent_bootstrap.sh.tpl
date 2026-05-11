#!/bin/bash
set -euo pipefail

# =============================================================================
# FleetMind Agent Bootstrap — one EC2 per agent
#
# Provisions exactly one OpenClaw gateway service for the assigned agent.
# Fleet networking (VPC/subnets/SGs) and shared state (RDS/DDB) are
# provisioned separately in the root Terraform module.
#
# Variables (injected by Terraform templatefile):
#   fleet_name       – fleet namespace (used for SecretsManager paths)
#   agent_id         – unique agent identifier (matches fleet.yaml id)
#   agent_port       – OpenClaw gateway listening port
#   openclaw_version – npm version to install ("latest" or pinned)
#   node_version     – Node.js major version (e.g. "22")
#   aws_region       – AWS region for SecretsManager calls
# =============================================================================

FLEET_NAME="${fleet_name}"
AGENT_ID="${agent_id}"
AGENT_PORT="${agent_port}"
AWS_REGION="${aws_region}"
NODE_VERSION="${node_version}"
OPENCLAW_VERSION="${openclaw_version}"

WORKSPACE_BASE="/opt/openclaw/workspace"
WORKSPACE_DIR="$WORKSPACE_BASE/$AGENT_ID"
ENV_FILE="/run/openclaw-$AGENT_ID.env"

# ── Logging ───────────────────────────────────────────────────────────────────
# Mirror to /dev/console so failures appear in `aws ec2 get-console-output`
# even when SSM agent never registers (e.g. private-subnet with no SSM VPC endpoint).
exec > >(tee /var/log/fleetmind-bootstrap.log /dev/console | logger -t "fleetmind-bootstrap-$AGENT_ID") 2>&1
echo "[bootstrap] Starting FleetMind agent bootstrap"
echo "[bootstrap] Fleet: $FLEET_NAME | Agent: $AGENT_ID | Port: $AGENT_PORT"

# ── System updates ────────────────────────────────────────────────────────────
echo "[bootstrap] STAGE 1: dnf update starting at $(date)"
dnf update -y
echo "[bootstrap] STAGE 2: dnf install starting at $(date)"
dnf install -y git curl tar unzip

# ── Node.js via nvm ───────────────────────────────────────────────────────────
echo "[bootstrap] STAGE 3: nvm install starting at $(date)"
export NVM_DIR="/opt/nvm"
mkdir -p "$NVM_DIR"

curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | NVM_DIR="$NVM_DIR" bash

export NVM_DIR="$NVM_DIR"
source "$NVM_DIR/nvm.sh"

echo "[bootstrap] STAGE 4: node install starting at $(date)"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use default

NODE_BIN=$(dirname "$(which node)")

echo "export NVM_DIR=\"$NVM_DIR\"" >> /etc/profile.d/nvm.sh
echo "source \"\$NVM_DIR/nvm.sh\""  >> /etc/profile.d/nvm.sh

echo "[bootstrap] Node $(node --version) installed at $NODE_BIN"

# ── AWS CLI v2 ────────────────────────────────────────────────────────────────
echo "[bootstrap] STAGE 5: aws cli install/check starting at $(date)"
if ! aws --version 2>&1 | grep -q "aws-cli/2"; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install --update
  rm -rf /tmp/aws /tmp/awscliv2.zip
fi

# ── OpenClaw ──────────────────────────────────────────────────────────────────
OPENCLAW_PKG="openclaw"
%{ if openclaw_version != "" ~}
OPENCLAW_PKG="openclaw@${openclaw_version}"
%{ endif ~}

echo "[bootstrap] STAGE 6: openclaw install starting at $(date)"
echo "[bootstrap] Installing $OPENCLAW_PKG ..."
npm install -g "$OPENCLAW_PKG"
OPENCLAW_BIN=$(which openclaw)
echo "[bootstrap] openclaw installed at: $OPENCLAW_BIN"

# ── Workspace directory for this agent (on root volume) ─────────────────────────
# Workspace lives on the EC2 root volume. Persistent state belongs in the
# shared substrates (task-ledger DDB, context-store DDB, narratives S3).
echo "[bootstrap] STAGE 7: workspace mkdir starting at $(date)"
mkdir -p "$WORKSPACE_DIR"
chown -R ec2-user:ec2-user "$WORKSPACE_DIR"
echo "[bootstrap] Workspace dir: $WORKSPACE_DIR (root volume)"

# ── Secret fetch helper ───────────────────────────────────────────────────────
echo "[bootstrap] STAGE 8: fetch-secrets helper write starting at $(date)"
cat > /usr/local/bin/fetch-agent-secrets << 'FETCH_EOF'
#!/bin/bash
# Usage: fetch-agent-secrets <fleet_name> <agent_id> <output_env_file> <aws_region>
set -euo pipefail
FLEET="$1"
AGENT="$2"
OUT="$3"
REGION="$4"

install -m 600 /dev/null "$OUT"

fetch_secret() {
  aws secretsmanager get-secret-value \
    --secret-id "$1" --region "$REGION" \
    --query SecretString --output text 2>/dev/null || echo "{}"
}

ANTHROPIC=$(fetch_secret "$FLEET/agents/$AGENT/anthropic")
AGENT_SECRET=$(fetch_secret "$FLEET/agents/$AGENT/slack")

python3 - << PYEOF > "$OUT"
import json

def parse(s):
    try:
        return json.loads(s)
    except Exception:
        return {}

combined = {**parse('''$ANTHROPIC'''), **parse('''$AGENT_SECRET''')}
for k, v in combined.items():
    # Basic sanitisation: skip values with newlines/quotes that would break env syntax
    v_str = str(v)
    if "\n" not in v_str and "'" not in v_str:
        print(f"{k}={v_str}")
PYEOF

echo "[secrets] Loaded $(wc -l < "$OUT") vars for agent: $AGENT"
FETCH_EOF

chmod +x /usr/local/bin/fetch-agent-secrets

# ── systemd service for this agent ────────────────────────────────────────────
echo "[bootstrap] STAGE 9: systemd unit write starting at $(date)"
echo "[bootstrap] Creating systemd service for agent: $AGENT_ID (port $AGENT_PORT)"

cat > "/etc/systemd/system/openclaw-$AGENT_ID.service" << EOF
[Unit]
Description=OpenClaw Agent ($AGENT_ID) — $FLEET_NAME fleet
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

# Fetch fresh secrets before each start (idempotent)
ExecStartPre=/usr/local/bin/fetch-agent-secrets $FLEET_NAME $AGENT_ID $ENV_FILE $AWS_REGION

EnvironmentFile=$ENV_FILE

ExecStart=$OPENCLAW_BIN start \
  --workspace $WORKSPACE_DIR \
  --port $AGENT_PORT

StandardOutput=journal
StandardError=journal
SyslogIdentifier=openclaw-$AGENT_ID

[Install]
WantedBy=multi-user.target
EOF

echo "[bootstrap] STAGE 10: systemctl daemon-reload at $(date)"
systemctl daemon-reload
echo "[bootstrap] STAGE 11: systemctl enable at $(date)"
systemctl enable "openclaw-$AGENT_ID"
echo "[bootstrap] STAGE 12: systemctl start at $(date)"
systemctl start "openclaw-$AGENT_ID"

echo "[bootstrap] Done. Agent $AGENT_ID is live on port $AGENT_PORT (fleet: $FLEET_NAME)"
