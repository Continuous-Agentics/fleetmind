variable "fleet_name" {
  description = "Name of the FleetMind fleet. Used to namespace all AWS resources and workspace paths."
  type        = string
  default     = "fleetmind"
}

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "architecture" {
  description = "CPU architecture for both the AMI and the instance type. Must be 'arm64' (Graviton, default) or 'x86_64' (Intel/AMD). var.instance_type and var.agent_instance_types entries must match this architecture (e.g. t4g.* for arm64, t3.* for x86_64)."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "architecture must be 'arm64' or 'x86_64'."
  }
}

variable "instance_type" {
  description = "EC2 instance type. Must match var.architecture (t4g.* for arm64, t3.*/t4.*/m*.* for x86_64). t4g.large comfortably runs a single OpenClaw agent; bump up if the agent does heavy work."
  type        = string
  default     = "t4g.large"
}

variable "agent_names" {
  description = "List of agent names. Each gets its own EC2 instance, IAM role, and per-agent secrets. Must be non-empty and unique."
  type        = list(string)
  default     = ["orchestrator", "pixel", "forge"]

  validation {
    condition     = length(var.agent_names) > 0
    error_message = "agent_names must not be empty — a fleet has at least one agent."
  }

  validation {
    condition     = length(var.agent_names) == length(toset(var.agent_names))
    error_message = "agent_names must be unique."
  }
}

variable "openclaw_version" {
  description = "OpenClaw npm package version to install. Use 'latest' or pin to a specific version."
  type        = string
  default     = "latest"
}

variable "node_version" {
  description = "Node.js major version to install via NodeSource RPMs."
  type        = string
  default     = "22"
}

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

variable "vpc_cidr" {
  description = "CIDR block for the created VPC. Ignored when vpc_id is set (BYO VPC mode)."
  type        = string
  default     = "10.0.0.0/16"
}

variable "vpc_id" {
  description = "ID of an existing VPC to deploy into. Leave empty to create a new VPC."
  type        = string
  default     = ""
}

# tflint-ignore: terraform_unused_declarations
variable "existing_public_subnet_ids" {
  description = "IDs of existing public subnets when deploying into an existing VPC. Currently unused by the module — agents and NATS live in private subnets — but accepted for parity with the created-VPC path and to leave room for future public-facing resources (e.g. an ALB). Pass an empty list if you don't have public subnets to share."
  type        = list(string)
  default     = []
}

variable "existing_private_subnet_ids" {
  description = "IDs of existing private subnets (1+ required, 2+ recommended for AZ HA) when deploying into an existing VPC. Agents are round-robin-placed across whatever subnets you provide; NATS uses the first one."
  type        = list(string)
  default     = []

  validation {
    condition     = var.vpc_id == "" || length(var.existing_private_subnet_ids) >= 1
    error_message = "existing_private_subnet_ids must include at least 1 subnet ID when vpc_id is set. Provide 2+ subnets in different AZs for HA."
  }
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

# ── Per-agent overrides (optional) ────────────────────────────────────────────
# All default to empty maps so existing deployments are unaffected.
# Use these in tfvars to give specific agents different sizing.

variable "agent_instance_types" {
  description = "Per-agent EC2 instance type overrides (map of agent_id → instance_type). Falls back to var.instance_type for any agent not listed."
  type        = map(string)
  default     = {}
}

variable "agent_orchestrators" {
  description = "Map of agent_id → bool indicating which agents are PM/orchestrator bots. Used by the task-ledger module to split IAM policy attachments: orchestrators get the pm policy; non-orchestrators get the worker policy."
  type        = map(bool)
  default     = {}
}

variable "agent_providers" {
  description = "REQUIRED. Map of agent_id → list of lowercase model-provider tokens (e.g. {ranger = [\"anthropic\"], copilot = [\"anthropic\", \"openai\"]}). Drives per-provider Secrets Manager secrets at <fleet_name>/agents/<agent>/providers/<provider>. Explicit declaration is required — there is no inference from model strings. Every name in var.agent_names must have an entry with at least one provider."
  type        = map(list(string))
  validation {
    condition     = length(var.agent_providers) > 0
    error_message = "agent_providers must be non-empty and supply a provider list for every agent in agent_names."
  }
  validation {
    condition     = alltrue([for k, v in var.agent_providers : length(v) > 0])
    error_message = "Every agent in agent_providers must list at least one provider (e.g. [\"anthropic\"])."
  }
}

variable "delegation_enabled" {
  description = "Instantiate the task-ledger submodule (DynamoDB task table, S3 narratives bucket, IAM policies). Default true — the bot-delegation flow is a core Fleetmind feature. Set false only for fleets that explicitly do not use delegation (e.g. single-bot fleets) to skip the substrate. Note: terminal task events reach the PM over NATS push, not an EventBridge Pipe/SSM wake pipeline (that path was removed)."
  type        = bool
  default     = true
}

variable "enable_interface_endpoints" {
  description = "Provision VPC interface endpoints for SSM (ssm, ssmmessages, ec2messages) and Secrets Manager. Adds ~$80/mo (4 endpoints × ~$20/mo). Default false. Recommended for fleets in fully-private subnets without NAT, or operators who want SSM resilience independent of NAT health."
  type        = bool
  default     = false
}


variable "fleetmind_version" {
  description = "Version of @continuous-agentics/fleetmind to install on each agent EC2."
  type        = string
  default     = "latest"
}

variable "secret_recovery_window_days" {
  description = "AWS Secrets Manager recovery window (days) after deletion. Applied to per-agent Slack and model-provider secrets. Must be 0 (delete immediately, useful for ephemeral test fleets) or 7–30 (AWS-enforced range)."
  type        = number
  default     = 7

  validation {
    condition     = var.secret_recovery_window_days == 0 || (var.secret_recovery_window_days >= 7 && var.secret_recovery_window_days <= 30)
    error_message = "secret_recovery_window_days must be 0 or in the inclusive range 7\u201330 (AWS Secrets Manager constraint)."
  }
}

# ── NATS transport variables ──────────────────────────────────────────────────

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
