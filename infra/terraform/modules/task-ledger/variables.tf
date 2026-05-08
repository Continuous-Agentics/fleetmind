# =============================================================================
# task-ledger module — variables
# =============================================================================

variable "name_prefix" {
  type        = string
  description = "Prefix applied to all resource names (e.g. 'fleetmind-' or 'acme-fleet-')."
  default     = "fleetmind-"
}

variable "aws_region" {
  type        = string
  description = "AWS region for all resources."
  default     = "us-east-1"
}

# ── Worker / PM roles ─────────────────────────────────────────────────────────

variable "worker_role_names" {
  type        = list(string)
  description = "Names of existing IAM roles for worker bots. The bot-ledger-worker policy is attached to each."
  default     = []
}

variable "pm_role_names" {
  type        = list(string)
  description = "Names of existing IAM roles for PM bots. The bot-ledger-pm policy is attached to each."
  default     = []
}

# ── Wake signaling (SSM target) ───────────────────────────────────────────────

variable "wake_target_instance_tag_key" {
  type        = string
  description = "EC2 tag key used to identify the target OpenClaw instance for SSM Run Command."
  default     = "Name"
}

variable "wake_target_instance_tag_value" {
  type        = string
  description = "EC2 tag value matching the target PM bot instance."
}

variable "wake_target_session_key" {
  type        = string
  description = "OpenClaw session key to wake on the target instance. Format: agent:main:slack:channel:<channel_id>. Resolved at runtime via sessions.json."
}

# ── S3 ────────────────────────────────────────────────────────────────────────

variable "s3_bucket_name" {
  type        = string
  description = "Globally unique S3 bucket name for narrative content. Defaults to '{name_prefix}ledger'."
  default     = ""
}

variable "noncurrent_version_expiration_days" {
  type        = number
  description = "Days after which noncurrent S3 object versions are expired."
  default     = 30
}

# ── Alerts ────────────────────────────────────────────────────────────────────

variable "alert_email" {
  type        = string
  description = "Email address for DLQ alarm notifications. Leave empty to skip SNS subscription."
  default     = ""
}

# ── Tags ──────────────────────────────────────────────────────────────────────

variable "tags" {
  type        = map(string)
  description = "Additional tags to apply to all resources."
  default     = {}
}
