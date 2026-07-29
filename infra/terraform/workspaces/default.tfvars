# default.tfvars — infra-only knobs for the default workspace.
#
# DO NOT set fleet_name, agent_names, agent_orchestrators, or agent_providers
# here — those are derived from fleet.yaml by `fleetmind render` into
# workspaces/default.derived.tfvars (gitignored).

# ── Region ──────────────────────────────────────────────────────────────────
aws_region = "us-west-2"

# ── CPU architecture ────────────────────────────────────────────────────────
# Must be "arm64" (Graviton, default) or "x86_64". The AMI is selected to
# match. var.instance_type and var.agent_instance_types entries must align
# with this (t4g.* for arm64, t3.*/t4.* for x86_64).
architecture = "arm64"

# ── EC2 sizing ──────────────────────────────────────────────────────────────
instance_type = "t4g.large"

# Per-agent overrides (optional). Agents not listed fall back to instance_type.
agent_instance_types = {
  # conductor = "t4g.xlarge"
}

# ── Software pins ───────────────────────────────────────────────────────────
openclaw_version  = "latest"
node_version      = "22"
fleetmind_version = "0.10.4"

# ── Delegation substrate ────────────────────────────────────────────────────
# Task-ledger DDB + S3 narratives. Default true.
# Set false only for single-bot fleets that don't use bot-to-bot delegation.
# Note: with the NATS transport, the EventBridge wake path is replaced by
# the NATS subscriber services (fleetmind-nats-<agent>.service). The TF
# module still provisions the task-ledger DDB + S3 when delegation_enabled=true.
delegation_enabled = true

# ── VPC interface endpoints ─────────────────────────────────────────────────
# Adds ~$80/mo for SSM/SecretsManager/ec2messages/ssmmessages endpoints.
# Recommended for production; off by default to keep test fleets cheap.
enable_interface_endpoints = false

# ── Secrets Manager recovery ────────────────────────────────────────────────
# 0 = delete immediately (no recovery delay on terraform destroy — useful while
# iterating on a fleet). 7–30 = days of recovery for production. Default below
# is 0 since template-derived fleets typically get destroyed several times
# before stabilizing; bump to 7+ for production fleets.
secret_recovery_window_days = 0

# ── BYO VPC (optional) ──────────────────────────────────────────────────────
# Leave vpc_id empty (default) to let the module create a fresh VPC.
# To deploy into an existing VPC, set vpc_id + existing_private_subnet_ids
# (1+ required; 2+ in distinct AZs recommended for HA). Public subnets are
# optional — currently unused by the module (no ALB/NLB), reserved for future.
#
# vpc_id                      = "vpc-0123456789abcdef0"
# existing_private_subnet_ids = ["subnet-ccc", "subnet-ddd"]
# existing_public_subnet_ids  = []  # or ["subnet-aaa", "subnet-bbb"] if you have them
