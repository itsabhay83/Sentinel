locals {
  name = "${var.project}-${var.environment}"

  tags = merge({
    "app.kubernetes.io/name" = var.project
    "sentinel:environment"   = var.environment
    "sentinel:managed-by"    = "terraform"
  }, var.tags)

  enabled_probe_regions = { for code, cfg in var.probe_regions : code => cfg if cfg.enabled }
}

data "aws_availability_zones" "control_plane" {
  state = "available"
}

module "network" {
  source = "./modules/network"

  name               = local.name
  cidr               = var.vpc_cidr
  availability_zones = slice(data.aws_availability_zones.control_plane.names, 0, 3)
  tags               = local.tags
}

module "registry" {
  source = "./modules/registry"

  name = local.name
  # One repository per image the Dockerfile produces.
  repositories = ["scheduler", "probe", "web"]
  tags         = local.tags
}

module "postgres" {
  source = "./modules/postgres"

  name                  = local.name
  subnet_ids            = module.network.private_subnet_ids
  vpc_id                = module.network.vpc_id
  allowed_cidr_blocks   = [var.vpc_cidr]
  engine_version        = var.postgres.engine_version
  instance_class        = var.postgres.instance_class
  allocated_storage_gb  = var.postgres.allocated_storage_gb
  max_storage_gb        = var.postgres.max_storage_gb
  multi_az              = var.postgres.multi_az
  backup_retention_days = var.postgres.backup_retention_days
  tags                  = local.tags
}

module "redis" {
  source = "./modules/redis"

  name                = local.name
  subnet_ids          = module.network.private_subnet_ids
  vpc_id              = module.network.vpc_id
  allowed_cidr_blocks = [var.vpc_cidr]
  engine_version      = var.redis.engine_version
  node_type           = var.redis.node_type
  replica_count       = var.redis.replica_count
  tags                = local.tags
}

# Probe compute, one module instance per region. The provider alias cannot be
# a for_each key, so each region is an explicit block.
module "probe_bom" {
  source    = "./modules/probe-region"
  providers = { aws = aws.bom }
  count     = contains(keys(local.enabled_probe_regions), "bom") ? 1 : 0

  name          = local.name
  region_code   = "bom"
  instance_type = var.probe_regions["bom"].instance_type
  desired_count = var.probe_regions["bom"].desired_count
  image_uri     = module.registry.repository_urls["probe"]
  tags          = local.tags
}

module "probe_sin" {
  source    = "./modules/probe-region"
  providers = { aws = aws.sin }
  count     = contains(keys(local.enabled_probe_regions), "sin") ? 1 : 0

  name          = local.name
  region_code   = "sin"
  instance_type = var.probe_regions["sin"].instance_type
  desired_count = var.probe_regions["sin"].desired_count
  image_uri     = module.registry.repository_urls["probe"]
  tags          = local.tags
}

module "probe_fra" {
  source    = "./modules/probe-region"
  providers = { aws = aws.fra }
  count     = contains(keys(local.enabled_probe_regions), "fra") ? 1 : 0

  name          = local.name
  region_code   = "fra"
  instance_type = var.probe_regions["fra"].instance_type
  desired_count = var.probe_regions["fra"].desired_count
  image_uri     = module.registry.repository_urls["probe"]
  tags          = local.tags
}

module "probe_lhr" {
  source    = "./modules/probe-region"
  providers = { aws = aws.lhr }
  count     = contains(keys(local.enabled_probe_regions), "lhr") ? 1 : 0

  name          = local.name
  region_code   = "lhr"
  instance_type = var.probe_regions["lhr"].instance_type
  desired_count = var.probe_regions["lhr"].desired_count
  image_uri     = module.registry.repository_urls["probe"]
  tags          = local.tags
}

module "probe_iad" {
  source    = "./modules/probe-region"
  providers = { aws = aws.iad }
  count     = contains(keys(local.enabled_probe_regions), "iad") ? 1 : 0

  name          = local.name
  region_code   = "iad"
  instance_type = var.probe_regions["iad"].instance_type
  desired_count = var.probe_regions["iad"].desired_count
  image_uri     = module.registry.repository_urls["probe"]
  tags          = local.tags
}

module "probe_sjc" {
  source    = "./modules/probe-region"
  providers = { aws = aws.sjc }
  count     = contains(keys(local.enabled_probe_regions), "sjc") ? 1 : 0

  name          = local.name
  region_code   = "sjc"
  instance_type = var.probe_regions["sjc"].instance_type
  desired_count = var.probe_regions["sjc"].desired_count
  image_uri     = module.registry.repository_urls["probe"]
  tags          = local.tags
}

module "probe_gru" {
  source    = "./modules/probe-region"
  providers = { aws = aws.gru }
  count     = contains(keys(local.enabled_probe_regions), "gru") ? 1 : 0

  name          = local.name
  region_code   = "gru"
  instance_type = var.probe_regions["gru"].instance_type
  desired_count = var.probe_regions["gru"].desired_count
  image_uri     = module.registry.repository_urls["probe"]
  tags          = local.tags
}

module "probe_syd" {
  source    = "./modules/probe-region"
  providers = { aws = aws.syd }
  count     = contains(keys(local.enabled_probe_regions), "syd") ? 1 : 0

  name          = local.name
  region_code   = "syd"
  instance_type = var.probe_regions["syd"].instance_type
  desired_count = var.probe_regions["syd"].desired_count
  image_uri     = module.registry.repository_urls["probe"]
  tags          = local.tags
}
