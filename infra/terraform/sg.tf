# ── Fleet instance security group ─────────────────────────────────────────────
resource "aws_security_group" "fleet" {
  name        = "${var.fleet_name}-fleet"
  description = "FleetMind agent instance"
  vpc_id      = local.vpc_id

  # OpenClaw gateway ports: ingress intentionally removed.
  # Agents use Slack Socket Mode (outbound WebSocket to slack.com) and AWS API
  # via NAT gateway — no inbound traffic is needed on the agent port. Instances
  # now live in private subnets with no public IPs, so internet ingress would be
  # unreachable anyway. If HTTP webhook support is added in future, restrict to
  # the VPC CIDR only (cidr_blocks = [aws_vpc.main[0].cidr_block]).

  # Optional SSH (use SSM instead — this is off by default)
  dynamic "ingress" {
    for_each = length(var.allowed_ssh_cidrs) > 0 ? [1] : []
    content {
      description = "SSH (restricted)"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.allowed_ssh_cidrs
    }
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.fleet_name}-fleet-sg" }
}

# ── RDS security group ────────────────────────────────────────────────────────
resource "aws_security_group" "rds" {
  name        = "${var.fleet_name}-rds"
  description = "RDS Postgres - fleet instance access only"
  vpc_id      = local.vpc_id

  ingress {
    description     = "Postgres from fleet instance"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.fleet.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.fleet_name}-rds-sg" }
}
