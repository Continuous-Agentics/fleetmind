###############################################################################
# VPC + endpoints — create new or adopt existing
#
# When var.vpc_id is empty (default), this module creates a /16 VPC with
# 2 public + 2 private subnets across 2 AZs, an IGW, a single NAT gateway,
# route tables, and VPC endpoints (S3 + DynamoDB gateway endpoints always on;
# SSM + Secrets Manager interface endpoints opt-in via
# var.enable_interface_endpoints).
#
# When var.vpc_id is set, no VPC/subnet/endpoint resources are created.
# Caller supplies existing_public_subnet_ids + existing_private_subnet_ids.
# Wire endpoints in your own infrastructure if needed.
#
# Built on terraform-aws-modules/vpc/aws (battle-tested upstream).
###############################################################################

data "aws_availability_zones" "available" {
  state = "available"
}

# When adopting an existing VPC, read its CIDR block so the endpoints SG
# can use it as an ingress source. Skipped when this module creates the VPC.
data "aws_vpc" "existing" {
  count = local.create_vpc ? 0 : 1
  id    = var.vpc_id
}

locals {
  create_vpc = var.vpc_id == ""

  azs = local.create_vpc ? slice(data.aws_availability_zones.available.names, 0, 2) : []

  # Per-subnet CIDR blocks for the created VPC (2 public + 2 private).
  public_subnet_cidrs  = local.create_vpc ? [for i in [0, 1] : cidrsubnet(var.vpc_cidr, 8, i)] : []
  private_subnet_cidrs = local.create_vpc ? [for i in [0, 1] : cidrsubnet(var.vpc_cidr, 8, i + 10)] : []

  # Unified accessors — consumers (modules/agent, sg.tf, outputs.tf) read these
  # without caring whether we created the VPC or adopted one.
  vpc_id             = local.create_vpc ? module.vpc[0].vpc_id : var.vpc_id
  vpc_cidr_block     = local.create_vpc ? module.vpc[0].vpc_cidr_block : data.aws_vpc.existing[0].cidr_block
  private_subnet_ids = local.create_vpc ? module.vpc[0].private_subnets : var.existing_private_subnet_ids
}

module "vpc" {
  count   = local.create_vpc ? 1 : 0
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.fleet_name}-vpc"
  cidr = var.vpc_cidr
  azs  = local.azs

  public_subnets  = local.public_subnet_cidrs
  private_subnets = local.private_subnet_cidrs

  enable_nat_gateway   = true
  single_nat_gateway   = true # cost: one NAT for the fleet
  enable_dns_hostnames = true
  enable_dns_support   = true

  public_subnet_tags  = { Tier = "public" }
  private_subnet_tags = { Tier = "private" }
}

# ── VPC endpoints (only when we manage the VPC) ───────────────────────────────
#
# Gateway endpoints (S3, DynamoDB) are free and always created.
# Interface endpoints (SSM/ssmmessages/ec2messages/SecretsManager) are opt-in
# via var.enable_interface_endpoints (~$80/mo, 4 endpoints * ~$20/mo).

resource "aws_security_group" "vpc_endpoints" {
  count = local.create_vpc && var.enable_interface_endpoints ? 1 : 0

  name        = "${var.fleet_name}-vpc-endpoints"
  description = "Allow HTTPS from VPC to interface VPC endpoints (SSM, SecretsManager)"
  vpc_id      = local.vpc_id

  ingress {
    description = "HTTPS from VPC CIDR"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [local.vpc_cidr_block]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.fleet_name}-vpc-endpoints-sg" }
}

module "vpc_endpoints" {
  count   = local.create_vpc ? 1 : 0
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "~> 5.0"

  vpc_id = local.vpc_id

  endpoints = merge(
    # Gateway endpoints (always on, free)
    {
      s3 = {
        service         = "s3"
        service_type    = "Gateway"
        route_table_ids = module.vpc[0].private_route_table_ids
        tags            = { Name = "${var.fleet_name}-s3-gateway" }
      }
      dynamodb = {
        service         = "dynamodb"
        service_type    = "Gateway"
        route_table_ids = module.vpc[0].private_route_table_ids
        tags            = { Name = "${var.fleet_name}-dynamodb-gateway" }
      }
    },
    # Interface endpoints (opt-in, ~$20/mo each)
    var.enable_interface_endpoints ? {
      ssm = {
        service             = "ssm"
        private_dns_enabled = true
        subnet_ids          = local.private_subnet_ids
        security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
        tags                = { Name = "${var.fleet_name}-ssm-endpoint" }
      }
      ssmmessages = {
        service             = "ssmmessages"
        private_dns_enabled = true
        subnet_ids          = local.private_subnet_ids
        security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
        tags                = { Name = "${var.fleet_name}-ssmmessages-endpoint" }
      }
      ec2messages = {
        service             = "ec2messages"
        private_dns_enabled = true
        subnet_ids          = local.private_subnet_ids
        security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
        tags                = { Name = "${var.fleet_name}-ec2messages-endpoint" }
      }
      secretsmanager = {
        service             = "secretsmanager"
        private_dns_enabled = true
        subnet_ids          = local.private_subnet_ids
        security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
        tags                = { Name = "${var.fleet_name}-secretsmanager-endpoint" }
      }
    } : {},
  )
}
