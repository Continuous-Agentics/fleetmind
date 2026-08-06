###############################################################################
# Operator-facing variables.
#
# Most of these pass straight through to FleetMind embedded Terraform module. A few are
# derived from fleet.yaml by `fleetmind render` and written to
# workspaces/<name>.derived.tfvars (don't set those in workspaces/<name>.tfvars
# manually).
###############################################################################

# ── Derived by `fleetmind render` from fleet.yaml ────────────────────────────
# Do not set these in workspaces/<name>.tfvars — the renderer writes them to
# workspaces/<name>.derived.tfvars.

variable "fleet_name" {
  description = "Fleet name (derived). Set in fleet.yaml under fleet.name."
  type        = string
}

variable "agent_names" {
  description = "List of agent IDs (derived). Set in fleet.yaml under agents.list[].id."
  type        = list(string)
}

variable "agent_orchestrators" {
  description = "Map of agent_id → orchestrator-flag (derived). True for PM bots, false for workers."
  type        = map(bool)
  default     = {}
}

variable "agent_providers" {
  description = "REQUIRED. Map of agent_id → list of lowercase model-provider tokens (derived from fleet.yaml's per-agent `providers:` list). Drives per-provider Secrets Manager secrets at <fleet>/agents/<agent>/providers/<provider> in FleetMind embedded Terraform module >= v0.5.0. No default — explicit declaration is required."
  type        = map(list(string))
}

variable "agent_github_apps" {
  description = "Map of agent_id → explicitly declared GitHub App names (derived from fleet.yaml). IAM-only; credentials never enter Terraform state."
  type        = map(list(string))
  default     = {}

  validation {
    condition = alltrue(flatten([
      for apps in values(var.agent_github_apps) : [
        for app in apps : can(regex("^[a-z][a-z0-9-]{0,62}$", app))
      ]
    ]))
    error_message = "Every agent_github_apps entry must be a lowercase GitHub App alias matching ^[a-z][a-z0-9-]{0,62}$ (including the legacy 'project' alias)."
  }

  validation {
    condition     = alltrue([for apps in values(var.agent_github_apps) : length(apps) == length(distinct(apps))])
    error_message = "Each agent_github_apps list must not contain duplicate GitHub App aliases."
  }
}

# ── Operator-owned infrastructure knobs ──────────────────────────────────────
# Set these in workspaces/<name>.tfvars.

variable "aws_region" {
  description = "AWS region for the fleet."
  type        = string
  default     = "us-west-2"
}

variable "architecture" {
  description = "CPU architecture for both the AMI and the instance type. 'arm64' (Graviton, default) or 'x86_64' (Intel/AMD). var.instance_type and var.agent_instance_types entries must match."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "architecture must be 'arm64' or 'x86_64'."
  }
}

variable "instance_type" {
  description = "Default EC2 instance type for agent bots. Must match var.architecture (t4g.* for arm64, t3.*/t4.* for x86_64)."
  type        = string
  default     = "t4g.large"
}

variable "agent_instance_types" {
  description = "Per-agent EC2 instance type overrides. Agents not listed fall back to var.instance_type."
  type        = map(string)
  default     = {}
}

variable "openclaw_version" {
  description = "OpenClaw npm package version pin."
  type        = string
  default     = "latest"
}

variable "node_version" {
  description = "Node.js major version (installed from the NodeSource RPM repository). Only version 24 is supported."
  type        = string
  default     = "24"

  validation {
    condition     = var.node_version == "24"
    error_message = "node_version must be the exact string \"24\"."
  }
}

variable "fleetmind_version" {
  description = "Fleetmind CLI version pin. Must be an exact version (no 'latest') and must match the renderer that produced the .derived.tfvars in this checkout."
  type        = string
  default     = "0.10.4"
}

variable "delegation_enabled" {
  description = "Provision the task-ledger substrate (DynamoDB tasks + S3 narratives + EventBridge Pipe). Default true."
  type        = bool
  default     = true
}

variable "enable_interface_endpoints" {
  description = "Provision SSM + Secrets Manager interface endpoints (~$80/mo, 4 endpoints * ~$20/mo). Recommended for production fleets that want SSM resilience independent of NAT health."
  type        = bool
  default     = false
}

