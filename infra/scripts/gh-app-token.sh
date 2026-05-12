#!/bin/bash
# gh-app-token — Generate short-lived GitHub App installation tokens
#
# Usage:
#   gh-app-token              # Read+write token for this agent's project repo (default)
#   gh-app-token --app project  # Same as above (explicit)
#
# The script fetches credentials from AWS SSM Parameter Store and exchanges
# them for a 1-hour GitHub installation access token.
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
# Agent identity is read from /etc/fleetmind/agent.env (FLEET_NAME, AGENT_ID).
#
# Requires: openssl, curl, jq, aws cli

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
AWS_REGION="${AWS_REGION:-us-west-2}"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

die() { echo "${SCRIPT_NAME}: error: $*" >&2; exit 1; }

base64url() {
  openssl enc -base64 -A | tr '+/' '-_' | tr -d '='
}

# -----------------------------------------------------------------------------
# Parse args
# -----------------------------------------------------------------------------

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

# Only "project" is a valid app type in FleetMind
[[ "$APP_TYPE" != "project" ]] && die "Unknown app type: $APP_TYPE (only 'project' is supported)"

# -----------------------------------------------------------------------------
# Resolve SSM paths from agent identity
# -----------------------------------------------------------------------------

# Load agent identity from /etc/fleetmind/agent.env
AGENT_ENV_FILE="/etc/fleetmind/agent.env"

if [[ -f "$AGENT_ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$AGENT_ENV_FILE"
fi

FLEET_NAME="${FLEET_NAME:-}"
AGENT_ID="${AGENT_ID:-}"

[[ -z "$FLEET_NAME" ]] && die "FLEET_NAME not set. Is /etc/fleetmind/agent.env present and populated?"
[[ -z "$AGENT_ID" ]]   && die "AGENT_ID not set. Is /etc/fleetmind/agent.env present and populated?"

SSM_PREFIX="/fleetmind/${FLEET_NAME}/agents/${AGENT_ID}/github-app"

# -----------------------------------------------------------------------------
# Fetch credentials (env vars override SSM)
# -----------------------------------------------------------------------------

fetch_ssm() {
  local name="$1"
  # Always use --with-decryption; harmless on String params, required for SecureString
  aws ssm get-parameter \
    --name "$name" \
    --region "$AWS_REGION" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text 2>/dev/null || die "Failed to fetch SSM parameter: $name"
}

if [[ -n "${GH_APP_ID:-}" ]]; then
  APP_ID="$GH_APP_ID"
else
  APP_ID=$(fetch_ssm "${SSM_PREFIX}/app-id")
fi

if [[ -n "${GH_INSTALLATION_ID:-}" ]]; then
  INSTALLATION_ID="$GH_INSTALLATION_ID"
else
  INSTALLATION_ID=$(fetch_ssm "${SSM_PREFIX}/installation-id")
fi

if [[ -n "${GH_APP_PEM:-}" ]]; then
  PEM_KEY="$GH_APP_PEM"
elif [[ -n "${GH_APP_PEM_FILE:-}" ]]; then
  [[ ! -f "$GH_APP_PEM_FILE" ]] && die "PEM file not found: $GH_APP_PEM_FILE"
  PEM_KEY=$(cat "$GH_APP_PEM_FILE")
else
  PEM_KEY=$(fetch_ssm "${SSM_PREFIX}/pem")
fi

[[ -z "$APP_ID" ]]          && die "App ID is empty"
[[ -z "$INSTALLATION_ID" ]] && die "Installation ID is empty"
[[ -z "$PEM_KEY" ]]         && die "PEM key is empty"

# -----------------------------------------------------------------------------
# Generate JWT (RS256, valid 10 minutes)
# -----------------------------------------------------------------------------

NOW=$(date +%s)
IAT=$((NOW - 60))        # 60 seconds in the past to account for clock drift
EXP=$((NOW + 600))       # 10 minutes

HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | base64url)
PAYLOAD=$(echo -n "{\"iss\":${APP_ID},\"iat\":${IAT},\"exp\":${EXP}}" | base64url)

# Write PEM to a temp file for openssl
PEM_TMP=$(mktemp)
trap 'rm -f "$PEM_TMP"' EXIT
echo "$PEM_KEY" > "$PEM_TMP"

SIGNATURE=$(echo -n "${HEADER}.${PAYLOAD}" | \
  openssl dgst -sha256 -sign "$PEM_TMP" | base64url)

JWT="${HEADER}.${PAYLOAD}.${SIGNATURE}"

# -----------------------------------------------------------------------------
# Exchange JWT for installation access token
# -----------------------------------------------------------------------------

RESPONSE=$(curl -sS -w "\n%{http_code}" \
  -X POST \
  -H "Authorization: Bearer ${JWT}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens") \
  || die "Failed to connect to GitHub API (network/DNS/TLS error)"

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" != "201" ]]; then
  die "GitHub API returned HTTP ${HTTP_CODE}: ${BODY}"
fi

TOKEN=$(echo "$BODY" | jq -r '.token')
EXPIRES=$(echo "$BODY" | jq -r '.expires_at')

[[ "$TOKEN" == "null" || -z "$TOKEN" ]] && die "Failed to extract token from response: ${BODY}"

# Output token (and expiry to stderr for logging)
echo "$TOKEN"
echo "Token expires: ${EXPIRES}" >&2
