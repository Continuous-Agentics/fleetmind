# ── Fleet instance IAM role ───────────────────────────────────────────────────
# Grants the fleet EC2 instance:
#   - SSM Session Manager (shell access without SSH)
#   - Secrets Manager read (scoped to this fleet's secrets)
#   - CloudWatch Logs write
#   - DynamoDB read/write (scoped to the fleet's ContextStore table)

data "aws_iam_policy_document" "fleet_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "secrets_read" {
  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = ["arn:aws:secretsmanager:${var.aws_region}:*:secret:${var.fleet_name}/*"]
  }
}

data "aws_iam_policy_document" "dynamodb_context" {
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:Scan",
      "dynamodb:Query",
    ]
    resources = [aws_dynamodb_table.context_store.arn]
  }
}

resource "aws_iam_role" "fleet" {
  name               = "${var.fleet_name}-fleet-role"
  assume_role_policy = data.aws_iam_policy_document.fleet_assume_role.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.fleet.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "cloudwatch" {
  role       = aws_iam_role.fleet.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy" "secrets" {
  name   = "${var.fleet_name}-secrets-read"
  role   = aws_iam_role.fleet.id
  policy = data.aws_iam_policy_document.secrets_read.json
}

resource "aws_iam_role_policy" "dynamodb" {
  name   = "${var.fleet_name}-dynamodb"
  role   = aws_iam_role.fleet.id
  policy = data.aws_iam_policy_document.dynamodb_context.json
}

resource "aws_iam_instance_profile" "fleet" {
  name = "${var.fleet_name}-fleet-profile"
  role = aws_iam_role.fleet.name
}
