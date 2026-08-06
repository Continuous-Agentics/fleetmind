###############################################################################
# Re-export module outputs so operators (and operator-side CI) can read them
# via `terraform output`. Identical surface to FleetMind embedded Terraform module's
# outputs.
###############################################################################

output "instance_ids" {
  description = "EC2 instance ID per agent."
  value       = module.fleetmind.instance_ids
}

output "private_ips" {
  description = "Private IP per agent."
  value       = module.fleetmind.private_ips
}

output "ssm_connect" {
  description = "SSM Session Manager connect commands, one per agent."
  value       = module.fleetmind.ssm_connect
}

output "agent_workspace_paths" {
  description = "Workspace directory path on each agent's instance."
  value       = module.fleetmind.agent_workspace_paths
}

output "agent_service_names" {
  description = "systemd service name per agent."
  value       = module.fleetmind.agent_service_names
}

output "agent_iam_role_names" {
  description = "IAM role name per agent (for attaching additional policies post-apply)."
  value       = module.fleetmind.agent_iam_role_names
}

output "secrets_arns" {
  description = "Secrets Manager ARNs — Slack + Anthropic per agent."
  value       = module.fleetmind.secrets_arns
}

output "agent_provider_secret_arns" {
  description = "Map of agent IDs to provider-secret ARNs."
  value       = module.fleetmind.agent_provider_secret_arns
}

output "agent_provider_secret_names" {
  description = "Map of agent IDs to provider-secret names."
  value       = module.fleetmind.agent_provider_secret_names
}

output "vpc_id" {
  description = "VPC ID (created or adopted)."
  value       = module.fleetmind.vpc_id
}

output "context_store_backend" {
  description = "Active ContextStore backend."
  value       = module.fleetmind.context_store_backend
}

output "context_store_table_arn" {
  description = "DynamoDB ContextStore table ARN."
  value       = module.fleetmind.context_store_table_arn
}

output "context_store_table_name" {
  description = "DynamoDB ContextStore table name."
  value       = module.fleetmind.context_store_table_name
}

output "task_ledger_table_name" {
  description = "DynamoDB task-ledger table name (empty when delegation_enabled = false)."
  value       = module.fleetmind.task_ledger_table_name
}

output "task_ledger_s3_bucket" {
  description = "S3 bucket name for task narratives (empty when delegation_enabled = false)."
  value       = module.fleetmind.task_ledger_s3_bucket
}

output "ledger_bucket_name" {
  description = "S3 bucket name used for deploy staging and task narratives."
  value       = module.fleetmind.ledger_bucket_name
}

output "task_ledger_pm_policy_arn" {
  description = "PM task-ledger policy ARN."
  value       = module.fleetmind.task_ledger_pm_policy_arn
}

output "task_ledger_worker_policy_arn" {
  description = "Worker task-ledger policy ARN."
  value       = module.fleetmind.task_ledger_worker_policy_arn
}

output "nats_enabled" {
  description = "Whether NATS transport is provisioned."
  value       = module.fleetmind.nats_enabled
}

output "nats_url" {
  description = "NATS connection URL."
  value       = module.fleetmind.nats_url
}

output "nats_instance_id" {
  description = "NATS instance ID."
  value       = module.fleetmind.nats_instance_id
}

output "cloud_map_namespace_name" {
  description = "Cloud Map private DNS namespace name."
  value       = module.fleetmind.cloud_map_namespace_name
}
