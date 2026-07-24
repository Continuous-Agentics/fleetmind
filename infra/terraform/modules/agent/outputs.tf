output "instance_id" {
  description = "EC2 instance ID."
  value       = aws_instance.agent.id
}

output "private_ip" {
  description = "Private IP of the instance."
  value       = aws_instance.agent.private_ip
}

output "iam_role_name" {
  description = "IAM role name. Useful for the caller to attach additional cross-cutting policies (e.g. task-ledger PM/worker grants)."
  value       = aws_iam_role.agent.name
}

output "iam_role_arn" {
  description = "IAM role ARN."
  value       = aws_iam_role.agent.arn
}

output "slack_secret_arn" {
  description = "Secrets Manager ARN for this agent's Slack tokens."
  value       = aws_secretsmanager_secret.slack.arn
}

output "provider_secret_arns" {
  description = "Map of provider id → Secrets Manager ARN (per agent)."
  value       = { for k, s in aws_secretsmanager_secret.provider_key : k => s.arn }
}

output "provider_secret_names" {
  description = "Map of provider id → secret name (per agent)."
  value       = local.provider_secret_names
}

output "workspace_path" {
  description = "Workspace directory path on the instance."
  value       = "/opt/openclaw/workspace/${var.name}"
}

output "service_name" {
  description = "systemd service name on the instance."
  value       = "openclaw-${var.name}"
}
