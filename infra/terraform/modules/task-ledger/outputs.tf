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

output "table_stream_arn" {
  description = "ARN of the DynamoDB Streams stream on the tasks table. Used by the EventBridge Pipe."
  value       = aws_dynamodb_table.tasks.stream_arn
}

output "s3_bucket_name" {
  description = "S3 bucket name for narrative content."
  value       = aws_s3_bucket.ledger.id
}

output "s3_bucket_arn" {
  description = "S3 bucket ARN for narrative content."
  value       = aws_s3_bucket.ledger.arn
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

output "pipe_arn" {
  description = "ARN of the EventBridge Pipe routing DDB stream records to the event bus."
  value       = aws_pipes_pipe.ddb_to_eb.arn
}

output "eventbridge_rule_arn" {
  description = "ARN of the EventBridge rule matching terminal-status events from the Pipe."
  value       = aws_cloudwatch_event_rule.ddb_terminal.arn
}

output "alert_topic_arn" {
  description = "ARN of the SNS topic for DLQ alarm notifications."
  value       = aws_sns_topic.dlq_alerts.arn
}

output "wake_dlq_url" {
  description = "URL of the DLQ for failed EventBridge → SSM wake invocations."
  value       = aws_sqs_queue.dlq.id
}

output "pipe_dlq_url" {
  description = "URL of the DLQ for Pipe-level failures (stream errors, permission drift)."
  value       = aws_sqs_queue.pipe_dlq.id
}
