output "vpc_id" {
  description = "VPC ID created for the example fleet."
  value       = module.fleetmind.vpc_id
}

output "instance_ids" {
  description = "EC2 instance IDs for the example agents."
  value       = module.fleetmind.instance_ids
}

output "ledger_bucket_name" {
  description = "Deploy-staging bucket name for the example fleet."
  value       = module.fleetmind.ledger_bucket_name
}