variable "secret_recovery_window_days" {
  description = "AWS Secrets Manager recovery window (days). Must be 0 or 7–30. Use 0 for ephemeral test fleets to avoid the recovery delay on terraform destroy."
  type        = number
  default     = 7
}

# ── BYO VPC (optional) ───────────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "CIDR block for the created VPC. Ignored when vpc_id is set (BYO VPC mode)."
  type        = string
  default     = "10.0.0.0/16"
}

variable "vpc_id" {
  description = "ID of an existing VPC to deploy into. Leave empty (default) to create a new VPC."
  type        = string
  default     = ""
}

variable "existing_public_subnet_ids" {
  description = "Public subnet IDs (2 required) when deploying into an existing VPC."
  type        = list(string)
  default     = []
}

variable "existing_private_subnet_ids" {
  description = "Private subnet IDs (2 required) when deploying into an existing VPC."
  type        = list(string)
  default     = []
}

# ── Advanced module inputs ───────────────────────────────────────────────────
# Forwarded unchanged to the embedded FleetMind infrastructure module.

variable "allowed_ssh_cidrs" {
  description = "CIDRs allowed to SSH to the fleet instance. Default empty — use SSM Session Manager instead."
  type        = list(string)
  default     = []
}

variable "ami_id" {
  description = "AMI ID override. Defaults to latest Amazon Linux 2023 if left empty."
  type        = string
  default     = ""
}

variable "context_store_backend" {
  description = "Backend for the fleet ContextStore (cross-agent shared key-value state). Only \"dynamodb\" is supported today; the variable exists to set up the seam for future backends (e.g. \"rds\") without an interface break. When the runtime gains additional backends, valid values will be widened here."
  type        = string
  default     = "dynamodb"

  validation {
    condition     = contains(["dynamodb"], var.context_store_backend)
    error_message = "context_store_backend must be \"dynamodb\" (the only backend the agent runtime currently supports)."
  }
}

variable "nats_enabled" {
  description = "When true, provisions a single-node NATS server EC2 instance and a Cloud Map private DNS namespace (<fleet_name>.internal). Agents discover the NATS server at nats://<fleet_name>.internal:4222. Default true when delegation is enabled — the standard inter-bot messaging transport. Set false to skip NATS provisioning (rare)."
  type        = bool
  default     = true
}

variable "nats_instance_type" {
  description = "EC2 instance type for the NATS server. Must match var.architecture (t4g.small for arm64, t3.small for x86_64). t4g.small comfortably handles thousands of bot messages per second."
  type        = string
  default     = "t4g.small"
}

variable "nats_version" {
  description = "NATS server version to install from GitHub releases (semver without 'v' prefix). Pin this for reproducible deploys."
  type        = string
  default     = "2.14.1"
}

variable "nats_auth_token" {
  description = "Optional NATS auth token. When set, clients must present this token to connect. Leave empty to disable token auth."
  type        = string
  default     = ""
  sensitive   = true
}

variable "nats_tls_enabled" {
  description = "Enable TLS listener on the NATS server. Requires nats_tls_cert_pem and nats_tls_key_pem."
  type        = bool
  default     = false
}

variable "nats_tls_cert_pem" {
  description = "PEM-encoded TLS certificate for the NATS server. Used only when nats_tls_enabled = true."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = !var.nats_tls_enabled || trimspace(var.nats_tls_cert_pem) != ""
    error_message = "nats_tls_cert_pem must be set when nats_tls_enabled is true."
  }
}

variable "nats_tls_key_pem" {
  description = "PEM-encoded private key for the NATS server TLS certificate. Used only when nats_tls_enabled = true."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = !var.nats_tls_enabled || trimspace(var.nats_tls_key_pem) != ""
    error_message = "nats_tls_key_pem must be set when nats_tls_enabled is true."
  }
}

variable "nats_tls_ca_pem" {
  description = "Optional PEM-encoded CA certificate for NATS TLS. Set when you want to require client cert validation."
  type        = string
  default     = ""
  sensitive   = true
}

variable "agent_rollout_trigger" {
  description = "Arbitrary rollout token for agent instances. Change this value to force replacement when user_data/AMI changes are otherwise ignored."
  type        = string
  default     = ""
}

variable "nats_rollout_trigger" {
  description = "Arbitrary rollout token for the NATS instance. Change this value to force replacement when user_data/AMI changes are otherwise ignored."
  type        = string
  default     = ""
}
