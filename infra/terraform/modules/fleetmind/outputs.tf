# ── Per-agent outputs (sourced from module.agent[*]) ─────────────────────────

output "instance_ids" {
  description = "EC2 instance ID per agent."
  value       = { for k, m in module.agent : k => m.instance_id }
}

output "private_ips" {
  description = "Private IP per agent."
  value       = { for k, m in module.agent : k => m.private_ip }
}

output "ssm_connect" {
  description = "SSM Session Manager connect commands, one per agent."
  value       = { for k, m in module.agent : k => "aws ssm start-session --target ${m.instance_id} --region ${var.aws_region}" }
}

output "agent_workspace_paths" {
  description = "Workspace directory path on each agent's instance."
  value       = { for k, m in module.agent : k => m.workspace_path }
}

output "agent_service_names" {
  description = "systemd service name per agent."
  value       = { for k, m in module.agent : k => m.service_name }
}

output "agent_iam_role_names" {
  description = "IAM role name per agent. Useful for consumers that want to attach additional policies to per-agent roles after terraform apply (e.g. project-specific access grants)."
  value       = { for k, m in module.agent : k => m.iam_role_name }
}

output "secrets_arns" {
  description = "Secrets Manager ARNs — slack secret + per-provider model secrets per agent. Keys are <agent>_slack and <agent>_provider_<provider>."
  value = merge(
    { for k, m in module.agent : "${k}_slack" => m.slack_secret_arn },
    merge([
      for k, m in module.agent : {
        for prov, arn in m.provider_secret_arns : "${k}_provider_${prov}" => arn
      }
    ]...),
  )
}

output "agent_provider_secret_arns" {
  description = "Map of agent_id → (map of provider id → Secrets Manager ARN)."
  value       = { for k, m in module.agent : k => m.provider_secret_arns }
}

output "agent_provider_secret_names" {
  description = "Map of agent_id → (map of provider id → Secrets Manager secret name)."
  value       = { for k, m in module.agent : k => m.provider_secret_names }
}

# ── Shared fleet infrastructure outputs ──────────────────────────────────────

output "vpc_id" {
  description = "VPC ID — either the VPC this module created via terraform-aws-modules/vpc/aws (when var.vpc_id is empty) or the BYO VPC adopted from var.vpc_id."
  value       = local.vpc_id
}

output "context_store_backend" {
  description = "Active ContextStore backend (echoes var.context_store_backend). Useful for consumers that branch agent-side configuration on backend type."
  value       = var.context_store_backend
}

output "context_store_table_name" {
  description = "DynamoDB table name for the fleet ContextStore. Empty string when context_store_backend != \"dynamodb\"."
  value       = coalesce(one(aws_dynamodb_table.context_store[*].name), "")
}

output "context_store_table_arn" {
  description = "DynamoDB table ARN for the fleet ContextStore. Empty string when context_store_backend != \"dynamodb\"."
  value       = coalesce(one(aws_dynamodb_table.context_store[*].arn), "")
}

# ── Task-ledger outputs (populated when delegation_enabled = true) ───────────

output "task_ledger_table_name" {
  description = "DynamoDB task-ledger table name. Used by 'fleetmind task ack/ship' and the bot-delegation/bot-reception skills. Empty string when delegation_enabled = false."
  value       = var.delegation_enabled ? module.task_ledger[0].table_name : ""
}

output "ledger_bucket_name" {
  description = "S3 bucket name used for deploy staging and (when delegation_enabled) task narrative content."
  value       = aws_s3_bucket.ledger.bucket
}

output "task_ledger_s3_bucket" {
  description = "S3 bucket name for task narrative content (same as ledger_bucket_name). Empty string when delegation_enabled = false."
  value       = var.delegation_enabled ? module.task_ledger[0].s3_bucket_name : ""
}

output "task_ledger_pm_policy_arn" {
  description = "ARN of the bot-ledger-pm IAM policy. Empty string when delegation_enabled = false."
  value       = var.delegation_enabled ? module.task_ledger[0].pm_policy_arn : ""
}

output "task_ledger_worker_policy_arn" {
  description = "ARN of the bot-ledger-worker IAM policy. Empty string when delegation_enabled = false."
  value       = var.delegation_enabled ? module.task_ledger[0].worker_policy_arn : ""
}

# ── NATS transport outputs (populated when nats_enabled = true) ───────────────

output "nats_enabled" {
  description = "Whether the NATS transport is provisioned."
  value       = var.nats_enabled
}

output "nats_url" {
  description = "NATS connection URL for fleet agents (Cloud Map DNS). Empty string when nats_enabled = false."
  value       = var.nats_enabled ? module.nats[0].nats_url : ""
}

output "nats_instance_id" {
  description = "EC2 instance ID of the NATS server. Empty string when nats_enabled = false."
  value       = var.nats_enabled ? module.nats[0].instance_id : ""
}

output "cloud_map_namespace_name" {
  description = "Cloud Map private DNS namespace name (e.g. 'fleetmind.internal'). Empty string when nats_enabled = false."
  value       = var.nats_enabled ? aws_service_discovery_private_dns_namespace.fleet[0].name : ""
}
