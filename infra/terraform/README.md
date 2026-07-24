# terraform-aws-fleetmind

Terraform module for [Fleetmind](https://github.com/Continuous-Agentics/fleetmind) — multi-bot fleet infrastructure on AWS.

Provisions a fleet of OpenClaw agent EC2 instances with a DynamoDB ContextStore, optional task-ledger primitives (DynamoDB single-table, S3 narratives bucket, IAM policies), per-agent IAM roles, VPC + endpoints, and security groups.

## Status

FleetMind's v1 AWS module baseline. Operators normally consume this module through [`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template). See the FleetMind [compatibility matrix](https://github.com/Continuous-Agentics/fleetmind/blob/main/docs/COMPATIBILITY.md) before upgrading a fleet.

> **Canonical location and provenance:** This directory is a mechanical, single-commit import of [`Continuous-Agentics/terraform-aws-fleetmind`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind) release [`v1.1.9`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind/releases/tag/v1.1.9) (commit `1894e065673fb1a4c00497e2e39fe5965d3798e6`). It deliberately does not import the standalone repository's Git graph. Historical releases and tags remain in the standalone repository. New consumers should use `github.com/Continuous-Agentics/fleetmind//infra/terraform` and pin a FleetMind release tag after this change is released.

## Module layout

```
terraform-aws-fleetmind/
├── main.tf, variables.tf, outputs.tf   # root: composition + cross-cutting locals
├── vpc.tf                              # VPC + endpoints via terraform-aws-modules/vpc/aws (BYO VPC supported)
├── dynamodb.tf                         # ContextStore table (gated on context_store_backend)
├── sg.tf                               # fleet security group
└── modules/
    ├── agent/                          # one bot: EC2 + IAM role + per-agent secrets
    └── task-ledger/                    # delegation substrate (DDB + S3 + IAM)
```

Networking is built on upstream [`terraform-aws-modules/vpc/aws`](https://github.com/terraform-aws-modules/terraform-aws-vpc) (pinned `~> 5.0`). BYO VPC is supported via `var.vpc_id` + the `existing_*_subnet_ids` pair.

## Consumer setup

Consumers configure their own `provider "aws"`, Terraform backend, and `default_tags` in their root module:

```hcl
terraform {
  required_version = ">= 1.5"

  backend "s3" {
    bucket         = "my-fleet-tfstate"
    region         = "us-west-2"
    dynamodb_table = "my-fleet-tfstate-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.fleet_name
      ManagedBy   = "terraform"
      Environment = "production"
    }
  }
}

module "fleetmind" {
  source = "github.com/Continuous-Agentics/fleetmind//infra/terraform?ref=main"

  fleet_name              = "my-fleet"
  aws_region              = "us-west-2"
  agent_names             = ["pm", "fe"]
  agent_orchestrators     = { pm = true, fe = false }
  agent_providers         = { pm = ["anthropic"], fe = ["anthropic"] }   # REQUIRED — explicit list of model providers per agent
  delegation_enabled      = true
  # ...see variables.tf for the full input surface
}
```

Use Terraform workspaces (`terraform workspace new <fleet-name>`) to isolate state per fleet — the backend `key` is intentionally not set so workspaces auto-prefix state files with `env:/<workspace>/`.

## ContextStore backend

`var.context_store_backend` (default `"dynamodb"`) selects the storage backend for the fleet's shared cross-agent key-value state. Today only `"dynamodb"` is supported — the agent runtime (`src/runtime/context.ts`) only speaks DynamoDB. The variable exists to set up a clean seam for future backends (e.g. `"rds"`) without an interface break.

## What this module manages

- VPC + subnets + endpoints (via upstream `terraform-aws-modules/vpc/aws` and `//modules/vpc-endpoints`; BYO VPC via `var.vpc_id`)
- Fleet security group
- Per-agent EC2 instances, IAM roles, and Secrets Manager placeholders (via `modules/agent/`, one call per agent). Model-provider API keys live in one Secrets Manager secret **per (agent, provider)** at `<fleet_name>/agents/<agent>/providers/<provider>`. Slack + hooks secrets remain at the existing `<fleet_name>/agents/<agent>/{slack,hooks}` paths.
- DynamoDB ContextStore table (when `context_store_backend = "dynamodb"`)
- *Optional* task-ledger submodule (`var.delegation_enabled = true`): DynamoDB tasks table, S3 narratives bucket, and PM/worker IAM policies. Terminal-state agent wake-ups are delivered over NATS push (the `fleetmind nats subscribe` units installed by the agent bootstrap), not an EventBridge Pipe/SSM Run Command wake pipeline (that path was removed).

## Inputs and outputs

Full surface in [`variables.tf`](variables.tf) and [`outputs.tf`](outputs.tf). Selected outputs:

- *Per-agent* (one entry each in the returned map, keyed by agent id):
  `instance_ids`, `private_ips`, `ssm_connect`, `agent_workspace_paths`, `agent_service_names`, `agent_iam_role_names`, `secrets_arns`
- *Networking:* `vpc_id`
- *ContextStore:* `context_store_backend`, `context_store_table_name`, `context_store_table_arn`
- *Deploy-staging bucket* (always created): `ledger_bucket_name`
- *Task-ledger* (empty/null when `delegation_enabled = false`):
  `task_ledger_table_name`, `task_ledger_s3_bucket`,
  `task_ledger_pm_policy_arn`, `task_ledger_worker_policy_arn`

> Note: `ledger_bucket_name` is the always-created deploy-staging bucket; `task_ledger_s3_bucket` is the same bucket *as exposed by the task-ledger submodule* and returns an empty string when delegation is disabled. Most consumers should use `ledger_bucket_name`.

## Operational controls

The module includes explicit controls for balancing safety vs. rollout speed:

- `agent_rollout_trigger`
- `nats_rollout_trigger`

AMI and bootstrap (`user_data`) drift is ignored by default to avoid surprise replacements on `terraform apply`.
To perform an intentional rollout, change either trigger value (for example from `"2026-05-27a"` to `"2026-05-27b"`) and apply.

NATS transport hardening options are also available:

- `nats_auth_token` (optional token auth)
- `nats_tls_enabled`
- `nats_tls_cert_pem`
- `nats_tls_key_pem`
- `nats_tls_ca_pem` (optional, for client cert verification)

When TLS is enabled, cert/key PEM values are written on host during bootstrap and referenced in `nats-server.conf`.

## CI checks

GitHub Actions runs Terraform quality and security checks on PRs and `main` pushes:

- `terraform fmt -check -recursive`
- `terraform init -backend=false`
- `terraform validate`
- `tflint --recursive`
- `tfsec`

## Operational runbook

### Rolling out bootstrap or AMI changes

By default, AMI and bootstrap (`user_data`) drift is **ignored** to prevent surprise instance replacements on apply.

To perform an intentional rollout:

1. Update the rollout trigger token in your `fleet.tfvars`:

```hcl
# Bump this whenever you want to roll out changes to agents
agent_rollout_trigger = "2026-05-27-rollout-v1"

# Bump this whenever you want to roll out changes to the NATS server
nats_rollout_trigger = "2026-05-27-rollout-v1"
```

2. Apply:

```bash
terraform apply -var-file=fleet.tfvars
```

Terraform will replace the affected EC2 instances. Use `-target` to test on a single agent first:

```bash
terraform apply -target=module.agent[\"agent_name\"] -var-file=fleet.tfvars
```

### Enabling NATS token authentication and TLS

NATS defaults to VPC-internal, unauthenticated access. For production, enable both:

```hcl
nats_auth_token   = "YOUR_RANDOM_TOKEN_HERE"  # Or generate: $(openssl rand -hex 32)
nats_tls_enabled  = true
nats_tls_cert_pem = file("${path.module}/certs/nats-server.crt")
nats_tls_key_pem  = file("${path.module}/certs/nats-server.key")
# Optional: require client cert verification
nats_tls_ca_pem   = file("${path.module}/certs/ca.crt")
```

Once enabled:
- Agents automatically use the token and TLS when connecting to NATS.
- Token is passed via secret injection; verify with: `aws secretsmanager get-secret-value --secret-id <fleet_name>/agents/<agent_id>/gateway --region <region>`
- Test connectivity: `nats -s nats://nats.<fleet_name>.internal:4222 --token <token> sub '>'` (from an agent instance)

### Recovering or replacing the NATS instance

The NATS server is stateless (no JetStream) — agents cache fleet config locally. Recovery is straightforward:

**Option 1: Planned replacement** (minimal downtime, ~2 min per agent):
1. Bump `nats_rollout_trigger` in tfvars.
2. Run `terraform apply`.
3. Agents will detect NATS unavailable, wait up to 2 minutes for it to come back online, then start normally.

**Option 2: Immediate emergency replacement**:
1. Terminate the NATS EC2 instance manually: `aws ec2 terminate-instances --instance-ids <instance-id> --region <region>`
2. Agents will fail over after ~10 seconds (DNS TTL expires).
3. Run `terraform apply` to spin up a new NATS instance.

**Option 3: Inspect NATS logs before replacement**:
```bash
aws ssm start-session --target <nats-instance-id> --region <region>
# Inside the instance:
journalctl -u nats -n 100 --no-pager
cat /var/log/nats-bootstrap.log
```

After any NATS replacement, verify agent subscribers are running:
```bash
# On any agent instance:
systemctl status fleetmind-nats-<agent_id>.service
journalctl -u fleetmind-nats-<agent_id> -n 20 --no-pager
```

## Docs

- [`docs/EXISTING-VPC.md`](docs/EXISTING-VPC.md) — deploying into an existing VPC (BYO VPC mode), requirements, current interface-endpoints limitation.
- [`docs/TASK-LEDGER-STANDALONE.md`](docs/TASK-LEDGER-STANDALONE.md) — calling `modules/task-ledger/` directly from your own Terraform root, for callers who don't want the full fleetmind EC2/VPC stack.
- [`docs/MODULE-TROUBLESHOOTING.md`](docs/MODULE-TROUBLESHOOTING.md) — IaC-side failures: state lock recovery, derived.tfvars propagation, per-agent taint/replace, DLQ inspection, `secret_recovery_window_days` gotchas.
- [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md) — per-version upgrade notes.

## License

MIT. See [LICENSE](LICENSE).
