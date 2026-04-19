# ── Instance role ─────────────────────────────────────────────────────────────
# Grants agents:
#   - SSM Session Manager access (no SSH bastion needed)
#   - Secrets Manager read (fetch Slack tokens + ANTHROPIC_KEY at runtime)
#   - CloudWatch Logs write (container logs)

resource "aws_iam_role" "agent" {
  name = "${var.fleet_name}-agent-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# SSM Session Manager — connect without SSH or bastion
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.agent.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# CloudWatch agent
resource "aws_iam_role_policy_attachment" "cloudwatch" {
  role       = aws_iam_role.agent.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# Secrets Manager — read only, scoped to this fleet's secrets
resource "aws_iam_role_policy" "secrets" {
  name = "${var.fleet_name}-secrets-read"
  role = aws_iam_role.agent.id

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

resource "aws_iam_instance_profile" "agent" {
  name = "${var.fleet_name}-agent-profile"
  role = aws_iam_role.agent.name
}
