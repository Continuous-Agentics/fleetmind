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
FLEETMIND_VERSION="${fleetmind_version}"

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

# ── fleetmind CLI ─────────────────────────────────────────────────────────────
# Install @continuous-agentics/fleetmind from GitHub Packages (private, scoped).
# Auth: a read-only PAT with read:packages scope is stored in SSM as a shared
# SecureString. All agents in all fleets read the same param.
echo "[bootstrap] STAGE 6b: fleetmind install starting at $(date)"

GITHUB_PACKAGES_TOKEN=$(aws ssm get-parameter \
  --name "/fleetmind/shared/github-packages-token" \
  --with-decryption \
  --region "$AWS_REGION" \
  --query Parameter.Value \
  --output text)

# Write per-instance .npmrc for root (npm install -g runs as root)
cat > /root/.npmrc << NPMRC_EOF
//npm.pkg.github.com/:_authToken=$${GITHUB_PACKAGES_TOKEN}
@continuous-agentics:registry=https://npm.pkg.github.com
NPMRC_EOF
chmod 600 /root/.npmrc

echo "[bootstrap] Installing @continuous-agentics/fleetmind@$FLEETMIND_VERSION ..."
npm install -g "@continuous-agentics/fleetmind@$FLEETMIND_VERSION"

# Verify
FLEETMIND_BIN=$(which fleetmind)
echo "[bootstrap] fleetmind installed at: $FLEETMIND_BIN"
fleetmind --version

# Clean up .npmrc — token served its purpose; future installs re-auth from SSM
rm -f /root/.npmrc
echo "[bootstrap] /root/.npmrc removed (token cleaned up)"

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

# ── GitHub App token script ──────────────────────────────────────────────────
echo "[bootstrap] STAGE 8b: gh-app-token install starting at $(date)"

# Write agent identity file so gh-app-token can discover FLEET_NAME / AGENT_ID
mkdir -p /etc/fleetmind
cat > /etc/fleetmind/agent.env << AGENTENV_EOF
FLEET_NAME=$FLEET_NAME
AGENT_ID=$AGENT_ID
AGENTENV_EOF
chmod 644 /etc/fleetmind/agent.env

# Install the gh-app-token script
cat > /usr/local/bin/gh-app-token << 'GHTOKEN_EOF'
#!/bin/bash
# gh-app-token — Generate short-lived GitHub App installation tokens
#
# Usage:
#   gh-app-token              # Read+write token for this agent's project repo (default)
#   gh-app-token --app project  # Same as above (explicit)
#
# Environment variables (optional overrides):
#   GH_APP_ID            — GitHub App ID (skips SSM lookup)
#   GH_INSTALLATION_ID   — GitHub Installation ID (skips SSM lookup)
#   GH_APP_PEM           — PEM private key contents (skips SSM lookup)
#   GH_APP_PEM_FILE      — Path to PEM file (skips SSM lookup)
#   AWS_REGION            — AWS region for SSM (default: us-west-2)
#
# SSM Parameter paths:
#   /fleetmind/<fleet_name>/agents/<agent_id>/github-app/{app-id,installation-id,pem}
#
# Requires: openssl, curl, jq, aws cli

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
AWS_REGION="$${AWS_REGION:-us-west-2}"

die() { echo "$${SCRIPT_NAME}: error: $*" >&2; exit 1; }

base64url() {
  openssl enc -base64 -A | tr '+/' '-_' | tr -d '='
}

APP_TYPE="project"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ $# -lt 2 ]] && die "Missing value for --app (expected: project)"
      APP_TYPE="$2"
      shift 2
      ;;
    --help|-h)
      head -25 "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ "$APP_TYPE" != "project" ]] && die "Unknown app type: $APP_TYPE (only 'project' is supported)"

