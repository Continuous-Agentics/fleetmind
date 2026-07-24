# =============================================================================
# task-ledger — FleetMind task ledger infrastructure
#
# What this module creates:
#   - DynamoDB table with GSIs, TTL, deletion protection
#   - S3 bucket (narrative content) with hardening (PAB, versioning, SSE, TLS)
#   - Three IAM managed policies: pm, worker, reader
#   - Policy attachments to provided PM and worker roles
#
# Wake signaling (EventBridge Pipe → SSM Run Command) has been removed.
# NATS transport handles terminal task events via direct subscriber push.
#
# What this module does NOT create:
#   - Bot EC2 instances or their IAM roles — provided as inputs (pm_role_names,
#     worker_role_names)
#   - Remote state backend — configure in your consuming root module
#
# Design doc: docs/protocol.md
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  prefix = var.name_prefix

  table_name = "${local.prefix}tasks"

  base_tags = merge(var.tags, {
    managed-by = "terraform"
    module     = "task-ledger"
  })
}

# =============================================================================
# DynamoDB table
# =============================================================================

resource "aws_dynamodb_table" "tasks" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"

  # ── Primary key ─────────────────────────────────────────────────────────────
  attribute {
    name = "PK"
    type = "S"
  }

  # ── GSI key attributes ───────────────────────────────────────────────────────
  # GSI1PK: "PROJECT#<slug>#STATUS#<status>"
  attribute {
    name = "GSI1PK"
    type = "S"
  }

  # GSI2PK: "STATUS#<status>"
  attribute {
    name = "GSI2PK"
    type = "S"
  }

  # Shared GSI range key — ISO 8601 delegation timestamp
  attribute {
    name = "delegated_at"
    type = "S"
  }

  # ── GSI1: ProjectStatusIndex ─────────────────────────────────────────────────
  # Use: PM heartbeat — "all pending tasks for project X, oldest first"
  global_secondary_index {
    name            = "ProjectStatusIndex"
    hash_key        = "GSI1PK"
    range_key       = "delegated_at"
    projection_type = "ALL"
  }

  # ── GSI2: StatusIndex ────────────────────────────────────────────────────────
  # Use: cross-project status query
  # Hot-partition note: STATUS#merged accumulates all merged tasks. Shard the
  # key (STATUS#merged#<bucket>) if >10k items causes throughput issues.
  global_secondary_index {
    name            = "StatusIndex"
    hash_key        = "GSI2PK"
    range_key       = "delegated_at"
    projection_type = "ALL"
  }

  # ── TTL ──────────────────────────────────────────────────────────────────────
  # expires_at = delegated_at + 365 days (epoch seconds). Set by application.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  # ── Encryption ───────────────────────────────────────────────────────────────
  server_side_encryption {
    enabled = true
  }

  # ── Deletion guards ──────────────────────────────────────────────────────────
  # Two layers: DDB-native API rejection + Terraform plan rejection.
  # Disabling either requires an explicit code change (git audit trail).
  deletion_protection_enabled = true

  lifecycle {
    prevent_destroy = true
  }

  tags = local.base_tags
}

# =============================================================================
# S3 bucket — narrative content
# =============================================================================
#
# The ledger bucket is created at the root module level (s3.tf) and passed in
# via var.s3_bucket_name + var.s3_bucket_arn. Previously this module did a
# 'data "aws_s3_bucket" "ledger"' lookup, but that resolves at plan/refresh
# time — racing the resource create in the same apply on first bring-up.
# Taking the ARN as a variable lets Terraform infer the dependency through
# the root-module attribute reference and avoids the chicken-and-egg.

# =============================================================================
# IAM policies
# =============================================================================

# ── Iterate provided role names directly ──────────────────────────────────────
# We avoid `data "aws_iam_role"` lookups because the roles are typically created
# in the same Terraform apply as this module (root module → agent IAM roles →
# task-ledger module). Data sources resolve at plan time, before the agent
# roles exist, which would cause a chicken-and-egg failure. The role NAMES are
# all we need for `aws_iam_role_policy_attachment.role`.

# ── bot-ledger-pm ─────────────────────────────────────────────────────────────
# PM bots: create tasks (PutItem), manage lifecycle (UpdateItem), query DDB,
# write README.md to S3, read all.

data "aws_iam_policy_document" "pm" {
  statement {
    sid       = "DDBCreateTask"
    effect    = "Allow"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.tasks.arn]
  }

  statement {
    sid       = "DDBUpdateTask"
    effect    = "Allow"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.tasks.arn]
  }

  statement {
    sid     = "DDBReadAndQuery"
    effect  = "Allow"
    actions = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [
      aws_dynamodb_table.tasks.arn,
      "${aws_dynamodb_table.tasks.arn}/index/ProjectStatusIndex",
      "${aws_dynamodb_table.tasks.arn}/index/StatusIndex",
    ]
  }

  statement {
    sid       = "WriteProjectReadme"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:PutObjectTagging"]
    resources = ["${var.s3_bucket_arn}/v0/projects/*/README.md"]
  }

  statement {
    # Read access across the whole ledger bucket. The bucket is the
    # canonical artifact store for this fleet: v0/ holds task-ledger
    # narratives, deploy-staging/ holds rendered workspaces pulled by
    # agents on boot, and additional prefixes may be added. Versioning
    # is per-prefix at the schema level, not enforced via IAM.
    sid       = "ReadAll"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectTagging"]
    resources = ["${var.s3_bucket_arn}/*"]
  }

  statement {
    sid       = "ListBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [var.s3_bucket_arn]
  }
}

