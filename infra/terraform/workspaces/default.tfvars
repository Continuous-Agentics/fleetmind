# default workspace — infra-only tfvars for the gg-sandbox fleet.
#
# fleet_name, agent_names, agent_models, agent_orchestrators, and
# wake_target_session_key are derived from fleet.yaml by `fleetmind render`
# and written to infra/terraform/fleet.derived.tfvars (auto-loaded by Terraform).
# Don't set them here — they'd shadow the renderer's output.
#
# This file holds *infrastructure-only* knobs that fleet.yaml doesn't own.

# ── Region ──────────────────────────────────────────────────────────────────
aws_region = "us-west-2"

# ── EC2 instance class ──────────────────────────────────────────────────────
instance_type = "t3.medium"

# ── Per-agent gateway ports ─────────────────────────────────────────────────
agent_ports = {
  conductor = 18789
  forge     = 18790
}

# ── Software pins ───────────────────────────────────────────────────────────
openclaw_version  = "latest"
node_version      = "22"
fleetmind_version = "0.4.3"

# ── Delegation (task ledger module) ─────────────────────────────────────────
delegation_enabled = true

# ── RDS (off — fleetmind doesn't use it today) ──────────────────────────────
enable_rds = false

# ── VPC interface endpoints ─────────────────────────────────────────────────
# Adds ~$80/mo for SSM/SecretsManager/ec2messages/ssmmessages endpoints so
# bots reach those services without going through NAT. Toggle off for cost
# savings if NAT is healthy.
enable_interface_endpoints = true

# ── Per-agent overrides (optional) ──────────────────────────────────────────
agent_instance_types = {}
