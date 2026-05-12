###############################################################################
# VPC Endpoints
#
# Gateway endpoints (S3 + DynamoDB) — always on, free.
#   Routes traffic from private subnets to S3/DDB through the AWS network
#   backbone instead of via NAT, improving reliability and eliminating
#   per-GB NAT data costs for those services.
#
# Interface endpoints (SSM/ssmmessages/ec2messages/SecretsManager) — opt-in.
#   Required ONLY for fleets in fully-private subnets without NAT. When NAT
#   is present (the default), these are best-practice hardening that eliminates
#   the NAT-dependency for SSM connectivity. Gated by var.enable_interface_endpoints
#   because each endpoint costs ~$20/mo (4 endpoints ≈ $80/mo).
#
#   Enable in tfvars for fleets where SSM resilience independent of NAT health
#   is desired, or where agents will eventually run without NAT.
#
# All endpoints are only created when create_vpc = true (i.e., fleetmind
# manages the VPC). If you bring your own VPC (var.vpc_id != ""), wire
# endpoints in your own infrastructure.
###############################################################################

# ── Security Group for interface endpoints ─────────────────────────────────────
# Interface endpoints terminate as ENIs in the private subnets. They need a
# SG that allows HTTPS inbound from within the VPC so agent processes can
# reach the AWS service APIs.
# Using VPC CIDR as the source avoids any circular dependency with the fleet SG.
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
    cidr_blocks = [aws_vpc.main[0].cidr_block]
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

# ── Gateway endpoints (always on, free) ───────────────────────────────────────

resource "aws_vpc_endpoint" "s3" {
  count = local.create_vpc ? 1 : 0

  vpc_id            = local.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"

  # Associate with the private route table so agents in private subnets reach
  # S3 through the backbone (task-ledger narratives bucket, etc.).
  route_table_ids = [aws_route_table.private[0].id]

  tags = { Name = "${var.fleet_name}-s3-gateway" }
}

resource "aws_vpc_endpoint" "dynamodb" {
  count = local.create_vpc ? 1 : 0

  vpc_id            = local.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.dynamodb"
  vpc_endpoint_type = "Gateway"

  route_table_ids = [aws_route_table.private[0].id]

  tags = { Name = "${var.fleet_name}-dynamodb-gateway" }
}

# ── Interface endpoints (opt-in, ~$20/mo each) ────────────────────────────────
# Gated by var.enable_interface_endpoints (default false).
# private_dns_enabled = true means the standard AWS SDK hostnames
# (e.g. ssm.us-west-2.amazonaws.com) resolve to the endpoint ENI IPs
# without any application-level change.

resource "aws_vpc_endpoint" "ssm" {
  count = local.create_vpc && var.enable_interface_endpoints ? 1 : 0

  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ssm"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true

  subnet_ids         = local.private_subnets
  security_group_ids = [aws_security_group.vpc_endpoints[0].id]

  tags = { Name = "${var.fleet_name}-ssm-endpoint" }
}

resource "aws_vpc_endpoint" "ssmmessages" {
  count = local.create_vpc && var.enable_interface_endpoints ? 1 : 0

  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ssmmessages"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true

  subnet_ids         = local.private_subnets
  security_group_ids = [aws_security_group.vpc_endpoints[0].id]

  tags = { Name = "${var.fleet_name}-ssmmessages-endpoint" }
}

resource "aws_vpc_endpoint" "ec2messages" {
  count = local.create_vpc && var.enable_interface_endpoints ? 1 : 0

  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ec2messages"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true

  subnet_ids         = local.private_subnets
  security_group_ids = [aws_security_group.vpc_endpoints[0].id]

  tags = { Name = "${var.fleet_name}-ec2messages-endpoint" }
}

resource "aws_vpc_endpoint" "secretsmanager" {
  count = local.create_vpc && var.enable_interface_endpoints ? 1 : 0

  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true

  subnet_ids         = local.private_subnets
  security_group_ids = [aws_security_group.vpc_endpoints[0].id]

  tags = { Name = "${var.fleet_name}-secretsmanager-endpoint" }
}
