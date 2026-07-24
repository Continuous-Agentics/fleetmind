# Starter plan-time test suite for the FleetMind root module.
#
# Scope: catches configuration-level regressions (bad interpolations,
# resource wiring, count/for_each mistakes) via `terraform plan` against a
# mocked "aws" provider. No AWS credentials are used or required for the test
# runs; CI still needs network access during `terraform init` to download the
# registry providers/modules unless a mirror/cache is configured.
#
# Deliberately NOT covered here (would need `command = apply` against a real
# or fake backend, real credentials, or a much heavier mocking setup):
#   - actual resource attribute values returned by AWS
#   - drift/apply behavior
#   - the nats/task-ledger submodules' internal logic in isolation
# Expand this suite incrementally as regressions are found, rather than
# trying to reach full coverage in one pass.

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b"]
    }
  }

  mock_data "aws_ami" {
    defaults = {
      id = "ami-0123456789abcdef0"
    }
  }

  mock_data "aws_vpc" {
    defaults = {
      cidr_block = "10.0.0.0/16"
    }
  }
}

variables {
  fleet_name  = "test-fleet"
  agent_names = ["orchestrator", "worker"]
  agent_providers = {
    orchestrator = ["anthropic"]
    worker       = ["anthropic"]
  }
  agent_orchestrators = {
    orchestrator = true
  }
}

# Default configuration: created VPC, NATS enabled, delegation enabled.
run "default_plan_succeeds" {
  command = plan
}

# BYO-VPC path: exercises the existing_private_subnet_ids validation branch
# and the round-robin subnet assignment logic in main.tf.
run "byo_vpc_plan_succeeds" {
  command = plan

  variables {
    vpc_id                      = "vpc-0123456789abcdef0"
    existing_private_subnet_ids = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  }
}

# Single-agent, no-delegation, no-NATS path: exercises the `count.index == 0`
# submodule gating (module.task_ledger, module.nats) and confirms the module
# still plans cleanly with those features fully disabled.
run "minimal_fleet_plan_succeeds" {
  command = plan

  variables {
    agent_names         = ["solo"]
    agent_providers     = { solo = ["anthropic"] }
    agent_orchestrators = {}
    delegation_enabled  = false
    nats_enabled        = false
  }
}

# Created-VPC path with interface endpoints enabled: exercises the optional
# endpoint security group and vpc-endpoints submodule wiring without real AWS.
run "interface_endpoints_plan_succeeds" {
  command = plan

  variables {
    enable_interface_endpoints = true
  }
}
