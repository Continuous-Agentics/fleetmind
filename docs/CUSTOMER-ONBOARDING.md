# Customer AWS Onboarding

This is the customer-facing AWS access handoff for a first FleetMind deployment.

Preferred path: create a cross-account IAM role that Continuous Agentics can assume with an external ID. Access keys are supported only when the customer cannot create a role.

## What We Need Access To

FleetMind provisions and operates a small AWS-hosted agent fleet:

- EC2 instances, security groups, and instance profiles for each agent
- VPC/subnet resources when the customer does not bring an existing VPC
- SSM Session Manager access for shell-less operations
- Secrets Manager entries for Slack, LLM provider, gateway, and hook secrets
- S3 buckets for Terraform state and fleet artifacts
- DynamoDB tables for Terraform locks, ContextStore, and optional task ledger
- CloudWatch Logs for agent and bootstrap diagnostics
- Cloud Map / Route 53 private DNS for NATS service discovery when delegation is enabled

We do not need access to customer application databases, production application secrets, billing settings, identity provider configuration, or unrelated AWS accounts.

## Option A — Cross-Account Role (Preferred)

Ask the customer to create an IAM role in their AWS account.

### 1. Create an External ID

Continuous Agentics provides a unique external ID for the engagement, for example:

```text
ca-fleetmind-<customer>-<random>
```

Use this exact value in the trust policy below.

### 2. Create the Role

In the AWS Console:

1. Open `IAM`.
2. Choose `Roles`.
3. Choose `Create role`.
4. Select `Custom trust policy`.
5. Paste this trust policy, replacing `<CONTINUOUS_AGENTICS_AWS_ACCOUNT_ID>` and `<EXTERNAL_ID>`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<CONTINUOUS_AGENTICS_AWS_ACCOUNT_ID>:root"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "<EXTERNAL_ID>"
        }
      }
    }
  ]
}
```

6. Name the role `ContinuousAgenticsFleetMindOperator`.
7. Attach the permissions policy below.
8. Send Continuous Agentics the role ARN and external ID out of band.

### 3. Permissions Policy

Name: `ContinuousAgenticsFleetMindOperatorPolicy`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "FleetMindTerraformAndDiscovery",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "ec2:Describe*",
        "ec2:CreateVpc",
        "ec2:DeleteVpc",
        "ec2:CreateSubnet",
        "ec2:DeleteSubnet",
        "ec2:CreateInternetGateway",
        "ec2:DeleteInternetGateway",
        "ec2:AttachInternetGateway",
        "ec2:DetachInternetGateway",
        "ec2:CreateNatGateway",
        "ec2:DeleteNatGateway",
        "ec2:AllocateAddress",
        "ec2:ReleaseAddress",
        "ec2:AssociateAddress",
        "ec2:DisassociateAddress",
        "ec2:CreateRouteTable",
        "ec2:DeleteRouteTable",
        "ec2:CreateRoute",
        "ec2:DeleteRoute",
        "ec2:AssociateRouteTable",
        "ec2:DisassociateRouteTable",
        "ec2:CreateSecurityGroup",
        "ec2:DeleteSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:RunInstances",
        "ec2:TerminateInstances",
        "ec2:CreateTags",
        "ec2:DeleteTags",
        "ec2:CreateVpcEndpoint",
        "ec2:DeleteVpcEndpoints",
        "ec2:ModifyVpcEndpoint"
      ],
      "Resource": "*"
    },
    {
      "Sid": "FleetMindIamForAgentRoles",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:CreateInstanceProfile",
        "iam:DeleteInstanceProfile",
        "iam:GetInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile",
        "iam:PassRole"
      ],
      "Resource": [
        "arn:aws:iam::*:role/*fleetmind*",
        "arn:aws:iam::*:role/*FleetMind*",
        "arn:aws:iam::*:instance-profile/*fleetmind*",
        "arn:aws:iam::*:instance-profile/*FleetMind*"
      ]
    },
    {
      "Sid": "FleetMindStateArtifactsAndLogs",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:ListBucket",
        "s3:GetBucket*",
        "s3:PutBucket*",
        "s3:DeleteBucket*",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:ListBucketVersions",
        "dynamodb:CreateTable",
        "dynamodb:DeleteTable",
        "dynamodb:DescribeTable",
        "dynamodb:UpdateTable",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "secretsmanager:CreateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:TagResource",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:StartSession",
        "ssm:SendCommand",
        "ssm:GetCommandInvocation",
        "ssm:DescribeInstanceInformation",
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:GetLogEvents",
        "logs:PutRetentionPolicy",
        "servicediscovery:CreatePrivateDnsNamespace",
        "servicediscovery:DeleteNamespace",
        "servicediscovery:GetNamespace",
        "servicediscovery:CreateService",
        "servicediscovery:DeleteService",
        "servicediscovery:GetService",
        "servicediscovery:RegisterInstance",
        "servicediscovery:DeregisterInstance",
        "servicediscovery:List*",
        "route53:GetHostedZone",
        "route53:ListHostedZones",
        "route53:ChangeResourceRecordSets"
      ],
      "Resource": "*"
    }
  ]
}
```

## Option B — IAM User (Fallback)

Use this only when cross-account role assumption is not available.

1. Open `IAM`.
2. Choose `Users`.
3. Choose `Create user`.
4. Name it `continuous-agentics-fleetmind`.
5. Do not enable console access.
6. Attach `ContinuousAgenticsFleetMindOperatorPolicy`.
7. Create an access key for `Command Line Interface (CLI)`.
8. Share the access key ID and secret through the agreed secure channel.
9. Rotate or delete the key when onboarding is complete, unless a support window requires it to remain active.

## Trust Boundaries

Continuous Agentics will:

- Use the access only for FleetMind onboarding, operation, troubleshooting, and teardown.
- Store customer-provided credentials in the agreed secure location.
- Avoid customer application data unless explicitly directed during the engagement.
- Prefer Terraform-managed changes so infrastructure is auditable and reproducible.

Continuous Agentics will not:

- Browse unrelated customer systems.
- Create users, keys, or network paths outside FleetMind scope.
- Access billing, payroll, HR, production application data, or unrelated secrets.
- Retain access after the engagement without written approval.

## Customer Deliverables

Send Continuous Agentics:

- AWS account ID
- Preferred region
- Role ARN and external ID, or IAM user access key pair
- Whether to use an existing VPC/subnets or let FleetMind create its own
- Slack workspace details for bot app creation
- GitHub org/repo where each agent is allowed to operate
