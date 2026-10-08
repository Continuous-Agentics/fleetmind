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
#   openclaw_version      – npm version to install (exact in self-managed mode)
#   openclaw_runtime_mode – "root-managed" (default) or "self-managed"
#   node_version          – Node.js major version (currently "24")
#   aws_region       – AWS region for SecretsManager calls
# =============================================================================

FLEET_NAME="${fleet_name}"
AGENT_ID="${agent_id}"
AWS_REGION="${aws_region}"
NODE_VERSION="${node_version}"
OPENCLAW_VERSION="${openclaw_version}"
OPENCLAW_RUNTIME_MODE="${openclaw_runtime_mode}"
FLEETMIND_VERSION="${fleetmind_version}"
GITHUB_APPS_JSON='${github_apps_json}'

OPENCLAW_USER="openclaw"
# OS account home. Standard OpenClaw one-agent-per-host contract: this IS the
# OpenClaw HOME — config/state at $OPENCLAW_HOME/.openclaw/openclaw.json,
# workspace at $OPENCLAW_HOME/.openclaw/workspace. No per-agent subdirectory:
# exactly one agent runs per host, so $AGENT_ID identifies the systemd
# service, Secrets Manager paths, and deploy artifacts only — never a
# workspace path segment. Matches the same contract 'fleetmind up's local/ssh
# targets already use; AWS is no longer a special case.
OPENCLAW_HOME="/home/openclaw"
WORKSPACE_DIR="$OPENCLAW_HOME/.openclaw/workspace"
# The opt-in runtime prefix is deliberately dedicated to OpenClaw. It does not
# make /usr/lib/node_modules, /usr/local, or a general user npm prefix writable.
OPENCLAW_RUNTIME_PREFIX="$OPENCLAW_HOME/.local/share/fleetmind/openclaw-runtime"
if [ "$OPENCLAW_RUNTIME_MODE" = "self-managed" ]; then
  RUNTIME_PATH="$OPENCLAW_RUNTIME_PREFIX/bin:/usr/local/bin:/usr/bin:/bin"
else
  RUNTIME_PATH="/usr/local/bin:/usr/bin:/bin"
fi
ENV_FILE="$OPENCLAW_HOME/.config/fleetmind/agent.env"

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
dnf install -y git tar unzip jq docker

# Docker is part of the practical OpenClaw agent baseline: agents can use
# Docker-backed tools without requiring a privileged service or a sudo grant.
echo "[bootstrap] STAGE 2a: Docker install/start at $(date)"
systemctl enable --now docker
getent group docker >/dev/null || groupadd --system docker

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
echo "[bootstrap] npm $(npm --version) available on $RUNTIME_PATH"

# ── OpenClaw runtime account ─────────────────────────────────────────────────
# Root owns machine bootstrap. Gateway and subscriber are user units under this
# account; opt-in self-managed mode also gives it one dedicated OpenClaw prefix,
# never a shared npm prefix. Lingering keeps its user manager persistent.
echo "[bootstrap] STAGE 4b: OpenClaw runtime account at $(date)"
if ! id -u "$OPENCLAW_USER" >/dev/null 2>&1; then
  useradd --create-home --home-dir "$OPENCLAW_HOME" --shell /bin/bash --groups docker "$OPENCLAW_USER"
else
  [ "$(getent passwd "$OPENCLAW_USER" | cut -d: -f6)" = "$OPENCLAW_HOME" ] || { echo "[bootstrap] Unexpected account home; reconcile explicitly" >&2; exit 1; }
  usermod --shell /bin/bash --append --groups docker "$OPENCLAW_USER"
fi
# All bootstrap-owned writes in the account tree execute unprivileged. The
# helper walks from / using pinned directory descriptors and O_NOFOLLOW; it
# never follows account-provided symlinks, hard links, or shared-writable paths.
cat > /usr/local/bin/fleetmind-home-write << 'HOME_WRITE_EOF'
#!/usr/bin/python3
import os, stat, sys, secrets

def checked(info, owner, directory=False):
    if info.st_uid != owner or info.st_mode & 0o022:
        raise RuntimeError("Unsafe home path ownership/permissions")
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError("Expected directory")
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError("Expected unlinked regular file")

