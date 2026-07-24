# =============================================================================
# task-ledger module — outputs
# =============================================================================

output "table_name" {
  description = "Name of the DynamoDB tasks table."
  value       = aws_dynamodb_table.tasks.id
}

output "table_arn" {
  description = "ARN of the DynamoDB tasks table."
  value       = aws_dynamodb_table.tasks.arn
}


output "s3_bucket_name" {
  description = "S3 bucket name for narrative content."
  value       = var.s3_bucket_name
}

output "s3_bucket_arn" {
  description = "S3 bucket ARN for narrative content."
  value       = var.s3_bucket_arn
}

output "pm_policy_arn" {
  description = "ARN of the bot-ledger-pm policy (PM bot: create/update DDB tasks, write README.md, read all)."
  value       = aws_iam_policy.pm.arn
}

output "worker_policy_arn" {
  description = "ARN of the bot-ledger-worker policy (worker bot: UpdateItem DDB, write task .md files, read all)."
  value       = aws_iam_policy.worker.arn
}

output "reader_policy_arn" {
  description = "ARN of the bot-ledger-reader policy. Not attached by this module — attach to humans / read-only skills as needed."
  value       = aws_iam_policy.reader.arn
}
