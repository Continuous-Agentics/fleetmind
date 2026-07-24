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
#   openclaw_version – npm version to install ("latest" or pinned)
#   node_version     – Node.js major version (e.g. "22")
#   aws_region       – AWS region for SecretsManager calls
# =============================================================================

FLEET_NAME="${fleet_name}"
AGENT_ID="${agent_id}"
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
echo "[bootstrap] Fleet: $FLEET_NAME | Agent: $AGENT_ID"

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
  AWSCLI_ARCH=$(uname -m | sed 's/aarch64/aarch64/;s/x86_64/x86_64/')
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$${AWSCLI_ARCH}.zip" -o /tmp/awscliv2.zip
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
# Install @continuous-agentics/fleetmind from public npm.
echo "[bootstrap] STAGE 6b: fleetmind install starting at $(date)"

echo "[bootstrap] Installing @continuous-agentics/fleetmind@$FLEETMIND_VERSION ..."
npm install -g "@continuous-agentics/fleetmind@$FLEETMIND_VERSION"

# Verify
FLEETMIND_BIN=$(which fleetmind)
echo "[bootstrap] fleetmind installed at: $FLEETMIND_BIN"
fleetmind --version

# ── Workspace directory for this agent (on root volume) ─────────────────────────
# Workspace lives on the EC2 root volume. Persistent state belongs in the
# shared substrates (task-ledger DDB, context-store DDB, narratives S3).
echo "[bootstrap] STAGE 7: workspace mkdir starting at $(date)"
mkdir -p "$WORKSPACE_DIR"
chown -R ec2-user:ec2-user "$WORKSPACE_DIR"
echo "[bootstrap] Workspace dir: $WORKSPACE_DIR (root volume)"

echo "[bootstrap] STAGE 7a: @openclaw/slack plugin install starting at $(date)"
# Must run after workspace dir exists and is owned by ec2-user.
# Uses HOME=$WORKSPACE_DIR so plugin lands where the service can find it.
sudo -u ec2-user HOME="$WORKSPACE_DIR" openclaw plugins install @openclaw/slack --force
# Remove the stub openclaw.json created by plugins install — it only contains
# the plugin entry and lacks gateway.mode, causing OpenClaw to refuse startup.
# The real openclaw.json is delivered by 'fleetmind push fleet'.
rm -f "$WORKSPACE_DIR/.openclaw/openclaw.json"
echo "[bootstrap] @openclaw/slack installed"

# ── Gateway auth token ───────────────────────────────────────────────────────
# The gateway auth token is owned by `fleetmind secrets populate` (it writes a
# per-agent GATEWAY_TOKEN into <fleet>/agents/<agent>/gateway). This stage is
# only a fallback for fleets deployed without a populate run: generate + store a
# token ONLY when the current value is absent or still the "PENDING_BOOTSTRAP"
# placeholder. Guarding this prevents clobbering a populate-seeded token on every
# reboot (the bug that left CLI-seeded agents with a token that kept rotating).
echo "[bootstrap] STAGE 7b: gateway token generation at $(date)"
GATEWAY_CURRENT=$(aws secretsmanager get-secret-value \
  --secret-id "$FLEET_NAME/agents/$AGENT_ID/gateway" \
  --query SecretString --output text \
  --region "$AWS_REGION" 2>/dev/null || true)
if [ -z "$GATEWAY_CURRENT" ] || echo "$GATEWAY_CURRENT" | grep -q "PENDING_BOOTSTRAP"; then
  GATEWAY_TOKEN=$(openssl rand -hex 32)
  aws secretsmanager put-secret-value \
    --secret-id "$FLEET_NAME/agents/$AGENT_ID/gateway" \
    --secret-string "{\"GATEWAY_TOKEN\":\"$GATEWAY_TOKEN\"}" \
    --region "$AWS_REGION" 2>&1 || \
  aws secretsmanager create-secret \
    --name "$FLEET_NAME/agents/$AGENT_ID/gateway" \
    --secret-string "{\"GATEWAY_TOKEN\":\"$GATEWAY_TOKEN\"}" \
    --region "$AWS_REGION" 2>&1
  echo "[bootstrap] Gateway token generated and stored in Secrets Manager"
else
  echo "[bootstrap] Gateway token already populated (not placeholder); leaving it unchanged"
fi

