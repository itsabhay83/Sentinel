variable "name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_cidr_blocks" { type = list(string) }
variable "engine_version" { type = string }
variable "instance_class" { type = string }
variable "allocated_storage_gb" { type = number }
variable "max_storage_gb" { type = number }
variable "multi_az" { type = bool }
variable "backup_retention_days" { type = number }
variable "tags" {
  type    = map(string)
  default = {}
}

resource "random_password" "master" {
  length  = 40
  special = false
}

resource "aws_secretsmanager_secret" "master" {
  name = "${var.name}/postgres/master"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "master" {
  secret_id     = aws_secretsmanager_secret.master.id
  secret_string = jsonencode({ username = "sentinel", password = random_password.master.result })
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-postgres"
  subnet_ids = var.subnet_ids
  tags       = var.tags
}

resource "aws_security_group" "this" {
  name   = "${var.name}-postgres"
  vpc_id = var.vpc_id
  tags   = var.tags

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }
}

# pg_partman is not used: partition creation and rotation are done by the
# scheduler's housekeeping loop (packages/db/src/partitions.ts), so the only
# parameter that matters here is log_min_duration_statement for slow-query
# triage during an incident.
resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-postgres"
  family = "postgres16"
  tags   = var.tags

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name}-postgres"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name  = "sentinel"
  username = "sentinel"
  password = random_password.master.result

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  multi_az               = var.multi_az
  publicly_accessible    = false

  backup_retention_period   = var.backup_retention_days
  backup_window             = "04:00-05:00"
  maintenance_window        = "sun:05:30-sun:06:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-postgres-final"

  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = var.tags
}

output "endpoint" { value = aws_db_instance.this.endpoint }
output "password_secret_arn" { value = aws_secretsmanager_secret.master.arn }
output "security_group_id" { value = aws_security_group.this.id }
