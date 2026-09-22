# Probe compute for one region. Deliberately self-contained: a probe needs only
# outbound internet (to reach the monitored targets) plus outbound access to the
# control-plane Redis and Postgres. It exposes no inbound port except the
# health endpoint inside the VPC.
#
# ECS Fargate is used instead of EC2 because the probe is stateless and the only
# scaling knob that matters is task count.
#
# NOTE: Fargate cannot grant CAP_NET_RAW, so ICMP monitors do NOT work on
# Fargate. Regions that must serve ICMP need the EC2 launch type with
# linuxParameters.capabilities.add = ["NET_RAW"]. See deploy/README.md.

variable "name" { type = string }
variable "region_code" { type = string }
# Unused by the Fargate path. Carried so switching a region to the EC2 launch
# type (the only way to get CAP_NET_RAW, and therefore ICMP) needs no change to
# the caller's variable shape.
variable "instance_type" { type = string }
variable "desired_count" { type = number }
variable "image_uri" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  family = "${var.name}-probe-${var.region_code}"
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_ecs_cluster" "this" {
  name = local.family
  tags = var.tags

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/sentinel/probe/${var.region_code}"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_security_group" "this" {
  name        = local.family
  description = "Sentinel probe ${var.region_code}"
  vpc_id      = data.aws_vpc.default.id
  tags        = var.tags

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "execution" {
  name = "${local.family}-execution"
  tags = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  tags                     = var.tags

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "probe"
    image     = var.image_uri
    essential = true

    portMappings = [{ containerPort = 4100, protocol = "tcp" }]

    environment = [
      { name = "REGION_CODE", value = var.region_code },
      { name = "NODE_ENV", value = "production" },
      { name = "PROBE_HEALTH_PORT", value = "4100" },
    ]

    # Every secret is injected by reference; nothing sensitive is stored in the
    # task definition, which is world-readable inside the account.
    secrets = [
      { name = "DATABASE_URL", valueFrom = "${var.name}/probe/DATABASE_URL" },
      { name = "REDIS_URL", valueFrom = "${var.name}/probe/REDIS_URL" },
      { name = "ENCRYPTION_KEY", valueFrom = "${var.name}/probe/ENCRYPTION_KEY" },
      { name = "BETTER_AUTH_SECRET", valueFrom = "${var.name}/probe/BETTER_AUTH_SECRET" },
      { name = "BETTER_AUTH_URL", valueFrom = "${var.name}/probe/BETTER_AUTH_URL" },
      { name = "NEXT_PUBLIC_APP_URL", valueFrom = "${var.name}/probe/NEXT_PUBLIC_APP_URL" },
      { name = "RESEND_API_KEY", valueFrom = "${var.name}/probe/RESEND_API_KEY" },
      { name = "ALERT_EMAIL_FROM", valueFrom = "${var.name}/probe/ALERT_EMAIL_FROM" },
    ]

    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:4100/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 15
      timeout     = 5
      retries     = 4
      startPeriod = 25
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "probe"
      }
    }
  }])
}

data "aws_region" "current" {}

resource "aws_ecs_service" "this" {
  name            = local.family
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  tags            = var.tags

  # A probe that is draining still holds in-flight checks; stopping it abruptly
  # produces a missing regional verdict and weakens that cycle's quorum.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = true
  }
}

output "service_name" { value = aws_ecs_service.this.name }
output "cluster_arn" { value = aws_ecs_cluster.this.arn }
output "log_group" { value = aws_cloudwatch_log_group.this.name }
