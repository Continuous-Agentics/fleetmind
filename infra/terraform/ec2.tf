# ── One EC2 instance per client fleet ────────────────────────────────────────
#
# All agents (orchestrator, pixel, forge) run as co-located systemd services
# on a single instance. Each agent gets its own workspace subdirectory on the
# shared EBS data volume.
#
# No Docker — OpenClaw runs directly as a Node.js process managed by systemd.
# No custom AMI — user_data bootstraps the instance in ~2 minutes.
#
# Fault tolerance:
#   - Process crash   → systemd Restart=always, back up in 10s
#   - Instance reboot → EBS remounts via fstab, all services auto-start
#   - Instance loss   → EBS volume survives (prevent_destroy), reattach to new instance

resource "aws_instance" "fleet" {
  ami                    = local.ami_id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.fleet.id]
  iam_instance_profile   = aws_iam_instance_profile.fleet.name

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 50
    delete_on_termination = true
    encrypted             = true
  }

  user_data = templatefile("${path.module}/user_data/bootstrap.sh.tpl", {
    fleet_name       = var.fleet_name
    agent_names      = var.agent_names
    agent_ports      = var.agent_ports
    openclaw_version = var.openclaw_version
    node_version     = var.node_version
    aws_region       = var.aws_region
  })

  user_data_replace_on_change = true

  tags = { Name = "${var.fleet_name}-fleet" }

  lifecycle {
    ignore_changes = [ami]
  }
}

# ── Shared EBS workspace volume ───────────────────────────────────────────────
# One volume, subdirectories per agent:
#   /opt/openclaw/workspace/orchestrator/
#   /opt/openclaw/workspace/pixel/
#   /opt/openclaw/workspace/forge/

resource "aws_ebs_volume" "workspace" {
  availability_zone = aws_instance.fleet.availability_zone
  size              = var.workspace_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = { Name = "${var.fleet_name}-workspace" }

  lifecycle {
    # Never destroy — this volume holds all agent memory and state
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "workspace" {
  device_name  = "/dev/xvdf"
  volume_id    = aws_ebs_volume.workspace.id
  instance_id  = aws_instance.fleet.id
  force_detach = false
}
