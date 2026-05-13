terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  # ── Remote state (enable for team use) ────────────────────────────────────
  # Uncomment and fill in bucket/table names after running:
  #   aws s3 mb s3://<your-bucket>
  #   aws dynamodb create-table --table-name <your-table> \
  #     --attribute-definitions AttributeName=LockID,AttributeType=S \
  #     --key-schema AttributeName=LockID,KeyType=HASH \
  #     --billing-mode PAY_PER_REQUEST
  #
  # Remote state — partial config. Operator provides bucket, region,
  # dynamodb_table via -backend-config flags or a local backend.hcl file.
  # See backend.example.hcl in this directory + docs/MULTI-FLEET.md.
  #
  # The `key` argument is intentionally omitted: Terraform workspaces auto-prefix
  # state files with `env:/<workspace>/`, so the workspace itself isolates state
  # across fleets. Run `terraform workspace new <fleet-name>` per fleet.
  backend "s3" {
    encrypt = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.fleet_name
      ManagedBy   = "terraform"
      Environment = "production"
    }
  }
}

# ── Latest Amazon Linux 2023 AMI ──────────────────────────────────────────────
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name = "name"
    # Excludes the "minimal" AMI variant (al2023-ami-minimal-*) which does NOT
    # include amazon-ssm-agent. The standard AMI name begins with the year:
    # al2023-ami-2023.X.YYYYMMDD.N-kernel-*-x86_64
    values = ["al2023-ami-2023*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  ami_id = var.ami_id != "" ? var.ami_id : data.aws_ami.al2023.id

  # Derive the EC2 Name tag value for the primary PM bot so the task-ledger
  # EventBridge rule can target it via SSM Run Command.
  # Falls back to the first agent if no orchestrators are declared.
  pm_agent_names     = [for name in var.agent_names : name if lookup(var.agent_orchestrators, name, false)]
  wake_instance_name = length(local.pm_agent_names) > 0 ? "${var.fleet_name}-${local.pm_agent_names[0]}" : (length(var.agent_names) > 0 ? "${var.fleet_name}-${var.agent_names[0]}" : "${var.fleet_name}-agent")
}

# ── Task-ledger module ─────────────────────────────────────────────────────
# Creates the DynamoDB task table, S3 narratives bucket, EventBridge Pipe,
# and IAM policy attachments for PM and worker bots.
#
# Gated behind var.delegation_enabled (default false) so existing deployments
# that applied the task-ledger module separately are unaffected.
#
# Required tfvars when enabling:
#   delegation_enabled      = true
#   agent_orchestrators     = { conductor = true, forge = false }  # example
#   wake_target_session_key = "agent:main:slack:channel:<channel_id>"

module "task_ledger" {
  count  = var.delegation_enabled ? 1 : 0
  source = "./modules/task-ledger"

  name_prefix = "${var.fleet_name}-"
  aws_region  = var.aws_region

  # PM bots get the bot-ledger-pm policy (create/update tasks, write narratives)
  pm_role_names = [
    for name in var.agent_names :
    aws_iam_role.agent[name].name
    if lookup(var.agent_orchestrators, name, false)
  ]

  # Worker bots get the bot-ledger-worker policy (update task status, write task .md)
  worker_role_names = [
    for name in var.agent_names :
    aws_iam_role.agent[name].name
    if !lookup(var.agent_orchestrators, name, false)
  ]

  # EventBridge rule targets the primary PM bot's EC2 instance by Name tag.
  # The Name tag is set in ec2.tf: "${var.fleet_name}-${each.key}".
  wake_target_instance_tag_key   = "Name"
  wake_target_instance_tag_value = local.wake_instance_name

  # OpenClaw session key to wake when a terminal task event fires.
  # Format: agent:main:slack:channel:<channel_id>
  wake_target_session_key = var.wake_target_session_key

  tags = {
    Project   = var.fleet_name
    ManagedBy = "terraform"
  }
}
