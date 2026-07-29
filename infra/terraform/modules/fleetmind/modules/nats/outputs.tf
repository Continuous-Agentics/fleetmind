output "instance_id" {
  description = "EC2 instance ID of the NATS server."
  value       = aws_instance.nats.id
}

output "private_ip" {
  description = "Private IP of the NATS server instance."
  value       = aws_instance.nats.private_ip
}

output "nats_url" {
  description = "NATS connection URL for use by fleet agents (DNS-resolved via Cloud Map)."
  value       = "nats://${local.nats_dns_name}:4222"
}

output "cloud_map_service_id" {
  description = "Cloud Map service ID for the NATS service."
  value       = aws_service_discovery_service.nats.id
}

output "cloud_map_service_arn" {
  description = "Cloud Map service ARN."
  value       = aws_service_discovery_service.nats.arn
}

output "security_group_id" {
  description = "Security group ID of the NATS server."
  value       = aws_security_group.nats.id
}

output "iam_role_name" {
  description = "IAM role name of the NATS server instance."
  value       = aws_iam_role.nats.name
}
