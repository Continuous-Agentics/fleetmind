###############################################################################
# Fleet S3 bucket — always created, regardless of delegation_enabled.
#
# This bucket serves two purposes:
#   1. deploy-staging/  — used by `fleetmind push fleet` for all fleets
#   2. v0/projects/...  — narrative content (only written when delegation_enabled)
#
# Separating bucket creation from the task-ledger module means single-bot
# fleets (delegation_enabled = false) still have the bucket that push fleet
# requires, without provisioning the full delegation substrate.
###############################################################################

locals {
  ledger_bucket_name = "${var.fleet_name}-ledger"
}

resource "aws_s3_bucket" "ledger" {
  bucket = local.ledger_bucket_name
  tags   = { Name = local.ledger_bucket_name }
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
      noncurrent_days = 90
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
  bucket     = aws_s3_bucket.ledger.id
  policy     = data.aws_iam_policy_document.ledger_bucket_policy.json
  depends_on = [aws_s3_bucket_public_access_block.ledger]
}

data "aws_iam_policy_document" "deploy_staging_read" {
  statement {
    sid    = "ReadDeployStagingObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectTagging",
    ]
    resources = ["${aws_s3_bucket.ledger.arn}/deploy-staging/*"]
  }

  statement {
    sid    = "ListDeployStagingPrefix"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]
    resources = [aws_s3_bucket.ledger.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["deploy-staging/*"]
    }
  }
}

resource "aws_iam_policy" "deploy_staging_read" {
  name        = "${var.fleet_name}-deploy-staging-read"
  description = "Allow FleetMind agents to pull rendered workspaces from deploy-staging."
  policy      = data.aws_iam_policy_document.deploy_staging_read.json

  tags = {
    Project   = var.fleet_name
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "deploy_staging_read" {
  for_each = toset(var.agent_names)

  role       = module.agent[each.key].iam_role_name
  policy_arn = aws_iam_policy.deploy_staging_read.arn
}
