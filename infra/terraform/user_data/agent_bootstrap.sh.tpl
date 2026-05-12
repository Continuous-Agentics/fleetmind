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
dnf install -y git tar unzip jq

# ── Ensure amazon-ssm-agent is installed + running ────────────────────────────
# Defensive: the standard AL2023 AMI includes ssm-agent, but the minimal AMI
# doesn't. Installing here is idempotent and makes the bootstrap resilient
# regardless of which AL2023 variant most_recent selects.
echo "[bootstrap] STAGE 2c: amazon-ssm-agent install/start at $(date)"
dnf install -y amazon-ssm-agent
systemctl enable --now amazon-ssm-agent
echo "[bootstrap] amazon-ssm-agent: $(systemctl is-active amazon-ssm-agent)"

# ── GitHub CLI (matches Carpe bootstrap pattern) ──────────────────────────────
echo "[bootstrap] STAGE 2b: gh CLI install starting at $(date)"
dnf install -y 'dnf-command(config-manager)' 2>/dev/null || true
dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
dnf install -y gh

# ── Node.js via NodeSource ────────────────────────────────────────────────────
# Simpler than nvm; system-wide install; matches the pattern used by
# Carpe's working bootstrap.
echo "[bootstrap] STAGE 3: NodeSource repo setup at $(date)"
curl -fsSL "https://rpm.nodesource.com/setup_$${NODE_VERSION}.x" | bash -
echo "[bootstrap] STAGE 4: nodejs install starting at $(date)"
dnf install -y nodejs

NODE_BIN="/usr/bin"
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

agent_upper = "$AGENT".upper()
combined = {**parse('''$ANTHROPIC'''), **parse('''$AGENT_SECRET''')}
for k, v in combined.items():
    # Basic sanitisation: skip values with newlines/quotes that would break env syntax
    v_str = str(v)
    if "\n" not in v_str and "'" not in v_str:
        # Canonical name (e.g. SLACK_BOT_TOKEN, ANTHROPIC_API_KEY)
        print(f"{k}={v_str}")
        # Per-agent alias for fleet.yaml refs like <AGENT>_BOT_TOKEN, <AGENT>_APP_TOKEN, etc.
        # Strip a leading SLACK_ so SLACK_BOT_TOKEN -> <AGENT>_BOT_TOKEN to match the convention
        # used in fleet.yaml. Non-SLACK keys are aliased verbatim (harmless extras).
        alias_key = k[6:] if k.startswith("SLACK_") else k
        print(f"{agent_upper}_{alias_key}={v_str}")
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

Environment=HOME=$WORKSPACE_DIR
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin

# Fetch fresh secrets before each start (idempotent)
# '+' prefix runs ExecStartPre as root so it can write to /run (root:root 755)
ExecStartPre=+/usr/local/bin/fetch-agent-secrets $FLEET_NAME $AGENT_ID $ENV_FILE $AWS_REGION

# '-' prefix means: don't fail if file missing at unit-load time (it's created by ExecStartPre)
EnvironmentFile=-$ENV_FILE

ExecStart=$OPENCLAW_BIN gateway

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
echo "[bootstrap] STAGE 12: systemd unit installed and enabled; service NOT started"
echo "[bootstrap]   To start: systemctl start openclaw-$AGENT_ID"
echo "[bootstrap]   (Run after deploying workspace via: fleetmind deploy)"

# ── STAGE 13: amazon-ssm-agent diagnostic ─────────────────────────────────────
# AL2023 console output doesn't surface systemd unit state by default. Dump
# ssm-agent's service status + recent journal to /dev/console so we can see
# what's happening without needing SSM access (chicken-and-egg).
echo "[bootstrap] STAGE 13: amazon-ssm-agent diagnostic at $(date)"
echo "--- systemctl is-active amazon-ssm-agent ---" > /dev/console
systemctl is-active amazon-ssm-agent > /dev/console 2>&1 || true
echo "--- systemctl status amazon-ssm-agent (no pager) ---" > /dev/console
systemctl status amazon-ssm-agent --no-pager > /dev/console 2>&1 || true
echo "--- journalctl -u amazon-ssm-agent -n 50 --no-pager ---" > /dev/console
journalctl -u amazon-ssm-agent -n 50 --no-pager > /dev/console 2>&1 || true
echo "--- end ssm-agent diagnostic ---" > /dev/console

echo "[bootstrap] Done. Agent $AGENT_ID provisioned (fleet: $FLEET_NAME) — gateway will start on next boot or manual start"
