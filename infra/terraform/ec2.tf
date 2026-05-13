# ── One EC2 instance per agent ────────────────────────────────────────────────
#
# The README spec ("one EC2 per agent, one gateway per EC2") is implemented
# here via for_each over local.agents_map. Each agent gets:
#   - A dedicated EC2 instance (bootstrapped with ONLY that agent's service)
#   - A dedicated IAM role + instance profile (see iam.tf)
#
# Workspace files live on the EC2 root volume at /opt/openclaw/workspace/<agent_id>/.
# Persistent state belongs in the shared substrates: task-ledger DDB, context-store
# DDB, and narratives S3. Per-agent EBS workspace volumes were removed in favour of
# this simpler pattern (root vol + shared substrates).
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
#   - Instance reboot → agent service auto-starts; workspace on root vol survives reboot
#   - Instance loss   → push workspace via S3+SSM (deploy transport, see issue #7)

locals {
  # Build a map of agent_id → { port, instance_type }
  # so all per-agent for_each resources share one canonical source of truth.
  agents_map = {
    for name in var.agent_names : name => {
      port          = var.agent_ports[name]
      instance_type = lookup(var.agent_instance_types, name, var.instance_type)
    }
  }
}

resource "aws_instance" "agent" {
  for_each = local.agents_map

  ami           = local.ami_id
  instance_type = each.value.instance_type
  # Agents go in private subnets — they only need outbound access (Slack Socket
  # Mode + AWS API via NAT). No public IP required.
  subnet_id                   = local.private_subnets[index(var.agent_names, each.key) % 2]
  associate_public_ip_address = false
  vpc_security_group_ids      = [aws_security_group.fleet.id]
  iam_instance_profile        = aws_iam_instance_profile.agent[each.key].name

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 50
    delete_on_termination = true
    encrypted             = true
  }

  user_data = templatefile("${path.module}/user_data/agent_bootstrap.sh.tpl", {
    fleet_name        = var.fleet_name
    agent_id          = each.key
    agent_port        = each.value.port
    openclaw_version  = var.openclaw_version
    node_version      = var.node_version
    aws_region        = var.aws_region
    fleetmind_version = var.fleetmind_version
  })

  user_data_replace_on_change = true

  tags = {
    Name                   = "${var.fleet_name}-${each.key}"
    "fleetmind:agent_id"   = each.key
    "fleetmind:fleet_name" = var.fleet_name
  }

  lifecycle {
    ignore_changes = [ami]
  }
}


