# =============================================================================
# task-ledger — FleetMind task ledger infrastructure
#
# What this module creates:
#   - DynamoDB table with GSIs, Streams, TTL, deletion protection
#   - S3 bucket (narrative content) with hardening (PAB, versioning, SSE, TLS)
#   - Three IAM managed policies: pm, worker, reader
#   - Policy attachments to provided PM and worker roles
#   - EventBridge Pipe (DDB Stream → event bus) with per-Pipe DLQ
#   - EventBridge rule (event bus → SSM Run Command) with wake DLQ + alarm
#   - SNS topic + email subscription for DLQ alerts
#
# What this module does NOT create:
#   - Bot EC2 instances or their IAM roles — provided as inputs (pm_role_names,
#     worker_role_names)
#   - Remote state backend — configure in your consuming root module
#
# Design doc: docs/protocol.md
# =============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  prefix     = var.name_prefix
  account_id = data.aws_caller_identity.current.account_id
  region     = var.aws_region

  table_name  = "${local.prefix}tasks"
  bucket_name = var.s3_bucket_name != "" ? var.s3_bucket_name : "${local.prefix}ledger"

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

  # ── DynamoDB Streams ─────────────────────────────────────────────────────────
  # Drives the EventBridge Pipe wake signal.
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

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

resource "aws_s3_bucket" "ledger" {
  bucket = local.bucket_name
  tags   = local.base_tags
}

