# Module declares only required providers; consumer configures `provider "aws"`
# and the Terraform backend in their root module. See README.md "Consumer setup"
# for an example root configuration.
terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Networking (VPC, subnets, endpoints) lives in vpc.tf using the upstream
# terraform-aws-modules/vpc/aws module. The locals there (vpc_id,
# private_subnet_ids, etc.) are read by the agent submodule + sg.tf + outputs.

# ── Latest Amazon Linux 2023 AMI ──────────────────────────────────────────────
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name = "name"
    # Excludes the "minimal" AMI variant (al2023-ami-minimal-*) which does NOT
    # include amazon-ssm-agent. The standard AMI name embeds the architecture:
    # al2023-ami-2023.X.YYYYMMDD.N-kernel-*-{arm64|x86_64}
    values = ["al2023-ami-2023*-${var.architecture}"]
  }

  filter {
    name   = "architecture"
    values = [var.architecture]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  ami_id = var.ami_id != "" ? var.ami_id : data.aws_ami.al2023.id

}

# ── One agent submodule per declared agent ────────────────────────────────────
# Each call produces the full per-bot AWS footprint: EC2 instance, IAM role +
# instance profile + policies, and per-agent Slack + model-provider secrets.
#
# Cross-cutting policies (task-ledger PM/worker grants) are attached separately
# by the task-ledger submodule below using module.agent[*].iam_role_name.
module "agent" {
  for_each = toset(var.agent_names)
  source   = "./modules/agent"
  # Ensures NATS resources are provisioned first when enabled. Runtime readiness
  # is handled inside the subscriber unit with an ExecStartPre health probe.
  depends_on = [module.nats]

  name       = each.key
  fleet_name = var.fleet_name
  aws_region = var.aws_region

  ami_id        = local.ami_id
  instance_type = lookup(var.agent_instance_types, each.key, var.instance_type)
  # Round-robin agents across whatever private subnets the fleet has (1 to N)
  # for AZ spread. We modulo by the actual subnet count rather than a hardcoded
  # 2 so BYO-VPC operators can bring any subnet count without index-out-of-range.
  subnet_id              = local.private_subnet_ids[index(var.agent_names, each.key) % length(local.private_subnet_ids)]
  vpc_security_group_ids = [aws_security_group.fleet.id]

  openclaw_version  = var.openclaw_version
  node_version      = var.node_version
  fleetmind_version = var.fleetmind_version

  # Pass a static bool for count (must be known at plan time — cannot use a
  # computed ARN). The ARN is passed separately for the policy document body.
  context_store_enabled       = var.context_store_backend == "dynamodb"
  context_store_table_arn     = coalesce(one(aws_dynamodb_table.context_store[*].arn), "")
  secret_recovery_window_days = var.secret_recovery_window_days

  # NATS subscriber units are always written — no opt-in needed. The subscriber
  # exits 0 when delegation.nats is absent from fleet.yaml, so systemd leaves it
  # alone on non-NATS fleets. is_orchestrator selects --mode pm vs --mode worker.
  is_orchestrator = lookup(var.agent_orchestrators, each.key, false)
  gateway_port    = 18789

  model_providers = lookup(var.agent_providers, each.key, [])

  rollout_trigger = var.agent_rollout_trigger
}

# ── Task-ledger module ────────────────────────────────────────────────────────
# Creates the DynamoDB task table, S3 narratives bucket, and IAM policy
# attachments for PM and worker bots.
#
# Terminal task events reach the PM over NATS push (the `fleetmind nats
# subscribe` units installed by the agent bootstrap), not an EventBridge Pipe
# -> SSM Run Command wake pipeline. That wake pipeline was removed; this
# submodule creates no wake infrastructure.
#
# Gated behind var.delegation_enabled (default false) so fleets that don't use
# the delegation substrate skip it entirely.
#
# Required tfvars when enabling:
#   delegation_enabled      = true
#   agent_orchestrators     = { conductor = true, forge = false }  # example

module "task_ledger" {
  count  = var.delegation_enabled ? 1 : 0
  source = "./modules/task-ledger"

  name_prefix = "${var.fleet_name}-"

  # PM bots get the bot-ledger-pm policy (create/update tasks, write narratives)
  pm_role_names = [
    for name in var.agent_names :
    module.agent[name].iam_role_name
    if lookup(var.agent_orchestrators, name, false)
  ]

  # Worker bots get the bot-ledger-worker policy (update task status, write task .md)
  worker_role_names = [
    for name in var.agent_names :
    module.agent[name].iam_role_name
    if !lookup(var.agent_orchestrators, name, false)
  ]

  # Bucket is created at root level (s3.tf) so it always exists regardless of
  # delegation_enabled. Pass both name and ARN in so task-ledger doesn't have
  # to data-lookup a bucket that's created in the same apply (the data lookup
  # races plan/refresh against the create on first bring-up).
  s3_bucket_name = aws_s3_bucket.ledger.bucket
  s3_bucket_arn  = aws_s3_bucket.ledger.arn

  tags = {
    Project   = var.fleet_name
    ManagedBy = "terraform"
  }
}
