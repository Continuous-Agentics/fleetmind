terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.fleet_name
      ManagedBy   = "terraform"
      Environment = "example"
    }
  }
}

module "fleetmind" {
  source = "../.."

  fleet_name  = var.fleet_name
  aws_region  = var.aws_region
  agent_names = ["solo"]

  agent_orchestrators = {}
  agent_providers = {
    solo = ["anthropic"]
  }

  vpc_id                      = var.vpc_id
  existing_private_subnet_ids = var.existing_private_subnet_ids

  delegation_enabled = false
  nats_enabled       = false
}
