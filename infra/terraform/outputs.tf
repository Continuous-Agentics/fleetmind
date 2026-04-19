output "agent_instance_ids" {
  description = "EC2 instance ID per agent."
  value       = { for k, v in aws_instance.agent : k => v.id }
}

output "agent_private_ips" {
  description = "Private IP per agent."
  value       = { for k, v in aws_instance.agent : k => v.private_ip }
}

output "agent_public_ips" {
  description = "Public IP per agent (for direct Slack Socket Mode egress)."
  value       = { for k, v in aws_instance.agent : k => v.public_ip }
}

output "ssm_connect_commands" {
  description = "SSM Session Manager connect commands per agent (no SSH needed)."
  value = {
    for k, v in aws_instance.agent :
    k => "aws ssm start-session --target ${v.id} --region ${var.aws_region}"
  }
}

output "workspace_volume_ids" {
  description = "EBS workspace volume IDs per agent. These persist agent memory."
  value       = { for k, v in aws_ebs_volume.workspace : k => v.id }
}

output "rds_endpoint" {
  description = "RDS Postgres endpoint (host:port)."
  value       = aws_db_instance.main.endpoint
}

output "rds_database_url_secret_arn" {
  description = "Secrets Manager ARN containing DATABASE_URL."
  value       = aws_secretsmanager_secret.anthropic.arn
}

output "agent_slack_secret_arns" {
  description = "Secrets Manager ARNs for per-agent Slack tokens."
  value       = { for k, v in aws_secretsmanager_secret.agent_slack : k => v.arn }
}

output "vpc_id" {
  value = aws_vpc.main.id
}
