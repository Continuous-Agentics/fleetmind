# test-fleet-2 workspace — infra-only tfvars.
#
# Pairs with a sibling fleet-test-fleet-2.yaml file (operator creates) that
# defines the fleet name + agents. `fleetmind render --fleet fleet-test-fleet-2.yaml`
# emits fleet_name, agent_names, agent_models, agent_orchestrators, and
# wake_target_session_key into infra/terraform/fleet.derived.tfvars.
#
# This file holds infrastructure-only knobs.

# ── Region ──────────────────────────────────────────────────────────────────
aws_region = "us-west-2"

# ── EC2 instance class ──────────────────────────────────────────────────────
instance_type = "t3.medium"

# ── Per-agent gateway ports ─────────────────────────────────────────────────
# Keys must match the agent ids in fleet-test-fleet-2.yaml.
agent_ports = {
  blanket = 18789
  charlie = 18790
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
# Off for cost savings on this test fleet — bots use NAT to reach SSM/SM.
enable_interface_endpoints = false

# ── Per-agent overrides (optional) ──────────────────────────────────────────
agent_instance_types = {}
