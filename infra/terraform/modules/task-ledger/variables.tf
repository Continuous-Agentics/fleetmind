# =============================================================================
# task-ledger module — variables
# =============================================================================

variable "name_prefix" {
  type        = string
  description = "Prefix applied to all resource names (e.g. 'fleetmind-' or 'acme-fleet-')."
  default     = "fleetmind-"
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

# ── S3 ────────────────────────────────────────────────────────────────────────

variable "s3_bucket_name" {
  type        = string
  description = "S3 bucket name for narrative content. Must be provided — the bucket is created at root level (s3.tf) so it exists regardless of delegation_enabled."
  # No default — callers must pass the root-level bucket name explicitly.
}

variable "s3_bucket_arn" {
  type        = string
  description = "S3 bucket ARN for narrative content. Passed in from the root module so the task-ledger submodule doesn't have to data-lookup a bucket that's created in the same apply."
  # No default — callers must pass the root-level bucket ARN explicitly.
}

# ── Tags ──────────────────────────────────────────────────────────────────────

variable "tags" {
  type        = map(string)
  description = "Additional tags to apply to all resources."
  default     = {}
}
