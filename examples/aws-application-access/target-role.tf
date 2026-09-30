# Apply only as an authorized administrator IN THE APPLICATION ACCOUNT.
# Configure the target-account AWS provider and independent state in your own root.
variable "source_agent_role_arn" {
  type = string
  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", var.source_agent_role_arn))
    error_message = "Use the exact source agent workload role ARN, not account root or a wildcard."
  }
}
variable "application_bucket_arn" {
  type = string
  validation {
    condition     = can(regex("^arn:aws:s3:::[a-z0-9][a-z0-9.-]+$", var.application_bucket_arn))
    error_message = "Use a single application bucket ARN."
  }
}
resource "aws_iam_role" "app_read" {
  name                 = "fleetmind-orders-staging-read"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = var.source_agent_role_arn }
      Action    = "sts:AssumeRole"
    }]
  })
}
# These permissions, NOT the alias or a client-provided session policy, define scope.
# No IAM administration, role chaining, or application-account-wide wildcard grants.
resource "aws_iam_role_policy" "app_read" {
  role = aws_iam_role.app_read.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = var.application_bucket_arn },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${var.application_bucket_arn}/orders/*" }
    ]
  })
}
output "role_arn" { value = aws_iam_role.app_read.arn }
