# ── Fleet instance IAM role ───────────────────────────────────────────────────
# Grants the fleet EC2 instance:
#   - SSM Session Manager (shell access without SSH)
#   - Secrets Manager read (scoped to this fleet's secrets)
#   - CloudWatch Logs write

resource "aws_iam_role" "fleet" {
  name = "${var.fleet_name}-fleet-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
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
  name = "${var.fleet_name}-secrets-read"
  role = aws_iam_role.fleet.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ]
      Resource = "arn:aws:secretsmanager:${var.aws_region}:*:secret:${var.fleet_name}/*"
    }]
  })
}

resource "aws_iam_role_policy" "dynamodb" {
  name = "${var.fleet_name}-dynamodb"
  role = aws_iam_role.fleet.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:Scan",
        "dynamodb:Query",
      ]
      Resource = aws_dynamodb_table.context_store.arn
    }]
  })
}

resource "aws_iam_instance_profile" "fleet" {
  name = "${var.fleet_name}-fleet-profile"
  role = aws_iam_role.fleet.name
}
