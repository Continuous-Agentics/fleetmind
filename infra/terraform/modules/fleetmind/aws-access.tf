# Independent attachments: application access must not change user_data,
# rollout triggers, instance profiles, placement, or existing host permissions.
variable "agent_aws_access_roles" {
  description = "Exact application role ARNs each agent may assume. Target roles independently enforce resource permissions."
  type        = map(set(string))
  default     = {}

  validation {
    condition = alltrue(flatten([
      for roles in values(var.agent_aws_access_roles) : [
        for arn in roles : can(regex("^arn:aws:iam::[0-9]{12}:role/([A-Za-z0-9+=,.@_-]+/)*[A-Za-z0-9+=,.@_-]{1,64}$", arn))
      ]
    ]))
    error_message = "AWS application access requires exact commercial AWS IAM role ARNs; wildcards are forbidden."
  }
}

resource "aws_iam_role_policy" "application_access" {
  for_each = { for agent, roles in var.agent_aws_access_roles : agent => roles if length(roles) > 0 }
  name     = "fleetmind-application-access"
  role     = module.agent[each.key].iam_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = sort(tolist(each.value))
    }]
  })
}
