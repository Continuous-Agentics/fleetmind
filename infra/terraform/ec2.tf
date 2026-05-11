# ── One EC2 instance per agent ────────────────────────────────────────────────
#
# The README spec ("one EC2 per agent, one gateway per EC2") is implemented
# here via for_each over local.agents_map. Each agent gets:
#   - A dedicated EC2 instance (bootstrapped with ONLY that agent's service)
#   - A dedicated EBS workspace volume (workspace, memory, state)
#   - A dedicated IAM role + instance profile (see iam.tf)
#
# Shared across the fleet (provisioned elsewhere in this module):
#   - VPC, subnets, NAT gateway, route tables (vpc.tf)
#   - Security group (sg.tf)
#   - Optional RDS instance (rds.tf, enable_rds=false by default)
#   - DynamoDB context-store table (dynamodb.tf)
#   - Secrets Manager placeholders (secrets.tf)
#
# Fault tolerance per agent:
#   - Process crash   → systemd Restart=always, back up in 10s
#   - Instance reboot → EBS remounts via fstab, agent service auto-starts
#   - Instance loss   → EBS survives (prevent_destroy), reattach to new instance

locals {
  # Build a map of agent_id → { port, instance_type, volume_size_gb }
  # so all per-agent for_each resources share one canonical source of truth.
  agents_map = {
    for name in var.agent_names : name => {
      port            = var.agent_ports[name]
      instance_type   = lookup(var.agent_instance_types, name, var.instance_type)
      volume_size_gb  = lookup(var.agent_volume_sizes_gb, name, var.workspace_volume_size_gb)
    }
  }
}

resource "aws_instance" "agent" {
  for_each = local.agents_map

  ami                    = local.ami_id
  instance_type          = each.value.instance_type
  subnet_id              = local.public_subnets[0]
  vpc_security_group_ids = [aws_security_group.fleet.id]
  iam_instance_profile   = aws_iam_instance_profile.agent[each.key].name

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 50
    delete_on_termination = true
    encrypted             = true
  }

  user_data = templatefile("${path.module}/user_data/agent_bootstrap.sh.tpl", {
    fleet_name       = var.fleet_name
    agent_id         = each.key
    agent_port       = each.value.port
    openclaw_version = var.openclaw_version
    node_version     = var.node_version
    aws_region       = var.aws_region
  })

  user_data_replace_on_change = true

  tags = {
    Name                  = "${var.fleet_name}-${each.key}"
    "fleetmind:agent_id"  = each.key
    "fleetmind:fleet_name" = var.fleet_name
  }

  lifecycle {
    ignore_changes = [ami]
  }
}

# ── Per-agent EBS workspace volume ────────────────────────────────────────────
# Each agent gets its own volume so workspace state (memory, session files,
# skills) survives instance replacement. Volumes are scoped to the same AZ as
# the instance they're attached to.

resource "aws_ebs_volume" "agent_workspace" {
  for_each = local.agents_map

  availability_zone = aws_instance.agent[each.key].availability_zone
  size              = each.value.volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Name                  = "${var.fleet_name}-${each.key}-workspace"
    "fleetmind:agent_id"  = each.key
    "fleetmind:fleet_name" = var.fleet_name
  }

  lifecycle {
    # Never destroy — this volume holds all agent memory and state.
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "agent_workspace" {
  for_each = local.agents_map

  device_name  = "/dev/xvdf"
  volume_id    = aws_ebs_volume.agent_workspace[each.key].id
  instance_id  = aws_instance.agent[each.key].id
  force_detach = false
}
