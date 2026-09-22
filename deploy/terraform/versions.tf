terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Configure out of band: `terraform init -backend-config=backend.hcl`.
  # The bucket and lock table must exist before the first apply.
  backend "s3" {}
}
