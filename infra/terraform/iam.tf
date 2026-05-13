# ── Per-agent IAM roles ───────────────────────────────────────────────────────
# Each agent EC2 instance gets a dedicated IAM role + instance profile.
# This follows the principle of least privilege and mirrors the pattern in
# devops-openclaw-agents-poc/terraform/instances-poc/iam.tf.
#
# Per-agent grants:
#   - SSM Session Manager (shell access without opening SSH)
#   - CloudWatch Logs write
#   - Secrets Manager read (scoped to this fleet's namespace only)
#   - DynamoDB read/write (scoped to the fleet's ContextStore table)

data "aws_iam_policy_document" "agent_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "agent" {
  for_each = toset(var.agent_names)

  name               = "${var.fleet_name}-${each.key}-role"
  assume_role_policy = data.aws_iam_policy_document.agent_assume_role.json

  tags = {
    "fleetmind:agent_id"   = each.key
    "fleetmind:fleet_name" = var.fleet_name
  }
}

resource "aws_iam_role_policy_attachment" "agent_ssm" {
  for_each = aws_iam_role.agent

  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "agent_cloudwatch" {
  for_each = aws_iam_role.agent

  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy" "agent_secrets" {
  for_each = aws_iam_role.agent

  name = "${var.fleet_name}-${each.key}-secrets-read"
  role = each.value.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SecretsRead"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        # Each agent can only read its own secret + the shared secrets.
        Resource = [
          "arn:aws:secretsmanager:${var.aws_region}:*:secret:${var.fleet_name}/agents/${each.key}/*",
          "arn:aws:secretsmanager:${var.aws_region}:*:secret:${var.fleet_name}/shared/*",
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "agent_dynamodb" {
  for_each = aws_iam_role.agent

  name = "${var.fleet_name}-${each.key}-dynamodb"
  role = each.value.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBContextStore"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:Scan",
          "dynamodb:Query",
        ]
        Resource = aws_dynamodb_table.context_store.arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "agent_github_app" {
  for_each = aws_iam_role.agent

  name = "${var.fleet_name}-${each.key}-github-app"
  role = each.value.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "GitHubAppSSMRead"
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:*:parameter/fleetmind/${var.fleet_name}/agents/${each.key}/github-app/*",
        ]
      },
      {
        Sid      = "GitHubAppKMSDecrypt"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = ["arn:aws:kms:${var.aws_region}:*:key/aws/ssm"]
      },
    ]
  })
}

# ── GitHub Packages auth: shared PAT in SSM ──────────────────────────────────
# All agents read the same SecureString param. Single point of revocation.
# The path does NOT include ${each.key} — this is intentional (shared token).
resource "aws_iam_role_policy" "agent_github_packages" {
  for_each = aws_iam_role.agent

  name = "${var.fleet_name}-${each.key}-github-packages"
  role = each.value.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "GitHubPackagesSSMRead"
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:*:parameter/fleetmind/shared/github-packages-token",
        ]
      },
      {
        Sid      = "GitHubPackagesKMSDecrypt"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = ["arn:aws:kms:${var.aws_region}:*:key/aws/ssm"]
      },
    ]
  })
}

resource "aws_iam_instance_profile" "agent" {
  for_each = aws_iam_role.agent

  name = "${var.fleet_name}-${each.key}-profile"
  role = each.value.name
}
