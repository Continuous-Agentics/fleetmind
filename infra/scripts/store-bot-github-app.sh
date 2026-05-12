#!/bin/bash
# Note: prefer `fleetmind github-app store` (the TS CLI version) for new
# deploys. This script is retained for operators without a node runtime.
#
# store-bot-github-app.sh — Store a per-agent GitHub App's credentials in SSM
#
# Usage:
#   store-bot-github-app.sh \
#     --fleet <fleet_name> \
#     --agent <agent_id> \
#     --app-id 12345678 \
#     --installation-id 987654321 \
#     --pem-file ~/Downloads/my-bot.pem
#
# Prerequisites:
#   1. Create the GitHub App manually in the GitHub UI
#      (see docs/GITHUB-APPS.md for step-by-step)
#   2. Generate a private key and download the .pem file
#   3. Install the app on the agent's project repo
#   4. Have AWS credentials configured for the target account
#
# SSM paths created:
#   /fleetmind/<fleet>/agents/<agent>/github-app/app-id            (String)
#   /fleetmind/<fleet>/agents/<agent>/github-app/installation-id    (String)
#   /fleetmind/<fleet>/agents/<agent>/github-app/pem                (SecureString)
#
# Requires: aws cli

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
AWS_REGION="${AWS_REGION:-us-west-2}"

die()  { echo "${SCRIPT_NAME}: error: $*" >&2; exit 1; }
info() { echo "→ $*" >&2; }

# -----------------------------------------------------------------------------
# Parse args
# -----------------------------------------------------------------------------

FLEET_NAME=""
AGENT_ID=""
APP_ID=""
INSTALLATION_ID=""
PEM_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fleet)           [[ $# -lt 2 ]] && die "Missing value for --fleet";           FLEET_NAME="$2";      shift 2 ;;
    --agent)           [[ $# -lt 2 ]] && die "Missing value for --agent";           AGENT_ID="$2";        shift 2 ;;
    --app-id)          [[ $# -lt 2 ]] && die "Missing value for --app-id";          APP_ID="$2";          shift 2 ;;
    --installation-id) [[ $# -lt 2 ]] && die "Missing value for --installation-id"; INSTALLATION_ID="$2"; shift 2 ;;
    --pem-file)        [[ $# -lt 2 ]] && die "Missing value for --pem-file";        PEM_FILE="$2";        shift 2 ;;
    --region)          [[ $# -lt 2 ]] && die "Missing value for --region";          AWS_REGION="$2";      shift 2 ;;
    --help|-h)
      head -25 "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -z "$FLEET_NAME" ]]       && die "Missing required argument: --fleet"
[[ -z "$AGENT_ID" ]]         && die "Missing required argument: --agent"
[[ -z "$APP_ID" ]]           && die "Missing required argument: --app-id"
[[ -z "$INSTALLATION_ID" ]]  && die "Missing required argument: --installation-id"
[[ -z "$PEM_FILE" ]]         && die "Missing required argument: --pem-file"
[[ ! -f "$PEM_FILE" ]]       && die "PEM file not found: $PEM_FILE"

# -----------------------------------------------------------------------------
# Verify AWS context
# -----------------------------------------------------------------------------

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die "AWS credentials not configured. Ensure your AWS credentials are set up for the target account."

info "AWS account:      ${ACCOUNT_ID}"
info "Fleet:            ${FLEET_NAME}"
info "Agent:            ${AGENT_ID}"
info "App ID:           ${APP_ID}"
info "Installation ID:  ${INSTALLATION_ID}"
info "PEM file:         ${PEM_FILE}"
info "Region:           ${AWS_REGION}"
echo ""
read -r -p "Store these credentials in SSM? [y/N] " CONFIRM
[[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]] && { echo "Aborted."; exit 0; }

SSM_PREFIX="/fleetmind/${FLEET_NAME}/agents/${AGENT_ID}/github-app"

# -----------------------------------------------------------------------------
# Store parameters (idempotent via --overwrite)
# -----------------------------------------------------------------------------

store_param() {
  local name="$1" value="$2" type="$3"
  local output
  # Try a fresh put first (with tags). If the param already exists, AWS
  # rejects tags on an overwrite, so fall back to a bare --overwrite call.
  output=$(aws ssm put-parameter \
    --name "$name" \
    --value "$value" \
    --type "$type" \
    --region "$AWS_REGION" \
    --tags \
      "Key=fleet,Value=${FLEET_NAME}" \
      "Key=agent,Value=${AGENT_ID}" \
      "Key=managed-by,Value=fleetmind" \
    2>&1) || {
    if echo "$output" | grep -q "ParameterAlreadyExists\|already exists"; then
      output=$(aws ssm put-parameter \
        --name "$name" \
        --value "$value" \
        --type "$type" \
        --region "$AWS_REGION" \
        --overwrite \
        2>&1) || die "SSM put-parameter failed for ${name}: ${output}"
    else
      die "SSM put-parameter failed for ${name}: ${output}"
    fi
  }
}

info "Storing ${SSM_PREFIX}/app-id..."
store_param "${SSM_PREFIX}/app-id" "$APP_ID" "String"
info "  ✓ app-id"

info "Storing ${SSM_PREFIX}/installation-id..."
store_param "${SSM_PREFIX}/installation-id" "$INSTALLATION_ID" "String"
info "  ✓ installation-id"

info "Storing ${SSM_PREFIX}/pem..."
PEM_VALUE=$(cat "$PEM_FILE")
store_param "${SSM_PREFIX}/pem" "$PEM_VALUE" "SecureString"
info "  ✓ pem (SecureString)"

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------

echo ""
info "Done! Credentials stored in account ${ACCOUNT_ID}."
info ""
info "Verify with (on the agent EC2):"
info "  gh-app-token"
info ""
info "SSM paths:"
info "  ${SSM_PREFIX}/app-id"
info "  ${SSM_PREFIX}/installation-id"
info "  ${SSM_PREFIX}/pem"