resource "aws_s3_bucket_public_access_block" "ledger" {
  bucket                  = aws_s3_bucket.ledger.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "ledger" {
  bucket = aws_s3_bucket.ledger.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "ledger" {
  bucket = aws_s3_bucket.ledger.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ledger" {
  bucket = aws_s3_bucket.ledger.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "ledger" {
  bucket = aws_s3_bucket.ledger.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "ledger_bucket_policy" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.ledger.arn,
      "${aws_s3_bucket.ledger.arn}/*",
    ]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "ledger" {
  bucket = aws_s3_bucket.ledger.id
  policy = data.aws_iam_policy_document.ledger_bucket_policy.json
}

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
    resources = ["${aws_s3_bucket.ledger.arn}/v0/projects/*/README.md"]
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
    resources = ["${aws_s3_bucket.ledger.arn}/*"]
  }

  statement {
    sid       = "ListBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.ledger.arn]
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
# Worker bots: UpdateItem only (no PutItem), read DDB, write task narratives.

data "aws_iam_policy_document" "worker" {
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
    resources = ["${aws_s3_bucket.ledger.arn}/v0/projects/*/tasks/*.md"]
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
    resources = ["${aws_s3_bucket.ledger.arn}/*"]
  }

  statement {
    sid       = "ListBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.ledger.arn]
  }
}

resource "aws_iam_policy" "worker" {
  name        = "${local.prefix}bot-ledger-worker"
  description = "Worker bot: UpdateItem DDB task status, write narrative .md files to S3, read all."
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
    resources = ["${aws_s3_bucket.ledger.arn}/*"]
  }

  statement {
    sid       = "ListBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.ledger.arn]
  }
}

resource "aws_iam_policy" "reader" {
  name        = "${local.prefix}bot-ledger-reader"
  description = "Read-only access to the task ledger (DDB GetItem/Query + S3 GetObject/List). Attach as needed."
  policy      = data.aws_iam_policy_document.reader.json
  tags        = local.base_tags
}

# =============================================================================
# Wake signaling: DDB Streams → EventBridge Pipe → bus → SSM Run Command
# =============================================================================

# ── Pipe execution role ───────────────────────────────────────────────────────

data "aws_iam_policy_document" "pipe_assume" {
  statement {
    sid     = "AllowPipesAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["pipes.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "pipe_exec" {
  name               = "${local.prefix}ledger-pipe-exec"
  assume_role_policy = data.aws_iam_policy_document.pipe_assume.json
  tags               = local.base_tags
}

data "aws_iam_policy_document" "pipe_exec_policy" {
  statement {
    sid    = "ReadDDBStream"
    effect = "Allow"
    actions = [
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:DescribeStream",
      "dynamodb:ListStreams",
    ]
    resources = [aws_dynamodb_table.tasks.stream_arn]
  }

  statement {
    sid       = "PutEventsToDefaultBus"
    effect    = "Allow"
    actions   = ["events:PutEvents"]
    resources = ["arn:aws:events:${local.region}:${local.account_id}:event-bus/default"]
  }

  statement {
    sid       = "WriteToPipeDLQ"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.pipe_dlq.arn]
  }
}

resource "aws_iam_role_policy" "pipe_exec" {
  name   = "${local.prefix}ledger-pipe-exec"
  role   = aws_iam_role.pipe_exec.id
  policy = data.aws_iam_policy_document.pipe_exec_policy.json
}

# ── EventBridge → SSM role ────────────────────────────────────────────────────

data "aws_iam_policy_document" "eventbridge_assume" {
  statement {
    sid     = "AllowEventBridgeAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "eventbridge_ssm" {
  name               = "${local.prefix}ledger-eventbridge-ssm"
  assume_role_policy = data.aws_iam_policy_document.eventbridge_assume.json
  tags               = local.base_tags
}

data "aws_iam_policy_document" "eventbridge_ssm_policy" {
  statement {
    sid       = "AllowSendCommandOnDocument"
    effect    = "Allow"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ssm:${local.region}::document/AWS-RunShellScript"]
  }

  statement {
    sid       = "AllowSendCommandOnTargetInstances"
    effect    = "Allow"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/${var.wake_target_instance_tag_key}"
      values   = [var.wake_target_instance_tag_value]
    }
  }
}

resource "aws_iam_role_policy" "eventbridge_ssm" {
  name   = "${local.prefix}ledger-ssm-send-command"
  role   = aws_iam_role.eventbridge_ssm.id
  policy = data.aws_iam_policy_document.eventbridge_ssm_policy.json
}

# ── Pipe DLQ (source-side failures) ──────────────────────────────────────────

resource "aws_sqs_queue" "pipe_dlq" {
  name                       = "${local.prefix}ledger-pipe-dlq"
  message_retention_seconds  = 1209600 # 14 days
  visibility_timeout_seconds = 60
  tags                       = local.base_tags
}

resource "aws_cloudwatch_metric_alarm" "pipe_dlq_not_empty" {
  alarm_name        = "${local.prefix}ledger-pipe-dlq-not-empty"
  alarm_description = "Fires when the EventBridge Pipe DLQ has messages - indicates Pipe-level wake failures (stream errors, throttles, permission drift)."

  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1

  dimensions = {
    QueueName = aws_sqs_queue.pipe_dlq.name
  }

  alarm_actions = [aws_sns_topic.dlq_alerts.arn]
  ok_actions    = [aws_sns_topic.dlq_alerts.arn]

  tags = local.base_tags
}

# ── Wake DLQ (downstream SSM failures) ───────────────────────────────────────

resource "aws_sqs_queue" "dlq" {
  name                       = "${local.prefix}ledger-wake-dlq"
  message_retention_seconds  = 1209600 # 14 days
  visibility_timeout_seconds = 60
  tags                       = local.base_tags
}

data "aws_iam_policy_document" "dlq_policy" {
  statement {
    sid     = "AllowEventBridgeSend"
    effect  = "Allow"
    actions = ["sqs:SendMessage"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    resources = [aws_sqs_queue.dlq.arn]
  }
}

resource "aws_sqs_queue_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id
  policy    = data.aws_iam_policy_document.dlq_policy.json
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name        = "${local.prefix}ledger-wake-dlq-not-empty"
  alarm_description = "EventBridge → SSM wake invocation failed. Check DLQ: ${aws_sqs_queue.dlq.name}"

  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  alarm_actions = [aws_sns_topic.dlq_alerts.arn]
  ok_actions    = [aws_sns_topic.dlq_alerts.arn]

  tags = local.base_tags
}

# ── SNS alerts ────────────────────────────────────────────────────────────────

resource "aws_sns_topic" "dlq_alerts" {
  name = "${local.prefix}ledger-wake-alerts"
  tags = local.base_tags
}

resource "aws_sns_topic_subscription" "dlq_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.dlq_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ── EventBridge Pipe: DDB Stream → event bus ──────────────────────────────────

resource "aws_pipes_pipe" "ddb_to_eb" {
  name     = "${local.prefix}ledger-ddb-stream-to-eb"
  role_arn = aws_iam_role.pipe_exec.arn
  source   = aws_dynamodb_table.tasks.stream_arn

  source_parameters {
    dynamodb_stream_parameters {
      starting_position = "LATEST"
      batch_size        = 1

      dead_letter_config {
        arn = aws_sqs_queue.pipe_dlq.arn
      }

      # Cap retries to avoid wedging on a poison record.
      maximum_retry_attempts = 3
    }

    filter_criteria {
      filter {
        # Only pass MODIFY events that transition to a terminal status.
        # DDB stream records use typed value format: {"S": "value"}.
        pattern = jsonencode({
          eventName = ["MODIFY"]
          dynamodb = {
            NewImage = {
              status = {
                S = ["shipped", "blocked", "abandoned", "merged"]
              }
            }
          }
        })
      }
    }
  }

  target = "arn:aws:events:${local.region}:${local.account_id}:event-bus/default"

  target_parameters {
    eventbridge_event_bus_parameters {
      detail_type = "FleetMindTaskTerminalEvent"
      source      = "fleetmind.task.ledger"
    }

    # Extract PK (the stable primary key "TASK#<task_id>") instead of the
    # standalone task_id attribute so that future schema changes to standalone
    # attributes don't silently break wake delivery.
    input_template = "{\"pk\": \"<$.dynamodb.NewImage.PK.S>\"}"
  }

  tags = local.base_tags
}

# ── EventBridge rule: bus → SSM Run Command ───────────────────────────────────

resource "aws_cloudwatch_event_rule" "ddb_terminal" {
  name        = "${local.prefix}ledger-ddb-terminal-status"
  description = "Fires when fleetmind.task.ledger emits a FleetMindTaskTerminalEvent. Wakes the target OpenClaw instance via SSM."

  event_pattern = jsonencode({
    source        = ["fleetmind.task.ledger"]
    "detail-type" = ["FleetMindTaskTerminalEvent"]
  })

  tags = local.base_tags
}

# Gated on wake_target_session_key being non-empty. Operator can apply the
# initial fleet infrastructure first, create Slack apps + channels (needed to
# fill the channel_id in the session key), then re-apply with the real key to
# attach the SSM target. Without this gating, the input_transformer would embed
# an empty string and break the wake script at runtime.
resource "aws_cloudwatch_event_target" "ddb_terminal_ssm" {
  count    = var.wake_target_session_key != "" ? 1 : 0
  rule     = aws_cloudwatch_event_rule.ddb_terminal.name
  arn      = "arn:aws:ssm:${local.region}::document/AWS-RunShellScript"
  role_arn = aws_iam_role.eventbridge_ssm.arn

  run_command_targets {
    key    = "tag:${var.wake_target_instance_tag_key}"
    values = [var.wake_target_instance_tag_value]
  }

  # input_transformer extracts the PK from the Pipe event.
  # ddb-wake.sh strips the "TASK#" prefix and validates 8-char hex before
  # invoking the agent session. executionTimeout 15s gives headroom for
  # sessions.json lookup + setsid (the agent call itself is detached).
  input_transformer {
    input_paths = {
      pk = "$.detail.pk"
    }
    input_template = "{\"commands\":[\"/opt/openclaw/ddb-wake.sh '${var.wake_target_session_key}' '<pk>'\"],\"executionTimeout\":[\"15\"]}"
  }

  dead_letter_config {
    arn = aws_sqs_queue.dlq.arn
  }

  retry_policy {
    maximum_event_age_in_seconds = 300
    maximum_retry_attempts       = 2
  }
}
