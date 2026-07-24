# Standalone task-ledger consumption

The `modules/task-ledger/` submodule provisions the delegation substrate (DynamoDB table, S3 narratives bucket IAM access, and PM/worker/reader IAM policies). It's normally activated by the root `terraform-aws-fleetmind` module whenever `delegation_enabled = true` — that's the canonical path used by `fleetmind-template`.

> **Note:** There is no longer an EventBridge Pipe / SSM Run Command wake pipeline. Terminal task events reach the PM over NATS push (the `fleetmind nats subscribe` systemd units installed by the agent bootstrap). The submodule no longer creates wake infrastructure.

This doc covers calling the submodule **directly** from your own Terraform root. Use this when:
- You're integrating delegation into a fleet that doesn't use `fleetmind-template` or the root module.
- You want delegation infra without the rest of the fleetmind EC2/VPC/SG stack (e.g. you already manage agent EC2s yourself).

If you're using `fleetmind-template`, skip this doc — set `delegation_enabled = true` in your tfvars and you're done.

---

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
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-west-2"
}

module "task_ledger" {
  source = "github.com/Continuous-Agentics/fleetmind//infra/terraform/modules/task-ledger?ref=terraform-aws-fleetmind/v1.1.10"

  name_prefix = "my-fleet-"

  # Existing IAM role names (created by your bot EC2 module).
  pm_role_names     = ["my-fleet-pm-bot-role"]
  worker_role_names = ["my-fleet-worker-bot-role"]

  # S3 narratives bucket (name + ARN). The submodule does NOT create the
  # bucket — pass in one you manage. The root module creates it at s3.tf and
  # forwards both values; standalone, reference your own bucket resource:
  #   s3_bucket_name = aws_s3_bucket.my_ledger.bucket
  #   s3_bucket_arn  = aws_s3_bucket.my_ledger.arn
  s3_bucket_name = "my-fleet-ledger-narratives"
  s3_bucket_arn  = "arn:aws:s3:::my-fleet-ledger-narratives"

  tags = {
    product = "my-fleet"
    env     = "production"
  }
}

output "table_name"    { value = module.task_ledger.table_name }
output "s3_bucket"     { value = module.task_ledger.s3_bucket_name }
output "pm_policy"     { value = module.task_ledger.pm_policy_arn }
output "worker_policy" { value = module.task_ledger.worker_policy_arn }
```

Apply:

```bash
cd my-fleet-infra
terraform init
terraform plan
terraform apply
```

Note the `table_name` and `s3_bucket` outputs — they feed into the consuming fleet's `fleet.yaml` `delegation:` block (or equivalent agent runtime config).

---

## Inputs (selected)

| Input | Required | Default | Notes |
|---|---|---|---|
| `name_prefix` | no | `"fleetmind-"` | Prefix for all created resources. The variable itself doesn't enforce a trailing `-`, but ending with one produces readable resource names (`fleetmind-tasks` vs `fleetmindtasks`). Resources: `<prefix>tasks` (DDB), `<prefix>pm-task-ledger-readwrite` / `<prefix>worker-task-ledger-readwrite` / `<prefix>reader-task-ledger-readonly` (IAM policies). |
| `pm_role_names` | no | `[]` | IAM role names that should be granted PM-side ledger access (read+write all tasks, write narratives). |
| `worker_role_names` | no | `[]` | IAM role names that should be granted worker-side ledger access (PutItem for self-start rows, UpdateItem lifecycle transitions, write task `.md` files, read all). |
| `s3_bucket_name` | yes | — | S3 bucket name for narrative content. The submodule does not create the bucket; pass in one you manage. |
| `s3_bucket_arn` | yes | — | S3 bucket ARN, matching `s3_bucket_name`. Passed in to avoid a same-apply data lookup race. |
| `tags` | no | `{}` | Applied to all module-created resources. |

See [`modules/task-ledger/variables.tf`](../modules/task-ledger/variables.tf) for the full input surface.

There are **no** `aws_region` or `alert_email` inputs — those belonged to the removed EventBridge Pipe / SSM Run Command wake pipeline. Terminal task events are delivered to the PM over NATS push.

---

## Outputs

| Output | Purpose |
|---|---|
| `table_name` | DynamoDB tasks table name. Feed into your agent runtime's `delegation.table_name`. |
| `s3_bucket_name` | S3 narratives bucket. Feed into your agent runtime's `delegation.s3_bucket`. |
| `table_arn` | DynamoDB tasks table ARN. |
| `s3_bucket_arn` | S3 narratives bucket ARN (echoed back from input). |
| `pm_policy_arn` | Attach to PM bot's IAM role if you didn't pass it via `pm_role_names`. |
| `worker_policy_arn` | Same for workers. |
| `reader_policy_arn` | Read-only ledger policy. Not attached by the module — attach to humans / read-only skills as needed. |

---

## Terminal-event delivery (NATS push)

This submodule no longer wires a wake pipeline. The earlier EventBridge Pipe ->
EventBridge rule -> SSM Run Command -> `ddb-wake.sh` path (with its two DLQs and
CloudWatch alarms) was removed.

Terminal task events now reach the PM over NATS push:

```
Worker writes terminal status (shipped|blocked|abandoned|merged)
  -> fleetmind publishes the terminal event to NATS
  -> PM's `fleetmind nats subscribe --mode pm` systemd unit receives it
  -> the subscriber wakes the PM's live session directly
```

The NATS subscriber units are installed on each agent EC2 by the agent
bootstrap (see `modules/agent/user_data/agent_bootstrap.sh.tpl`, STAGE 14). The
session key the subscriber wakes is derived at wake time from the live event,
not baked into Terraform. Nothing in this submodule needs a wake-target
input.

---

## Related

- Root module overview: [`README.md`](../README.md)
- Existing-VPC deployment: [`EXISTING-VPC.md`](./EXISTING-VPC.md)
- Module-level troubleshooting (state lock, taint, DLQ recovery): [`MODULE-TROUBLESHOOTING.md`](./MODULE-TROUBLESHOOTING.md)
- Agent-runtime side of delegation (fleet.yaml schema, protocol): see [fleetmind/docs/integration/delegation.md](https://github.com/Continuous-Agentics/fleetmind/blob/main/docs/integration/delegation.md) (private — requires Carpe access)
