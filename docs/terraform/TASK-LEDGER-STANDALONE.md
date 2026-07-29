# Standalone task-ledger consumption

`infra/terraform/modules/fleetmind/modules/task-ledger/` provisions the delegation substrate: DynamoDB table, S3 narrative-bucket IAM access, and PM/worker/reader IAM policies. It is normally activated by the embedded FleetMind root module through `delegation_enabled = true`. Terminal task events reach the PM over NATS push; the submodule creates no wake infrastructure.

This document covers calling the submodule directly when you need delegation infrastructure without the rest of the FleetMind EC2/VPC/security-group stack. If you use `infra/terraform`, set `delegation_enabled = true` in your tfvars instead.

## Consuming Terraform root

```hcl
# my-fleet-infra/main.tf

terraform {
  required_version = ">= 1.5.0"

  backend "s3" {
    bucket  = "my-terraform-state"
    key     = "my-fleet/task-ledger.tfstate"
    region  = "us-west-2"
    encrypt = true
  }

  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = "us-west-2"
}

module "task_ledger" {
  # Replace <FleetMind release tag> with a published FleetMind release that
  # includes this consolidation.
  source = "github.com/Continuous-Agentics/fleetmind//infra/terraform/modules/fleetmind/modules/task-ledger?ref=<FleetMind release tag>"

  name_prefix = "my-fleet-"

  # Existing IAM role names (created by your bot EC2 module).
  pm_role_names     = ["my-fleet-pm-bot-role"]
  worker_role_names = ["my-fleet-worker-bot-role"]

  # S3 narratives bucket (name + ARN). The submodule does NOT create the
  # bucket — pass in one you manage (the root module creates it in s3.tf
  # and forwards both values).
  s3_bucket_name = "my-fleet-ledger-narratives"
  s3_bucket_arn  = "arn:aws:s3:::my-fleet-ledger-narratives"

  tags = { product = "my-fleet", env = "production" }
}

output "table_name"    { value = module.task_ledger.table_name }
output "s3_bucket"     { value = module.task_ledger.s3_bucket_name }
output "pm_policy"     { value = module.task_ledger.pm_policy_arn }
output "worker_policy" { value = module.task_ledger.worker_policy_arn }
```

```bash
cd my-fleet-infra
terraform init
terraform plan
terraform apply
```

`table_name` and `s3_bucket` feed into the consuming fleet's `fleet.yaml` `delegation:` block (or equivalent agent runtime config).

## Inputs (selected)

| Input | Required | Default | Notes |
|---|---|---|---|
| `name_prefix` | no | `"fleetmind-"` | Prefix for created resources: `<prefix>tasks` (DDB), `<prefix>pm-task-ledger-readwrite` / `<prefix>worker-task-ledger-readwrite` / `<prefix>reader-task-ledger-readonly` (IAM policies). |
| `pm_role_names` | no | `[]` | IAM role names granted PM-side access (read+write all tasks, write narratives). |
| `worker_role_names` | no | `[]` | IAM role names granted worker-side access (PutItem for self-start rows, UpdateItem lifecycle transitions, write task `.md` files, read all). |
| `s3_bucket_name` | yes | — | Narrative-content bucket. Not created by the submodule. |
| `s3_bucket_arn` | yes | — | Matching ARN, passed in to avoid a same-apply data lookup race. |
| `tags` | no | `{}` | Applied to all created resources. |

See [`modules/task-ledger/variables.tf`](../modules/task-ledger/variables.tf) for the full surface.

## Outputs

| Output | Purpose |
|---|---|
| `table_name` | DynamoDB tasks table name → `delegation.table_name`. |
| `s3_bucket_name` | S3 narratives bucket → `delegation.s3_bucket`. |
| `table_arn` | DynamoDB tasks table ARN. |
| `s3_bucket_arn` | S3 narratives bucket ARN (echoed from input). |
| `pm_policy_arn` | Attach to PM's IAM role if not passed via `pm_role_names`. |
| `worker_policy_arn` | Same for workers. |
| `reader_policy_arn` | Read-only ledger policy; not attached by the module — attach to humans/read-only skills as needed. |

## Terminal-event delivery (NATS push)

```
Worker writes terminal status (shipped|blocked|abandoned|merged)
  -> fleetmind publishes the terminal event to NATS
  -> PM's `fleetmind nats subscribe --mode pm` systemd unit receives it
  -> the subscriber wakes the PM's live session directly
```

NATS subscriber units are installed on each agent EC2 by agent bootstrap (`modules/agent/user_data/agent_bootstrap.sh.tpl`, STAGE 14). The session key is derived at wake time from the live event, not baked into Terraform — this submodule needs no wake-target input.

## Related

- Root module overview: [`README.md`](../README.md)
- Existing-VPC deployment: [`EXISTING-VPC.md`](./EXISTING-VPC.md)
- Module-level troubleshooting: [`MODULE-TROUBLESHOOTING.md`](./MODULE-TROUBLESHOOTING.md)
- Agent-runtime side of delegation (fleet.yaml schema, protocol): [fleetmind/docs/integration/delegation.md](https://github.com/Continuous-Agentics/fleetmind/blob/main/docs/integration/delegation.md) (private — requires Carpe access)
