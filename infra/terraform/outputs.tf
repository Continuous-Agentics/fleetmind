# ── Per-agent instance outputs ────────────────────────────────────────────────

output "instance_ids" {
  description = "EC2 instance ID per agent."
  value       = { for k, v in aws_instance.agent : k => v.id }
}

output "public_ips" {
  description = "Public IP per agent instance."
  value       = { for k, v in aws_instance.agent : k => v.public_ip }
}

output "private_ips" {
  description = "Private IP per agent instance."
  value       = { for k, v in aws_instance.agent : k => v.private_ip }
}

output "ssm_connect" {
  description = "SSM Session Manager connect commands, one per agent."
  value       = { for k, v in aws_instance.agent : k => "aws ssm start-session --target ${v.id} --region ${var.aws_region}" }
}

output "workspace_volume_ids" {
  description = "EBS workspace volume ID per agent. Each holds that agent's memory — never delete."
  value       = { for k, v in aws_ebs_volume.agent_workspace : k => v.id }
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