# ── STAGE 7c — webhooks plugin hooks token ────────────────────────────────────
# The webhooks plugin (used by the NATS subscriber wake path) authenticates
# inbound POSTs against OPENCLAW_HOOKS_TOKEN. terraform-aws-fleetmind seeds the
# Secrets Manager value with the literal placeholder "PENDING_BOOTSTRAP"
# (modules/agent/main.tf hooks_placeholder, with ignore_changes); the comment
# there promises that "STAGE 7c" generates the real token at bootstrap time.
# Prior to v0.4.3 STAGE 7c didn't exist, so every fleet shipped with the
# placeholder as its hooks token — same string everywhere, predictable, no
# isolation between fleets. This generates the fleet-specific value once at
# first boot.
echo "[bootstrap] STAGE 7c: webhooks hooks token generation at $(date)"
HOOKS_TOKEN=$(openssl rand -hex 32)
aws secretsmanager put-secret-value \
  --secret-id "$FLEET_NAME/agents/$AGENT_ID/hooks" \
  --secret-string "{\"HOOKS_TOKEN\":\"$HOOKS_TOKEN\"}" \
  --region "$AWS_REGION" 2>&1 || \
aws secretsmanager create-secret \
  --name "$FLEET_NAME/agents/$AGENT_ID/hooks" \
  --secret-string "{\"HOOKS_TOKEN\":\"$HOOKS_TOKEN\"}" \
  --region "$AWS_REGION" 2>&1
echo "[bootstrap] Webhooks hooks token stored in Secrets Manager"

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

# AGENT_PROVIDERS is injected at templatefile() render time as a
# space-separated list (e.g. "anthropic openai"). Per-provider API keys live
# at $FLEET/agents/$AGENT/providers/<provider> as one JSON object each:
# { "<PROVIDER>_API_KEY": "<value>" }.
AGENT_PROVIDERS="${agent_providers}"

AGENT_SECRET=$(fetch_secret "$FLEET/agents/$AGENT/slack")
GATEWAY_SECRET=$(fetch_secret "$FLEET/agents/$AGENT/gateway")
HOOKS_SECRET=$(fetch_secret "$FLEET/agents/$AGENT/hooks")

PROVIDER_BLOBS=""
for prov in $AGENT_PROVIDERS; do
  blob=$(fetch_secret "$FLEET/agents/$AGENT/providers/$prov")
  # Newline-separate blobs so the python merge can split cleanly.
  PROVIDER_BLOBS="$PROVIDER_BLOBS
$blob"
done

python3 - << PYEOF > "$OUT"
import json

def parse(s):
    try:
        return json.loads(s)
    except Exception:
        return {}

agent_upper = "$AGENT".upper()
provider_blobs = '''$PROVIDER_BLOBS'''
model_merged = {}
for chunk in provider_blobs.splitlines():
    chunk = chunk.strip()
    if not chunk:
        continue
    model_merged.update(parse(chunk))
combined = {**model_merged, **parse('''$AGENT_SECRET'''), **parse('''$GATEWAY_SECRET''')}

# Emit hooks token separately with the canonical OPENCLAW_HOOKS_TOKEN name.
# Must not be merged into 'combined' to avoid accidentally overwriting the
# alias loop below with a bare HOOKS_TOKEN entry that other tools won't find.
hooks = parse('''$HOOKS_SECRET''')
hooks_token = str(hooks.get('HOOKS_TOKEN', ''))
if hooks_token and '\n' not in hooks_token and "'" not in hooks_token:
    print(f'OPENCLAW_HOOKS_TOKEN={hooks_token}')
    print(f'{agent_upper}_HOOKS_TOKEN={hooks_token}')
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

# Write agent identity file so gh-app-token + fleetmind pull-self can discover
# FLEET_NAME / AGENT_ID / WORKSPACE_BASE. WORKSPACE_BASE is read by pull-self
# to locate the agent workspace; without it pull-self falls back to
# /opt/openclaw/workspace (which matches, but the explicit value is safer and
# allows future per-agent overrides without a bootstrap change).
mkdir -p /etc/fleetmind
cat > /etc/fleetmind/agent.env << AGENTENV_EOF
FLEET_NAME=$FLEET_NAME
AGENT_ID=$AGENT_ID
WORKSPACE_BASE=$WORKSPACE_BASE
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
echo "[bootstrap] Creating systemd service for agent: $AGENT_ID"

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

# ── STAGE 12b: gh CLI install (non-critical, after core bootstrap) ───────────
# Moved after Node.js/openclaw/fleetmind so a network timeout here never
# aborts the bootstrap. The gh CLI is useful for gh-app-token but the bot
# can start without it.
echo "[bootstrap] STAGE 12b: gh CLI install starting at $(date)"
if dnf install -y 'dnf-command(config-manager)' 2>/dev/null && \
   dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && \
   dnf install -y gh; then
  echo "[bootstrap] gh CLI installed successfully"
