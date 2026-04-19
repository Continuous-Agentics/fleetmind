output "instance_id" {
  description = "EC2 instance ID for the fleet."
  value       = aws_instance.fleet.id
}

output "public_ip" {
  description = "Public IP of the fleet instance."
  value       = aws_instance.fleet.public_ip
}

output "private_ip" {
  description = "Private IP of the fleet instance."
  value       = aws_instance.fleet.private_ip
}

output "ssm_connect" {
  description = "SSM Session Manager connect command (no SSH needed)."
  value       = "aws ssm start-session --target ${aws_instance.fleet.id} --region ${var.aws_region}"
}

output "workspace_volume_id" {
  description = "EBS workspace volume ID. Holds all agent memory — never delete."
  value       = aws_ebs_volume.workspace.id
}

output "agent_workspace_paths" {
  description = "Workspace directory path per agent on the instance."
  value       = { for name in var.agent_names : name => "/opt/openclaw/workspace/${name}" }
}

output "agent_service_names" {
  description = "systemd service name per agent."
  value       = { for name in var.agent_names : name => "openclaw-${name}" }
}

output "rds_endpoint" {
  description = "RDS Postgres endpoint (host:port)."
  value       = aws_db_instance.main.endpoint
}

output "secrets_arns" {
  description = "Secrets Manager ARNs."
  value = merge(
    { for k, v in aws_secretsmanager_secret.agent_slack : "agent_${k}" => v.arn },
    { shared_anthropic = aws_secretsmanager_secret.anthropic.arn }
  )
}

output "vpc_id" {
  value = aws_vpc.main.id
}
