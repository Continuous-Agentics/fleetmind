# ── NATS server module ────────────────────────────────────────────────────────
#
# Provisions a single NATS server EC2 instance + Cloud Map service registration.
# Agents discover the server at:
#   nats://<nats_service_name>.<namespace_name>:4222
#
# This is a single-node NATS server suitable for a fleet POC.
# For HA / JetStream clustering, replace with an Auto Scaling Group or
# an ECS Fargate task behind an NLB and update the Cloud Map registration.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ── AMI ───────────────────────────────────────────────────────────────────────

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
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
  # Full DNS name agents use to connect: nats://nats.<namespace>:4222
  nats_dns_name = "nats.${var.cloud_map_namespace_name}"
}

# ── Security group ────────────────────────────────────────────────────────────

resource "aws_security_group" "nats" {
  name        = "${var.fleet_name}-nats"
  description = "FleetMind NATS server - inbound 4222 from fleet agents, egress unrestricted."
  vpc_id      = var.vpc_id

  # NATS client port — open to fleet agent security group only
  ingress {
    description     = "NATS client (fleet agents)"
    from_port       = 4222
    to_port         = 4222
    protocol        = "tcp"
    security_groups = [var.fleet_sg_id]
  }

  # NATS monitoring endpoint for agent-side health checks (e.g., /healthz)
  ingress {
    description     = "NATS monitoring (fleet agents)"
    from_port       = 8222
    to_port         = 8222
    protocol        = "tcp"
    security_groups = [var.fleet_sg_id]
  }

  # Allow egress (SSM, CloudWatch, NATS health probes)
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.fleet_name}-nats-sg" })
}

# ── IAM role (SSM for management, no extra perms needed) ─────────────────────

resource "aws_iam_role" "nats" {
  name = "${var.fleet_name}-nats"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${var.fleet_name}-nats-role" })
}

resource "aws_iam_role_policy_attachment" "nats_ssm" {
  role       = aws_iam_role.nats.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "nats" {
  name = "${var.fleet_name}-nats"
  role = aws_iam_role.nats.name
}

resource "terraform_data" "nats_rollout" {
  input = var.rollout_trigger
}

# ── EC2 instance ──────────────────────────────────────────────────────────────

resource "aws_instance" "nats" {
  ami                    = local.ami_id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.nats.id]
  iam_instance_profile   = aws_iam_instance_profile.nats.name

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # NATS server is internal-only; no public IP needed.
  associate_public_ip_address = false

  user_data = base64encode(templatefile("${path.module}/user_data/nats_bootstrap.sh.tpl", {
    nats_version      = var.nats_version
    fleet_name        = var.fleet_name
    nats_auth_token   = var.nats_auth_token
    nats_tls_enabled  = var.nats_tls_enabled
    nats_tls_cert_pem = var.nats_tls_cert_pem
    nats_tls_key_pem  = var.nats_tls_key_pem
    nats_tls_ca_pem   = var.nats_tls_ca_pem
  }))

  # Prevent replacement when user_data changes after initial deploy.
  lifecycle {
    ignore_changes       = [user_data, ami]
    replace_triggered_by = [terraform_data.nats_rollout]
  }

  tags = merge(var.tags, { Name = "${var.fleet_name}-nats" })
}

# ── Cloud Map service registration ───────────────────────────────────────────

# Service entry within the existing namespace.
resource "aws_service_discovery_service" "nats" {
  name         = "nats"
  namespace_id = var.cloud_map_namespace_id

  dns_config {
    namespace_id = var.cloud_map_namespace_id
    # MULTIVALUE returns all healthy IPs for the service — correct for a
    # single-instance registration. WEIGHTED is for traffic-splitting.
    routing_policy = "MULTIVALUE"

    dns_records {
      ttl  = 10
      type = "A"
    }
  }

  # Health check is optional but strongly recommended for production.
  # For the POC we rely on DNS TTL + reconnect logic in the nats.js client.
  health_check_custom_config {
    failure_threshold = 1
  }

  tags = merge(var.tags, { Name = "${var.fleet_name}-nats-svc" })
}

# Register the instance's private IP as a service instance in Cloud Map.
resource "aws_service_discovery_instance" "nats" {
  instance_id = aws_instance.nats.id
  service_id  = aws_service_discovery_service.nats.id

  attributes = {
    AWS_INSTANCE_IPV4 = aws_instance.nats.private_ip
    AWS_INSTANCE_PORT = "4222"
  }
}