else
  echo "[bootstrap] WARNING: gh CLI install failed — bot will start without it" | tee /dev/console
  echo "[bootstrap] To install manually: sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && sudo dnf install -y gh"
fi

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

# ── STAGE 14: NATS subscriber units ─────────────────────────────────────────────
# Write a systemd .path unit that watches for fleet.yaml and auto-starts the
# NATS subscriber service the moment fleet.yaml is deployed by fleetmind push.
# No manual intervention needed after deploy.
echo "[bootstrap] STAGE 14: NATS subscriber units starting at $(date)"

NATS_FLEET_YAML="$WORKSPACE_DIR/fleet.yaml"
NATS_MODE="%{ if is_orchestrator }pm%{ else }worker%{ endif }"
NATS_SVC_NAME="fleetmind-nats-$AGENT_ID"

# Path unit: fires once when fleet.yaml appears
cat > "/etc/systemd/system/$${NATS_SVC_NAME}.path" << EOF
[Unit]
Description=Watch for fleet.yaml — start NATS subscriber for $AGENT_ID once config is deployed
StartLimitIntervalSec=0

[Path]
PathExists=$NATS_FLEET_YAML
Unit=$${NATS_SVC_NAME}.service

[Install]
WantedBy=multi-user.target
EOF

# Service unit: long-running fleetmind nats subscribe
cat > "/etc/systemd/system/$${NATS_SVC_NAME}.service" << EOF
[Unit]
Description=FleetMind NATS subscriber ($AGENT_ID, mode=$NATS_MODE) — $FLEET_NAME fleet
After=openclaw-$AGENT_ID.service network-online.target
Wants=network-online.target
StartLimitBurst=0
StartLimitIntervalSec=0

[Service]
Type=simple
User=ec2-user
WorkingDirectory=$WORKSPACE_DIR
Restart=on-failure
RestartSec=30
LogLevelMax=debug

Environment=HOME=$WORKSPACE_DIR
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
Environment=FLEET_YAML=$NATS_FLEET_YAML
Environment=OPENCLAW_GATEWAY_PORT=${gateway_port}
Environment=NATS_HEALTH_URL=http://nats.$FLEET_NAME.internal:8222/healthz
# Loads Slack + model-provider keys + gateway token so env var refs resolve.
# GATEWAY_TOKEN from this file is used by the PM subscriber as the webhook secret.
EnvironmentFile=-$ENV_FILE

# Wait for NATS to come online before starting the subscriber. The \$ escapes
# keep bash from expanding these in the heredoc — NATS_HEALTH_URL comes from
# the Environment= directive above and is only set when systemd runs the
# ExecStartPre subshell; \$i is the subshell's loop variable. Without the
# escapes, bash's `set -u` aborts the heredoc against unbound NATS_HEALTH_URL
# *after* the > redirect has truncated this file to 0 bytes, killing STAGE 14
# (the .service file ends up empty and the path unit never gets enabled).
ExecStartPre=/usr/bin/bash -lc 'for i in {1..40}; do if curl -fsS "\$NATS_HEALTH_URL" >/dev/null; then exit 0; fi; echo "[nats-subscriber] waiting for \$NATS_HEALTH_URL (\$i/40)"; sleep 3; done; echo "[nats-subscriber] NATS health check failed after retries"; exit 1'

%{ if is_orchestrator ~}
ExecStart=$FLEETMIND_BIN nats subscribe --mode pm --json
%{ else ~}
ExecStart=$FLEETMIND_BIN nats subscribe --mode worker --worker-id $AGENT_ID --json
%{ endif ~}

StandardOutput=journal
StandardError=journal
SyslogIdentifier=$${NATS_SVC_NAME}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
# Enable the path unit — it activates the service unit automatically
# when fleet.yaml lands on the instance.
systemctl enable "$${NATS_SVC_NAME}.path"
# Start the path unit immediately so it begins watching for fleet.yaml on this boot.
# Without this, the path unit won't be active and won't trigger the service when
# fleet.yaml is deployed by 'fleetmind push fleet'.
systemctl start "$${NATS_SVC_NAME}.path"
echo "[bootstrap] NATS path unit enabled and started: $${NATS_SVC_NAME}.path"
echo "[bootstrap]   Will start $${NATS_SVC_NAME}.service when $NATS_FLEET_YAML appears"

echo "[bootstrap] Done. Agent $AGENT_ID provisioned (fleet: $FLEET_NAME) — gateway will start on next boot or manual start"
