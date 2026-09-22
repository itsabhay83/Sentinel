provider "aws" {
  region = var.control_plane_region

  default_tags {
    tags = local.tags
  }
}

# Probe regions need one aliased provider each: a single provider block cannot
# create resources in eight regions. Terraform requires provider aliases to be
# static, so these are written out rather than generated from var.probe_regions.
provider "aws" {
  alias  = "bom"
  region = "ap-south-1"
  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "sin"
  region = "ap-southeast-1"
  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "fra"
  region = "eu-central-1"
  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "lhr"
  region = "eu-west-2"
  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "iad"
  region = "us-east-1"
  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "sjc"
  region = "us-west-1"
  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "gru"
  region = "sa-east-1"
  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "syd"
  region = "ap-southeast-2"
  default_tags {
    tags = local.tags
  }
}
