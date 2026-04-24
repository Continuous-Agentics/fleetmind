###############################################################################
# FleetMind ContextStore — DynamoDB single-table hive mind
#
# External services can read/write this table directly (IAM permitting).
# TTL is enabled so stale context entries expire automatically.
###############################################################################

resource "aws_dynamodb_table" "context_store" {
  name         = "fleetmind-${var.fleet_name}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = {
    fleet_name = var.fleet_name
    managed_by = "fleetmind"
  }
}

output "context_store_table_name" {
  description = "DynamoDB table name for the fleet ContextStore"
  value       = aws_dynamodb_table.context_store.name
}

output "context_store_table_arn" {
  description = "DynamoDB table ARN (for IAM policies in external services)"
  value       = aws_dynamodb_table.context_store.arn
}
