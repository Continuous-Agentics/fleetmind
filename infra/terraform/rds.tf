# ── RDS Postgres 16 ───────────────────────────────────────────────────────────
#
# Placed in private subnets — not internet-accessible.
# Agent SG is the only allowed ingress source.
#
# Note: with DynamoDB as the primary ContextStore, RDS is optional.
# Set var.enable_rds = false to skip this entirely for simpler deployments.

resource "aws_db_subnet_group" "main" {
  count = var.enable_rds ? 1 : 0

  name       = "${var.fleet_name}-db-subnet-group"
  subnet_ids = local.private_subnets

  tags = { Name = "${var.fleet_name}-db-subnet-group" }
}

resource "random_password" "db" {
  count   = var.enable_rds ? 1 : 0
  length  = 32
  special = false
}

# Stores the RDS master password + full DATABASE_URL as a single secret.
# Agents fetch this at start time via the instance profile.
resource "aws_secretsmanager_secret" "db" {
  count = var.enable_rds ? 1 : 0

  name                    = "${var.fleet_name}/shared/db"
  description             = "RDS credentials for ${var.fleet_name}"
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "db" {
  count = var.enable_rds ? 1 : 0

  secret_id = aws_secretsmanager_secret.db[0].id

  secret_string = templatefile("${path.module}/templates/db_secret.tftpl", {
    password   = random_password.db[0].result
    endpoint   = aws_db_instance.main[0].endpoint
    fleet_name = var.fleet_name
  })
}

resource "aws_db_instance" "main" {
  count = var.enable_rds ? 1 : 0

  identifier        = "${var.fleet_name}-postgres"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.rds_instance_class
  allocated_storage = var.rds_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "fleetmind"
  username = "fleetmind"
  password = random_password.db[0].result

  db_subnet_group_name   = aws_db_subnet_group.main[0].name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az                  = var.rds_multi_az
  publicly_accessible       = false
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.fleet_name}-postgres-final"

  backup_retention_period = 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  deletion_protection = true

  tags = { Name = "${var.fleet_name}-postgres" }
}