resource "aws_iam_policy" "pm" {
  name        = "${local.prefix}bot-ledger-pm"
  description = "PM bot: create DDB task records, manage lifecycle transitions, query, write project README.md, read all."
  policy      = data.aws_iam_policy_document.pm.json
  tags        = local.base_tags
}

resource "aws_iam_role_policy_attachment" "pm" {
  for_each   = toset(var.pm_role_names)
  role       = each.value
  policy_arn = aws_iam_policy.pm.arn
}

# ── bot-ledger-worker ─────────────────────────────────────────────────────────
# Worker bots: PutItem (self-start rows, CON-91) + UpdateItem (lifecycle
# transitions), read DDB, write task narratives.
#
# PutItem is intentionally granted to support the Worker Self-Start Protocol
# (CON-91): workers may create their own DDB rows when acting on a Linear-
# assigned issue without a PM delegation envelope. Protocol-layer checks (not
# IAM) control when this is appropriate.
# See https://linear.app/continuous-agentics/issue/CON-91

data "aws_iam_policy_document" "worker" {
  statement {
    # CON-91: workers may self-create task rows (Worker Self-Start Protocol).
    # Scoped to the tasks table only — not Resource "*" and not indexes
    # (PutItem is a table-level operation; GSI projections are populated
    # automatically by DynamoDB from the base table write).
    sid       = "DDBCreateTask"
    effect    = "Allow"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.tasks.arn]
  }

  statement {
    sid       = "DDBUpdateTask"
    effect    = "Allow"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.tasks.arn]
  }

  statement {
    sid     = "DDBReadAndQuery"
    effect  = "Allow"
    actions = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [
      aws_dynamodb_table.tasks.arn,
      "${aws_dynamodb_table.tasks.arn}/index/ProjectStatusIndex",
      "${aws_dynamodb_table.tasks.arn}/index/StatusIndex",
    ]
  }

  statement {
    sid       = "WriteTasks"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:PutObjectTagging"]
    resources = ["${var.s3_bucket_arn}/v0/projects/*/tasks/*.md"]
  }

  statement {
    # Read access across the whole ledger bucket. The bucket is the
    # canonical artifact store for this fleet: v0/ holds task-ledger
    # narratives, deploy-staging/ holds rendered workspaces pulled by
    # agents on boot, and additional prefixes may be added. Versioning
    # is per-prefix at the schema level, not enforced via IAM.
    sid       = "ReadAll"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectTagging"]
    resources = ["${var.s3_bucket_arn}/*"]
  }

  statement {
    sid       = "ListBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [var.s3_bucket_arn]
  }
}

resource "aws_iam_policy" "worker" {
  name        = "${local.prefix}bot-ledger-worker"
  description = "Worker bot: PutItem/UpdateItem DDB task rows (CON-91 self-start + lifecycle), write narrative .md files to S3, read all."
  policy      = data.aws_iam_policy_document.worker.json
  tags        = local.base_tags
}

resource "aws_iam_role_policy_attachment" "worker" {
  for_each   = toset(var.worker_role_names)
  role       = each.value
  policy_arn = aws_iam_policy.worker.arn
}

# ── bot-ledger-reader ─────────────────────────────────────────────────────────
# Read-only: DDB GetItem/Query + S3 GetObject/List. Not attached here.

data "aws_iam_policy_document" "reader" {
  statement {
    sid     = "DDBRead"
    effect  = "Allow"
    actions = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [
      aws_dynamodb_table.tasks.arn,
      "${aws_dynamodb_table.tasks.arn}/index/ProjectStatusIndex",
      "${aws_dynamodb_table.tasks.arn}/index/StatusIndex",
    ]
  }

  statement {
    # Read access across the whole ledger bucket. The bucket is the
    # canonical artifact store for this fleet: v0/ holds task-ledger
    # narratives, deploy-staging/ holds rendered workspaces pulled by
    # agents on boot, and additional prefixes may be added. Versioning
    # is per-prefix at the schema level, not enforced via IAM.
    sid       = "ReadAll"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectTagging"]
    resources = ["${var.s3_bucket_arn}/*"]
  }

  statement {
    sid       = "ListBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [var.s3_bucket_arn]
  }
}

resource "aws_iam_policy" "reader" {
  name        = "${local.prefix}bot-ledger-reader"
  description = "Read-only access to the task ledger (DDB GetItem/Query + S3 GetObject/List). Attach as needed."
  policy      = data.aws_iam_policy_document.reader.json
  tags        = local.base_tags
}

