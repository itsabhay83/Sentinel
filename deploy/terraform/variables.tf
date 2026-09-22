variable "project" {
  description = "Name prefix applied to every managed resource."
  type        = string
  default     = "sentinel"
}

variable "environment" {
  description = "Deployment environment (staging, production)."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be one of: staging, production."
  }
}

variable "control_plane_region" {
  description = "Cloud region hosting Postgres, Redis, the registry, web and the scheduler."
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR for the control-plane VPC."
  type        = string
  default     = "10.40.0.0/16"
}

# The probe fleet. Region codes are the same eight that packages/shared/src/
# regions.ts knows about; REGION_CODE on a probe must be one of these keys.
variable "probe_regions" {
  description = "Probe region code -> placement and sizing."
  type = map(object({
    cloud_region  = string
    instance_type = string
    desired_count = number
    enabled       = bool
  }))

  default = {
    bom = { cloud_region = "ap-south-1", instance_type = "t4g.small", desired_count = 2, enabled = true }
    sin = { cloud_region = "ap-southeast-1", instance_type = "t4g.small", desired_count = 2, enabled = true }
    fra = { cloud_region = "eu-central-1", instance_type = "t4g.small", desired_count = 2, enabled = true }
    lhr = { cloud_region = "eu-west-2", instance_type = "t4g.small", desired_count = 2, enabled = true }
    iad = { cloud_region = "us-east-1", instance_type = "t4g.small", desired_count = 3, enabled = true }
    sjc = { cloud_region = "us-west-1", instance_type = "t4g.small", desired_count = 2, enabled = true }
    gru = { cloud_region = "sa-east-1", instance_type = "t4g.small", desired_count = 2, enabled = true }
    syd = { cloud_region = "ap-southeast-2", instance_type = "t4g.small", desired_count = 2, enabled = true }
  }

  validation {
    condition = alltrue([
      for code in keys(var.probe_regions) :
      contains(["bom", "sin", "fra", "lhr", "iad", "sjc", "gru", "syd"], code)
    ])
    error_message = "probe_regions keys must be known Sentinel region codes."
  }
}

variable "postgres" {
  description = "Managed Postgres sizing."
  type = object({
    engine_version        = string
    instance_class        = string
    allocated_storage_gb  = number
    max_storage_gb        = number
    multi_az              = bool
    backup_retention_days = number
  })

  default = {
    engine_version = "16.4"
    instance_class = "db.m6g.large"
    # The `checks` table is monthly-partitioned and grows fast; autoscaling
    # storage is what keeps a retention misconfiguration from becoming an outage.
    allocated_storage_gb  = 200
    max_storage_gb        = 2000
    multi_az              = true
    backup_retention_days = 14
  }
}

variable "redis" {
  description = "Managed Redis sizing. Holds BullMQ queues, the leader lock and rate limits."
  type = object({
    engine_version = string
    node_type      = string
    replica_count  = number
  })

  default = {
    engine_version = "7.1"
    node_type      = "cache.m6g.large"
    replica_count  = 1
  }
}

variable "tags" {
  description = "Tags merged onto every resource."
  type        = map(string)
  default     = {}
}
