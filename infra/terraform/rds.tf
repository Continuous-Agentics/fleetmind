# ── RDS Postgres 16 — shared context store ────────────────────────────────────
#
# All agents share this DB for the FleetMind ContextStore (hive mind).
# Placed in private subnets — not internet-accessible.
# Agent SG is the only allowed ingress source.

resource "aws_db_subnet_group" "main" {
  name       = "${var.fleet_name}-db-subnet-group"
  subnet_ids = aws_subnet.private[*].id

  tags = { Name = "${var.fleet_name}-db-subnet-group" }
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "db_password" {
  name                    = "${var.fleet_name}/shared/db-password"
  description             = "RDS master password for ${var.fleet_name}"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "db_password" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = jsonencode({ password = random_password.db.result })
}

resource "aws_db_instance" "main" {
  identifier        = "${var.fleet_name}-postgres"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.rds_instance_class
  allocated_storage = var.rds_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "fleetmind"
  username = "fleetmind"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az               = var.rds_multi_az
  publicly_accessible    = false
  skip_final_snapshot    = false
  final_snapshot_identifier = "${var.fleet_name}-postgres-final"

  backup_retention_period = 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  deletion_protection = true

  tags = { Name = "${var.fleet_name}-postgres" }
}

resource "terraform_data" "rds_database_url" {
  # Stores the full DATABASE_URL in Secrets Manager so agents can fetch it
  triggers_replace = [aws_db_instance.main.endpoint]

  provisioner "local-exec" {
    command = <<-CMD
      aws secretsmanager put-secret-value \
        --secret-id "${var.fleet_name}/shared/anthropic" \
        --secret-string '{"DATABASE_URL":"postgresql://fleetmind:${random_password.db.result}@${aws_db_instance.main.endpoint}/fleetmind"}' \
        --region ${var.aws_region} 2>/dev/null || true
    CMD
  }
}

terraform {
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}
