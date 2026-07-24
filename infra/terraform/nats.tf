# ── NATS transport infrastructure ─────────────────────────────────────────────
#
# When var.nats_enabled = true (default true), this file provisions:
#   1. A Cloud Map private DNS namespace: <fleet_name>.internal
#   2. A single-node NATS server EC2 instance
#   3. Cloud Map service registration → nats.<fleet_name>.internal:4222
#
# Set nats_enabled = true in tfvars to activate. The NATS server lives in the
# first private subnet. Agents discover it via the Cloud Map DNS name.

# ── Cloud Map private DNS namespace ───────────────────────────────────────────

resource "aws_service_discovery_private_dns_namespace" "fleet" {
  count       = var.nats_enabled ? 1 : 0
  name        = "${var.fleet_name}.internal"
  description = "FleetMind fleet ${var.fleet_name} - private service discovery namespace"
  vpc         = local.vpc_id

  tags = { Name = "${var.fleet_name}-namespace" }
}

# ── NATS server module ────────────────────────────────────────────────────────

module "nats" {
  count  = var.nats_enabled ? 1 : 0
  source = "./modules/nats"

  fleet_name        = var.fleet_name
  vpc_id            = local.vpc_id
  subnet_id         = local.private_subnet_ids[0]
  fleet_sg_id       = aws_security_group.fleet.id
  instance_type     = var.nats_instance_type
  architecture      = var.architecture
  nats_version      = var.nats_version
  nats_auth_token   = var.nats_auth_token
  nats_tls_enabled  = var.nats_tls_enabled
  nats_tls_cert_pem = var.nats_tls_cert_pem
  nats_tls_key_pem  = var.nats_tls_key_pem
  nats_tls_ca_pem   = var.nats_tls_ca_pem
  rollout_trigger   = var.nats_rollout_trigger

  cloud_map_namespace_id   = aws_service_discovery_private_dns_namespace.fleet[0].id
  cloud_map_namespace_name = aws_service_discovery_private_dns_namespace.fleet[0].name

  tags = { fleet = var.fleet_name }
}
