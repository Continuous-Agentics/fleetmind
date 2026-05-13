# ── Per-agent instance outputs ────────────────────────────────────────────────

output "instance_ids" {
  description = "EC2 instance ID per agent."
  value       = { for k, v in aws_instance.agent : k => v.id }
}

# public_ips output removed — agents are now in private subnets with
# associate_public_ip_address = false. Use private_ips or ssm_connect instead.

output "private_ips" {
  description = "Private IP per agent instance."
  value       = { for k, v in aws_instance.agent : k => v.private_ip }
}

output "ssm_connect" {
  description = "SSM Session Manager connect commands, one per agent."
  value       = { for k, v in aws_instance.agent : k => "aws ssm start-session --target ${v.id} --region ${var.aws_region}" }
}

output "agent_workspace_paths" {
  description = "Workspace directory path on each agent's instance."
  value       = { for name in var.agent_names : name => "/opt/openclaw/workspace/${name}" }
}

output "agent_service_names" {
  description = "systemd service name per agent."
  value       = { for name in var.agent_names : name => "openclaw-${name}" }
}

output "rds_endpoint" {
  description = "RDS Postgres endpoint (host:port). Empty string when enable_rds = false."
  value       = var.enable_rds ? aws_db_instance.main[0].endpoint : ""
}

output "secrets_arns" {
  description = "Secrets Manager ARNs — slack and anthropic keys per agent."
  value = merge(
    { for k, v in aws_secretsmanager_secret.agent_slack : "${k}_slack" => v.arn },
    { for k, v in aws_secretsmanager_secret.agent_anthropic : "${k}_anthropic" => v.arn }
  )
}

output "vpc_id" {
  description = "VPC ID (created or adopted)."
  value       = local.vpc_id
}

# ── Task-ledger outputs (populated when delegation_enabled = true) ─────────────

output "task_ledger_table_name" {
  description = "DynamoDB task-ledger table name. Used by 'fleetmind task ack/ship' and the bot-delegation/bot-reception skills. Empty string when delegation_enabled = false."
  value       = var.delegation_enabled ? module.task_ledger[0].table_name : ""
}

output "task_ledger_s3_bucket" {
  description = "S3 bucket name for task narrative content. Empty string when delegation_enabled = false."
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

output "agent_iam_role_names" {
  description = "IAM role name per agent. Useful for consumers that want to attach additional policies to per-agent roles after terraform apply (e.g. project-specific access grants)."
  value       = { for k, v in aws_iam_role.agent : k => v.name }
}
