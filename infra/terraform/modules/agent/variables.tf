variable "name" {
  description = "Agent name within the fleet (e.g. \"pm\", \"forge\"). Used for resource naming and secret namespace."
  type        = string

  validation {
    condition     = length(var.name) > 0
    error_message = "name must not be empty."
  }
}

variable "fleet_name" {
  description = "Fleet name. Combined with var.name to form resource names ($${fleet_name}-$${name}-*) and secret namespace ($${fleet_name}/agents/$${name}/*)."
  type        = string
}

variable "aws_region" {
  description = "AWS region. Used to construct ARNs for IAM policy resource scoping."
  type        = string
}

variable "ami_id" {
  description = "AMI ID for the agent instance. Typically derived once at the root from data.aws_ami and passed into every agent."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type for this agent."
  type        = string
}

variable "subnet_id" {
  description = "Subnet ID to launch the instance into. Should be a private subnet — agents only need egress."
  type        = string
}

variable "vpc_security_group_ids" {
  description = "Security group IDs to attach to the instance."
  type        = list(string)
}

variable "root_volume_size" {
  description = "Root EBS volume size in GB."
  type        = number
  default     = 50
}

# ── User-data bootstrap inputs ───────────────────────────────────────────────

variable "openclaw_version" {
  description = "OpenClaw npm package version pin for the bootstrap script."
  type        = string
}

variable "node_version" {
  description = "Node.js major version for the bootstrap script (nvm install)."
  type        = string
}

variable "fleetmind_version" {
  description = "Fleetmind CLI npm package version pin for the bootstrap script."
  type        = string
}

# ── IAM policy inputs ────────────────────────────────────────────────────────

variable "context_store_enabled" {
  description = "Whether to grant the agent role read/write on the DynamoDB ContextStore table. Must be a static bool (not derived from a computed resource attribute) so Terraform can evaluate it at plan time."
  type        = bool
  default     = false
}

variable "context_store_table_arn" {
  description = "ARN of the DynamoDB ContextStore table. Used in the IAM policy when context_store_enabled = true. Pass empty string when context_store_enabled = false."
  type        = string
  default     = ""
}

variable "shared_secret_arns" {
  description = "Additional Secrets Manager ARNs (outside the $${fleet_name}/agents/$${name}/* and $${fleet_name}/shared/* namespaces) that the agent role must be able to read. Intended for caller-supplied secrets whose ARNs the caller doesn't fully control (e.g. AWS-managed secrets where the service picks the name)."
  type        = list(string)
  default     = []
}

variable "secret_recovery_window_days" {
  description = "recovery_window_in_days for the per-agent Slack + model-provider secrets."
  type        = number
  default     = 7
}

# ── NATS subscriber ─────────────────────────────────────────────────────

# nats_enabled is intentionally absent. The NATS subscriber units are written
# for every agent unconditionally. If delegation.nats is not in fleet.yaml the
# subscriber exits 0 and systemd leaves it alone — no opt-in required.

variable "is_orchestrator" {
  description = "True when this agent is the PM/orchestrator bot. Controls whether the NATS subscriber runs in --mode pm (orchestrator) or --mode worker."
  type        = bool
  default     = false
}

variable "gateway_port" {
  description = "OpenClaw gateway port for this agent. Used by the NATS PM subscriber to construct the OpenClaw webhook URL."
  type        = number
  default     = 18789
}

variable "fleetmind_package" {
  description = "npm package name for the fleetmind CLI."
  type        = string
  default     = "@continuous-agentics/fleetmind"
}

variable "rollout_trigger" {
  description = "Arbitrary rollout token. Changing this forces EC2 replacement while AMI/user_data drift remains ignored."
  type        = string
  default     = ""
}

variable "model_providers" {
  description = "Lowercase model-provider tokens this agent needs API keys for (e.g. [\"anthropic\", \"openai\"]). REQUIRED — explicit provider declaration; no inference from model strings. Each provider gets its own Secrets Manager secret at <fleet_name>/agents/<name>/providers/<provider>. Named model_providers (not just providers) because Terraform reserves the providers meta-argument on module blocks."
  type        = list(string)
  validation {
    condition     = length(var.model_providers) > 0
    error_message = "model_providers must contain at least one provider id (e.g. [\"anthropic\"]). Explicit provider declaration is required — there is no fallback to inferring from model strings."
  }
}
