terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Configure a real backend in your fleet root, for example:
  # backend "s3" {
  #   bucket         = "my-fleet-tfstate"
  #   key            = "fleets/example/terraform.tfstate"
  #   region         = "us-west-2"
  #   dynamodb_table = "my-fleet-tfstate-lock"
  #   encrypt        = true
  # }
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
  agent_names = ["orchestrator", "worker"]

  agent_orchestrators = {
    orchestrator = true
    worker       = false
  }

  agent_providers = {
    orchestrator = ["anthropic"]
    worker       = ["anthropic"]
  }

  delegation_enabled = true
}
