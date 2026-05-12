# Append this to ./rendered/fleet.auto.tfvars after running `npx fleetmind render`
# These are infrastructure vars NOT derived from fleet.yaml.

# ── Region ──────────────────────────────────────────────────────────────────
aws_region = "us-west-2"

# ── Per-agent gateway ports ─────────────────────────────────────────────────
agent_ports = {
  conductor = 18789
  forge     = 18790
}

# ── Delegation: enables the task-ledger module (DDB + S3 + EventBridge Pipe) ─
delegation_enabled = true

agent_orchestrators = {
  conductor = true
  forge     = false
}

# OpenClaw session key for terminal-wake routing.
# Format: agent:main:slack:channel:<channel_id>
# REPLACE: set this to the Slack channel ID where Conductor lives, e.g. C0ABC123XYZ
wake_target_session_key = "agent:main:slack:channel:C0B2NNJEFKR"

# ── VPC interface endpoints (opt-in) ────────────────────────────────────────────
# Enable interface endpoints for the gg-sandbox test fleet so SSM works
# independently of NAT health. Can be removed for cost savings after debugging.
# ~$80/mo (4 endpoints x ~$20/mo each).
enable_interface_endpoints = true