def main():
    if os.geteuid() == 0:
        raise RuntimeError("Home writes must run unprivileged")
    home, action, target = sys.argv[1:4]
    if not target.startswith(home + "/") or any(p in (".", "..", "") for p in target.split("/")[1:]):
        raise RuntimeError("Path outside runtime home")
    parts = target.split("/")[1:]
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        checked(os.fstat(fd), 0, True)
        current = ""
        for part in parts if action == "mkdir" else parts[:-1]:
            current += "/" + part
            owner = os.getuid() if current == home or current.startswith(home + "/") else 0
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not current.startswith(home + "/"):
                    raise
                os.mkdir(part, 0o700, dir_fd=fd)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            checked(os.fstat(child), owner, True)
            os.close(fd)
            fd = child
        if action == "mkdir":
            os.fchmod(fd, 0o700)
            return
        name = parts[-1]
        old = b""
        try:
            source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        except FileNotFoundError:
            source = None
        if source is not None:
            with os.fdopen(source, "rb") as stream:
                checked(os.fstat(stream.fileno()), os.getuid())
                if action == "append":
                    old = stream.read()
        if action == "remove":
            if source is not None:
                os.unlink(name, dir_fd=fd)
        elif action in ("write", "append"):
            content = sys.stdin.buffer.read()
            if action == "append":
                # Append is used for one active profile source directive. Match
                # the complete line (never a comment/sub-string), preserve all
                # unrelated bytes, remove duplicate active lines, and append
                # only when no exact active line exists.
                desired = content.rstrip(b"\r\n")
                if not desired or b"\n" in desired or b"\r" in desired:
                    raise RuntimeError("Append requires exactly one non-empty line")
                found = False
                output = []
                for line in old.splitlines(keepends=True):
                    if line.rstrip(b"\r\n") == desired:
                        if found:
                            continue
                        found = True
                    output.append(line)
                if found:
                    content = b"".join(output)
                else:
                    separator = b"" if not old or old.endswith((b"\n", b"\r")) else b"\n"
                    content = old + separator + desired + b"\n"
            temp = ".fleetmind-" + secrets.token_hex(16)
            out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            try:
                with os.fdopen(out, "wb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                # Recheck the destination immediately before atomic replacement.
                try:
                    checked(os.stat(name, dir_fd=fd, follow_symlinks=False), os.getuid())
                except FileNotFoundError:
                    pass
                os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
            finally:
                try:
                    os.unlink(temp, dir_fd=fd)
                except FileNotFoundError:
                    pass
        else:
            raise RuntimeError("Unknown operation")
        os.fsync(fd)
    finally:
        os.close(fd)

if __name__ == "__main__":
    main()
HOME_WRITE_EOF
chmod 0755 /usr/local/bin/fleetmind-home-write
home_write() {
  runuser -u "$OPENCLAW_USER" -- /usr/bin/python3 -I /usr/local/bin/fleetmind-home-write "$OPENCLAW_HOME" "$@"
}
# Holds the fetched secret environment file and user-owned operational profile.
# Keep the directory private even when it already exists from a prior bootstrap.
home_write mkdir "$OPENCLAW_HOME/.config/fleetmind"
# Workspace lives under the OS account home (standard OpenClaw layout), as a
# plain sibling of $OPENCLAW_HOME/.openclaw/openclaw.json — not nested inside
# it, and with no per-agent subdirectory (one agent per host).
home_write mkdir "$WORKSPACE_DIR"
loginctl enable-linger "$OPENCLAW_USER"

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
echo "[bootstrap] Runtime ownership: $OPENCLAW_RUNTIME_MODE"
echo "[bootstrap] Installing $OPENCLAW_PKG ..."
if [ "$OPENCLAW_RUNTIME_MODE" = "self-managed" ]; then
  if ! [[ "$OPENCLAW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    echo "[bootstrap] ERROR: self-managed mode requires an exact openclaw_version, never latest, a dist-tag, or a range" >&2
    exit 1
  fi
  [ ! -e "$OPENCLAW_RUNTIME_PREFIX" ] || { echo "[bootstrap] Refusing to overwrite an existing dedicated runtime; use the native updater" >&2; exit 1; }
  home_write mkdir "$OPENCLAW_RUNTIME_PREFIX"
  runuser -u "$OPENCLAW_USER" -- env \
    HOME="$OPENCLAW_HOME" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    NPM_CONFIG_PREFIX="$OPENCLAW_RUNTIME_PREFIX" \
    npm install -g "$OPENCLAW_PKG"
  OPENCLAW_BIN="$OPENCLAW_RUNTIME_PREFIX/bin/openclaw"
  actual=$(runuser -u "$OPENCLAW_USER" -- env HOME="$OPENCLAW_HOME" "$OPENCLAW_BIN" --version | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?')
  [ "$actual" = "$OPENCLAW_VERSION" ] || { echo "[bootstrap] Exact seed verification failed" >&2; exit 1; }
else
  npm install -g "$OPENCLAW_PKG"
  OPENCLAW_BIN=$(which openclaw)
fi
[ -x "$OPENCLAW_BIN" ] || { echo "[bootstrap] ERROR: OpenClaw launcher missing at $OPENCLAW_BIN" >&2; exit 1; }
echo "[bootstrap] openclaw installed at: $OPENCLAW_BIN"
printf '{"binary":"%s","mode":"%s"}\n' "$OPENCLAW_BIN" "$OPENCLAW_RUNTIME_MODE" | home_write write "$OPENCLAW_HOME/.config/fleetmind/openclaw-runtime.json"
{
  printf 'export FLEETMIND_OPENCLAW_BIN=%s\nexport PATH=%s\nexport OPENCLAW_SYSTEMD_UNIT=%s\n' "$OPENCLAW_BIN" "$RUNTIME_PATH" "openclaw-$AGENT_ID.service"
  if [ "$OPENCLAW_RUNTIME_MODE" = self-managed ]; then printf 'export NPM_CONFIG_PREFIX=%s\n' "$OPENCLAW_RUNTIME_PREFIX"; fi
} | home_write write "$OPENCLAW_HOME/.config/fleetmind/openclaw-runtime.sh"

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
# Re-attest the state directories after package installation, without root
# traversing or recursively taking ownership of the runtime tree.
home_write mkdir "$WORKSPACE_DIR"
home_write mkdir "$OPENCLAW_HOME/.openclaw"

echo "[bootstrap] STAGE 7a: @openclaw/slack plugin install starting at $(date)"
# Must run after the runtime account and workspace exist. Standard OpenClaw
# layout: gateway application state (openclaw.json) lives directly at
# $OPENCLAW_HOME/.openclaw/ — a sibling of $WORKSPACE_DIR, not nested inside
# it — so the gateway process's real HOME is $OPENCLAW_HOME itself (see the
# systemd units below), same as the OS account's own HOME. The explicit
# HOME= here is just defensive/explicit under runuser, not an override.
runuser -u "$OPENCLAW_USER" -- env HOME="$OPENCLAW_HOME" PATH="$RUNTIME_PATH" FLEETMIND_OPENCLAW_BIN="$OPENCLAW_BIN" "$OPENCLAW_BIN" plugins install @openclaw/slack --force
# Remove the stub openclaw.json created by plugins install — it only contains
# the plugin entry and lacks gateway.mode, causing OpenClaw to refuse startup.
# The real openclaw.json is delivered by 'fleetmind push fleet'.
home_write remove "$OPENCLAW_HOME/.openclaw/openclaw.json"
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
# inbound POSTs against OPENCLAW_HOOKS_TOKEN. FleetMind embedded Terraform module seeds the
# Secrets Manager value with the literal placeholder "PENDING_BOOTSTRAP"
# (modules/agent/main.tf hooks_placeholder, with ignore_changes); the comment
# there promises that "STAGE 7c" generates the real token at bootstrap time.
# Prior to v0.4.3 STAGE 7c didn't exist, so every fleet shipped with the
# placeholder as its hooks token — same string everywhere, predictable, no
# isolation between fleets. This generates the fleet-specific value once at
# first boot.
echo "[bootstrap] STAGE 7c: webhooks hooks token generation at $(date)"
HOOKS_CURRENT=$(aws secretsmanager get-secret-value \
  --secret-id "$FLEET_NAME/agents/$AGENT_ID/hooks" \
  --query SecretString --output text \
  --region "$AWS_REGION" 2>/dev/null || true)
if [ -z "$HOOKS_CURRENT" ] || echo "$HOOKS_CURRENT" | grep -q "PENDING_BOOTSTRAP"; then
  HOOKS_TOKEN=$(openssl rand -hex 32)
  aws secretsmanager put-secret-value \
    --secret-id "$FLEET_NAME/agents/$AGENT_ID/hooks" \
    --secret-string "{\"HOOKS_TOKEN\":\"$HOOKS_TOKEN\"}" \
    --region "$AWS_REGION" 2>&1 || \
  aws secretsmanager create-secret \
    --name "$FLEET_NAME/agents/$AGENT_ID/hooks" \
    --secret-string "{\"HOOKS_TOKEN\":\"$HOOKS_TOKEN\"}" \
    --region "$AWS_REGION" 2>&1
  echo "[bootstrap] Webhooks hooks token generated and stored in Secrets Manager"
else
  echo "[bootstrap] Webhooks hooks token already populated (not placeholder); leaving it unchanged"
fi

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

[ "$(id -u)" != 0 ] || { echo "Secret refresh must run as the runtime user" >&2; exit 1; }

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

python3 - << PYEOF | /usr/bin/python3 -I /usr/local/bin/fleetmind-home-write "$HOME" write "$OUT"
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

echo "[secrets] Refreshed environment for agent: $AGENT"
FETCH_EOF

chmod +x /usr/local/bin/fetch-agent-secrets

# ── GitHub App token script ──────────────────────────────────────────────────
echo "[bootstrap] STAGE 8b: gh-app-token install starting at $(date)"

# Write agent identity file so gh-app-token + fleetmind pull-self can discover
# FLEET_NAME / AGENT_ID / WORKSPACE_BASE. WORKSPACE_BASE is read by pull-self
# to locate the agent workspace; fleetmind CLI treats a missing/blank value as
# a hard error (no silent fallback), so this line must always be present and
# accurate for the host's actual on-disk workspace root.
# One agent per host: WORKSPACE_BASE here is the final workspace directory
# itself ($OPENCLAW_HOME/.openclaw/workspace), not a multi-agent parent to be
# joined with AGENT_ID. AGENT_ID is still written alongside it for identity
# (service name, Secrets Manager paths, deploy artifacts) — never as a
# workspace path segment.
mkdir -p /etc/fleetmind
cat > /etc/fleetmind/agent.env << AGENTENV_EOF
FLEET_NAME=$FLEET_NAME
AGENT_ID=$AGENT_ID
WORKSPACE_BASE=$WORKSPACE_DIR
OPENCLAW_RUNTIME_MODE=$OPENCLAW_RUNTIME_MODE
FLEETMIND_OPENCLAW_BIN=$OPENCLAW_BIN
AGENTENV_EOF
chown root:root /etc/fleetmind/agent.env
chmod 0644 /etc/fleetmind/agent.env

# Install the non-secret declaration allowlist and token helper.
install -d -m 0755 /etc/fleetmind
printf '%s\n' "$GITHUB_APPS_JSON" > /etc/fleetmind/github-apps.json
chmod 0644 /etc/fleetmind/github-apps.json
cat > /usr/local/bin/gh-app-token << 'GHTOKEN_EOF'
#!/bin/bash
# gh-app-token — Generate short-lived GitHub App installation tokens
#
# Usage:
#   gh-app-token                # Token for the project App (default)
#   gh-app-token --app project  # Same as the default
#   gh-app-token --app <name>   # Token for a declared named App
#
# Environment variables (optional overrides):
#   GH_APP_ID            — GitHub App ID (skips SSM lookup)
#   GH_INSTALLATION_ID   — GitHub Installation ID (skips SSM lookup)
#   GH_APP_PEM           — PEM private key contents (skips SSM lookup)
#   GH_APP_PEM_FILE      — Path to PEM file (skips SSM lookup)
#   AWS_REGION            — AWS region for SSM (default: us-west-2)
#
# SSM Parameter paths:
#   project: /fleetmind/<fleet_name>/agents/<agent_id>/github-app/{app-id,installation-id,pem}
#   alias:   /fleetmind/<fleet_name>/agents/<agent_id>/github-apps/<alias>/{app-id,installation-id,pem}
#
# Requires: openssl, curl, jq, aws cli

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
AWS_REGION="$${AWS_REGION:-us-west-2}"

die() { echo "$${SCRIPT_NAME}: error: $*" >&2; exit 1; }

base64url() {
  openssl enc -base64 -A | tr '+/' '-_' | tr -d '='
}

# Preserve the established project-App behavior when no selector is supplied.
APP_TYPE="project"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ $# -lt 2 ]] && die "Missing value for --app (expected: project or a declared alias)"
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

if [[ ! "$APP_TYPE" =~ ^[a-z][a-z0-9-]{0,62}$ ]]; then
  die "Invalid app alias: $APP_TYPE"
fi

AGENT_ENV_FILE="/etc/fleetmind/agent.env"
if [[ -f "$AGENT_ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$AGENT_ENV_FILE"
fi

FLEET_NAME="$${FLEET_NAME:-}"
AGENT_ID="$${AGENT_ID:-}"

[[ -z "$FLEET_NAME" ]] && die "FLEET_NAME not set. Is /etc/fleetmind/agent.env present and populated?"
[[ -z "$AGENT_ID" ]]   && die "AGENT_ID not set. Is /etc/fleetmind/agent.env present and populated?"
ALLOWLIST="/etc/fleetmind/github-apps.json"
[[ -r "$ALLOWLIST" ]] || die "GitHub App declaration allowlist is missing: $ALLOWLIST"
jq -e --arg app "$APP_TYPE" 'index($app) != null' "$ALLOWLIST" >/dev/null \
  || die "GitHub App '$APP_TYPE' is not declared for this agent"

if [[ "$APP_TYPE" == "project" ]]; then
  SSM_PREFIX="/fleetmind/$${FLEET_NAME}/agents/$${AGENT_ID}/github-app"
else
  SSM_PREFIX="/fleetmind/$${FLEET_NAME}/agents/$${AGENT_ID}/github-apps/$${APP_TYPE}"
fi

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

# ── systemd user services for this agent ─────────────────────────────────────
# These units deliberately live in the openclaw user's manager. Root's role
# ends at creating the account, prerequisites, directories, and lingering.
echo "[bootstrap] STAGE 9: systemd user unit write starting at $(date)"
echo "[bootstrap] Creating OpenClaw user services for agent: $AGENT_ID"

USER_SYSTEMD_DIR="$OPENCLAW_HOME/.config/systemd/user"
home_write mkdir "$USER_SYSTEMD_DIR"

%{ if openclaw_runtime_mode == "root-managed" ~}
home_write write "$USER_SYSTEMD_DIR/openclaw-$AGENT_ID.service" << EOF
[Unit]
Description=OpenClaw Agent ($AGENT_ID) — $FLEET_NAME fleet
# Workspace config is deployed by 'fleetmind push fleet' (after bootstrap completes).
# systemd silently skips start until that file exists, avoiding a restart-loop on
# first boot before the operator's first push. Once pull-self ships the workspace,
# 'systemctl --user restart' starts the service fresh.
ConditionPathExists=$OPENCLAW_HOME/.openclaw/openclaw.json
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
WorkingDirectory=$OPENCLAW_HOME
Restart=always
RestartSec=10

# OpenClaw application state (gateway config, memory, plugins) lives directly
# under the OS account home ($OPENCLAW_HOME/.openclaw/) — the standard
# one-agent-per-host contract. HOME here IS the OS account's own home; there
# is no separate workspace-as-HOME override.
Environment=HOME=$OPENCLAW_HOME
Environment=PATH=$RUNTIME_PATH

# Fetch fresh secrets before each start (idempotent)
# The user-owned env file is shared with the NATS subscriber below.
ExecStartPre=/usr/local/bin/fetch-agent-secrets $FLEET_NAME $AGENT_ID $ENV_FILE $AWS_REGION

# '-' means: don't fail if file is missing at unit-load time (it is created by ExecStartPre).
EnvironmentFile=-$ENV_FILE

ExecStart=$OPENCLAW_BIN gateway

StandardOutput=journal
StandardError=journal
SyslogIdentifier=openclaw-$AGENT_ID

[Install]
WantedBy=default.target
EOF

%{ else ~}
# OpenClaw owns the replaceable base unit. FleetMind owns only policy, never
# ExecStart/WorkingDirectory overrides (these would pin the old launcher).
home_write mkdir "$USER_SYSTEMD_DIR/openclaw-$AGENT_ID.service.d"
home_write write "$USER_SYSTEMD_DIR/openclaw-$AGENT_ID.service.d/50-fleetmind.conf" << EOF
[Unit]
ConditionPathExists=$OPENCLAW_HOME/.openclaw/openclaw.json
StartLimitBurst=5
StartLimitIntervalSec=60
[Service]
Environment=HOME=$OPENCLAW_HOME
Environment=PATH=$RUNTIME_PATH
Environment=FLEETMIND_OPENCLAW_BIN=$OPENCLAW_BIN
Environment=NPM_CONFIG_PREFIX=$OPENCLAW_RUNTIME_PREFIX
ExecStartPre=/usr/local/bin/fetch-agent-secrets $FLEET_NAME $AGENT_ID $ENV_FILE $AWS_REGION
EnvironmentFile=-$ENV_FILE
Restart=always
RestartSec=10
SyslogIdentifier=openclaw-$AGENT_ID
EOF
# First `pull-self --apply --restart --user-systemd` installs the native base
# after config validation/publication. Installing now would synthesize config
# and auth before the fleet's first push. No placeholder base is written.
%{ endif ~}

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
home_write write "$USER_SYSTEMD_DIR/$${NATS_SVC_NAME}.path" << EOF
[Unit]
Description=Watch for fleet.yaml — start NATS subscriber for $AGENT_ID once config is deployed
StartLimitIntervalSec=0

[Path]
PathExists=$NATS_FLEET_YAML
Unit=$${NATS_SVC_NAME}.service

[Install]
WantedBy=default.target
EOF

# Service unit: long-running fleetmind nats subscribe
home_write write "$USER_SYSTEMD_DIR/$${NATS_SVC_NAME}.service" << EOF
[Unit]
Description=FleetMind NATS subscriber ($AGENT_ID, mode=$NATS_MODE) — $FLEET_NAME fleet
After=openclaw-$AGENT_ID.service
StartLimitBurst=0
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$OPENCLAW_HOME
Restart=on-failure
RestartSec=30
LogLevelMax=debug

# Same OpenClaw application-state HOME as the gateway unit above —
# $OPENCLAW_HOME/.openclaw/, not the workspace directory.
Environment=HOME=$OPENCLAW_HOME
Environment=PATH=$RUNTIME_PATH
Environment=FLEET_YAML=$NATS_FLEET_YAML
Environment=OPENCLAW_GATEWAY_PORT=${gateway_port}
Environment=NATS_HEALTH_URL=http://nats.$FLEET_NAME.internal:8222/healthz
# Same user-owned credential file as the gateway. It carries Slack and
# model-provider keys plus GATEWAY_TOKEN for the PM webhook callback.
ExecStartPre=/usr/local/bin/fetch-agent-secrets $FLEET_NAME $AGENT_ID $ENV_FILE $AWS_REGION
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
WantedBy=default.target
EOF


# With lingering enabled, this user manager survives logout and starts at boot.
# Use its bus directly only during root bootstrap; all later service management
# is performed by openclaw itself with `systemctl --user`.
OPENCLAW_UID=$(id -u "$OPENCLAW_USER")
OPENCLAW_RUNTIME_DIR="/run/user/$OPENCLAW_UID"

# Source user-service controls from the runtime account's normal Bash profile.
# These target the real per-agent units and journald; no root-owned gateway unit,
# /var/log path, or sudo is involved.
OPENCLAW_ALIAS_PROFILE="$OPENCLAW_HOME/.config/fleetmind/openclaw-aliases.sh"
home_write write "$OPENCLAW_ALIAS_PROFILE" << EOF
# FleetMind OpenClaw controls for agent $AGENT_ID. Generated by bootstrap.
export PATH=$RUNTIME_PATH
export FLEETMIND_OPENCLAW_BIN=$OPENCLAW_BIN
export OPENCLAW_SYSTEMD_UNIT=openclaw-$AGENT_ID.service
%{ if openclaw_runtime_mode == "self-managed" ~}
export NPM_CONFIG_PREFIX=$OPENCLAW_RUNTIME_PREFIX
%{ endif ~}
# No PATH fallback to a retained system package if the selected runtime breaks.
openclaw() { "$OPENCLAW_BIN" "\$@"; }
# `sudo -iu openclaw` loads this profile. Keep the user-manager connection
# details here so operators only need the concise aliases below.
fleetmind_userctl() {
  env HOME=$OPENCLAW_HOME PATH=$RUNTIME_PATH XDG_RUNTIME_DIR=$OPENCLAW_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS=unix:path=$OPENCLAW_RUNTIME_DIR/bus systemctl --user "\$@"
}
fleetmind_userjournal() {
  journalctl --user "\$@"
}

alias ocalias='alias | grep -E "^alias (oc|openclaw-)"'
alias ocstatus='fleetmind_userctl status openclaw-$AGENT_ID.service --no-pager'
alias ocstart='fleetmind_userctl start openclaw-$AGENT_ID.service'
alias ocstop='fleetmind_userctl stop openclaw-$AGENT_ID.service'
alias ocrestart='fleetmind_userctl restart openclaw-$AGENT_ID.service'
alias oclog='fleetmind_userjournal -u openclaw-$AGENT_ID.service -n 100 --no-pager'
alias octail='fleetmind_userjournal -u openclaw-$AGENT_ID.service -f'
alias ocnatsstatus='fleetmind_userctl status $${NATS_SVC_NAME}.service --no-pager'
alias ocnatsrestart='fleetmind_userctl restart $${NATS_SVC_NAME}.service'
alias ocnatslog='fleetmind_userjournal -u $${NATS_SVC_NAME}.service -n 100 --no-pager'
alias ocnatstail='fleetmind_userjournal -u $${NATS_SVC_NAME}.service -f'

# Backward-compatible long names for operators already using this module.
alias openclaw-status='ocstatus'
alias openclaw-start='ocstart'
alias openclaw-stop='ocstop'
alias openclaw-restart='ocrestart'
alias openclaw-logs='octail'
alias openclaw-nats-status='ocnatsstatus'
alias openclaw-nats-restart='ocnatsrestart'
alias openclaw-nats-logs='ocnatstail'
EOF

OPENCLAW_BASHRC="$OPENCLAW_HOME/.bashrc"
OPENCLAW_BASH_PROFILE="$OPENCLAW_HOME/.bash_profile"
home_write append "$OPENCLAW_BASHRC" << 'BASHRC_EOF'
source "$HOME/.config/fleetmind/openclaw-aliases.sh"
BASHRC_EOF
# Login shells also load only the FleetMind profile.
home_write append "$OPENCLAW_BASH_PROFILE" << 'BASH_PROFILE_EOF'
source "$HOME/.config/fleetmind/openclaw-aliases.sh"
BASH_PROFILE_EOF

runuser -u "$OPENCLAW_USER" -- env \
  XDG_RUNTIME_DIR="$OPENCLAW_RUNTIME_DIR" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$OPENCLAW_RUNTIME_DIR/bus" \
  systemctl --user daemon-reload
runuser -u "$OPENCLAW_USER" -- env \
  XDG_RUNTIME_DIR="$OPENCLAW_RUNTIME_DIR" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$OPENCLAW_RUNTIME_DIR/bus" \
  systemctl --user enable --now "openclaw-$AGENT_ID.service" || true
runuser -u "$OPENCLAW_USER" -- env \
  XDG_RUNTIME_DIR="$OPENCLAW_RUNTIME_DIR" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$OPENCLAW_RUNTIME_DIR/bus" \
  systemctl --user enable --now "$${NATS_SVC_NAME}.path"
echo "[bootstrap] OpenClaw user services installed and enabled"
echo "[bootstrap]   Gateway start is gated until 'fleetmind push fleet' ships the workspace."
echo "[bootstrap]   On first push, openclaw can restart both user services without sudo."
echo "[bootstrap] NATS path unit enabled and started: $${NATS_SVC_NAME}.path"
echo "[bootstrap]   Will start $${NATS_SVC_NAME}.service when $NATS_FLEET_YAML appears"

echo "[bootstrap] Done. Agent $AGENT_ID provisioned (fleet: $FLEET_NAME) — gateway will start on next boot or manual start"
