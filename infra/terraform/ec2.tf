# ── One EC2 instance per OpenClaw agent ──────────────────────────────────────
#
# Design rationale:
#   - Each agent is its own isolated EC2 instance (not a shared host)
#   - EBS data volume at /dev/xvdf persists the OpenClaw workspace (memory,
#     state, skills) across instance replacements and reboots
#   - systemd manages the openclaw Docker container with Restart=always
#   - Agents live in public subnets for Slack Socket Mode egress
#   - SSM Session Manager enables shell access without SSH or bastion

resource "aws_instance" "agent" {
  for_each = toset(var.agent_names)

  ami                    = local.ami_id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.agent.id]
  iam_instance_profile   = aws_iam_instance_profile.agent.name

  # Root volume — OS only
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    delete_on_termination = true
    encrypted             = true
  }

  user_data = templatefile("${path.module}/user_data/agent.sh.tpl", {
    agent_name     = each.key
    agent_port     = lookup(var.agent_ports, each.key, 18789)
    fleet_name     = var.fleet_name
    openclaw_image = var.openclaw_image
    aws_region     = var.aws_region
  })

  user_data_replace_on_change = true

  tags = { Name = "${var.fleet_name}-${each.key}" }

  lifecycle {
    # Don't replace instance just because AMI changed — use launch template + ASG for rolling updates
    ignore_changes = [ami]
  }
}

# ── EBS workspace volumes (one per agent) ─────────────────────────────────────
resource "aws_ebs_volume" "workspace" {
  for_each = toset(var.agent_names)

  availability_zone = aws_instance.agent[each.key].availability_zone
  size              = var.workspace_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = { Name = "${var.fleet_name}-${each.key}-workspace" }

  lifecycle {
    # NEVER delete the workspace volume — it holds the agent's memory
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "workspace" {
  for_each = toset(var.agent_names)

  device_name  = "/dev/xvdf"
  volume_id    = aws_ebs_volume.workspace[each.key].id
  instance_id  = aws_instance.agent[each.key].id
  force_detach = false
}
