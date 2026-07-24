###############################################################################
# Fleet ContextStore — DynamoDB single-table hive mind
#
# Created when var.context_store_backend = "dynamodb" (the default and only
# supported value today). The gating sets up the seam for future backends
# (e.g. RDS) without an interface break.
#
# External services can read/write this table directly (IAM permitting).
# TTL is enabled so stale context entries expire automatically.
###############################################################################

resource "aws_dynamodb_table" "context_store" {
  count = var.context_store_backend == "dynamodb" ? 1 : 0

  name         = "fleetmind-${var.fleet_name}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  # The ContextStore table holds the fleet's entire shared state. Accidental
  # destroy is catastrophic, so protect at both the AWS layer (deletion
  # protection) and add PITR for accidental data loss (writes, deletes).
  deletion_protection_enabled = true

  point_in_time_recovery {
    enabled = true
  }

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