AGENT_ENV_FILE="/etc/fleetmind/agent.env"
if [[ -f "$AGENT_ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$AGENT_ENV_FILE"
fi

FLEET_NAME="$${FLEET_NAME:-}"
AGENT_ID="$${AGENT_ID:-}"

[[ -z "$FLEET_NAME" ]] && die "FLEET_NAME not set. Is /etc/fleetmind/agent.env present and populated?"
[[ -z "$AGENT_ID" ]]   && die "AGENT_ID not set. Is /etc/fleetmind/agent.env present and populated?"

SSM_PREFIX="/fleetmind/$${FLEET_NAME}/agents/$${AGENT_ID}/github-app"

fetch_ssm() {
  local name="$1"
  aws ssm get-parameter \
    --name "$name" \
    --region "$AWS_REGION" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text 2>/dev/null || die "Failed to fetch SSM parameter: $name"
}

if [[ -n "$${GH_APP_ID:-}" ]]; then
  APP_ID="$GH_APP_ID"
else
  APP_ID=$(fetch_ssm "$${SSM_PREFIX}/app-id")
fi

if [[ -n "$${GH_INSTALLATION_ID:-}" ]]; then
  INSTALLATION_ID="$GH_INSTALLATION_ID"
else
  INSTALLATION_ID=$(fetch_ssm "$${SSM_PREFIX}/installation-id")
fi

if [[ -n "$${GH_APP_PEM:-}" ]]; then
  PEM_KEY="$GH_APP_PEM"
elif [[ -n "$${GH_APP_PEM_FILE:-}" ]]; then
  [[ ! -f "$GH_APP_PEM_FILE" ]] && die "PEM file not found: $GH_APP_PEM_FILE"
  PEM_KEY=$(cat "$GH_APP_PEM_FILE")
else
  PEM_KEY=$(fetch_ssm "$${SSM_PREFIX}/pem")
fi

[[ -z "$APP_ID" ]]          && die "App ID is empty"
[[ -z "$INSTALLATION_ID" ]] && die "Installation ID is empty"
[[ -z "$PEM_KEY" ]]         && die "PEM key is empty"

NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 600))

HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | base64url)
PAYLOAD=$(echo -n "{\"iss\":$${APP_ID},\"iat\":$${IAT},\"exp\":$${EXP}}" | base64url)

PEM_TMP=$(mktemp)
trap 'rm -f "$PEM_TMP"' EXIT
echo "$PEM_KEY" > "$PEM_TMP"

SIGNATURE=$(echo -n "$${HEADER}.$${PAYLOAD}" | \
  openssl dgst -sha256 -sign "$PEM_TMP" | base64url)

JWT="$${HEADER}.$${PAYLOAD}.$${SIGNATURE}"

RESPONSE=$(curl -sS -w "\n%%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $${JWT}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/app/installations/$${INSTALLATION_ID}/access_tokens") \
  || die "Failed to connect to GitHub API (network/DNS/TLS error)"

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" != "201" ]]; then
  die "GitHub API returned HTTP $${HTTP_CODE}: $${BODY}"
fi

TOKEN=$(echo "$BODY" | jq -r '.token')
EXPIRES=$(echo "$BODY" | jq -r '.expires_at')

[[ "$TOKEN" == "null" || -z "$TOKEN" ]] && die "Failed to extract token from response: $${BODY}"

echo "$TOKEN"
echo "Token expires: $${EXPIRES}" >&2
GHTOKEN_EOF

chmod 755 /usr/local/bin/gh-app-token
echo "[bootstrap] gh-app-token installed at /usr/local/bin/gh-app-token"

# ── systemd service for this agent ────────────────────────────────────────────
echo "[bootstrap] STAGE 9: systemd unit write starting at $(date)"
echo "[bootstrap] Creating systemd service for agent: $AGENT_ID (port $AGENT_PORT)"

cat > "/etc/systemd/system/openclaw-$AGENT_ID.service" << EOF
[Unit]
Description=OpenClaw Agent ($AGENT_ID) — $FLEET_NAME fleet
After=network-online.target
Wants=network-online.target
# Workspace config is deployed by 'fleetmind push fleet' (after bootstrap completes).
# systemd silently skips start until that file exists, avoiding a restart-loop on
# first boot before the operator's first push. Once pull-self ships the workspace,
# 'systemctl restart' (which pull-self --restart triggers) starts the service fresh.
ConditionPathExists=$WORKSPACE_DIR/.openclaw/openclaw.json

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
echo "[bootstrap] STAGE 11: systemctl enable --now at $(date)"
systemctl enable --now "openclaw-$AGENT_ID" || true
echo "[bootstrap] STAGE 12: systemd unit installed and enabled"
echo "[bootstrap]   ConditionPathExists gates start until 'fleetmind push fleet' ships the workspace."
echo "[bootstrap]   On first push, 'fleetmind push fleet --restart' triggers the initial start."

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
