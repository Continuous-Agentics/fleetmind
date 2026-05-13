# Terraform Module-Readiness Audit — 2026-05-13

Audit of `infra/terraform/` to identify what must change before it can be consumed as a Terraform module from the `fleetmind-template` repo (issue #26).

The goal: a consumer in `fleetmind-template` writes

```hcl
module "fleetmind" {
  source  = "github.com/Continuous-Agentics/fleetmind//infra/terraform?ref=v0.4.4"
  fleet_name              = var.fleet_name
  agent_names             = var.agent_names
  agent_orchestrators     = var.agent_orchestrators
  wake_target_session_key = var.wake_target_session_key
  # ...
}
```

and gets a working fleet without forking the TF code.

This audit identifies the gaps. Implementation lands in a separate PR (not tonight).

## Current state

23 variables in `variables.tf` covering the primary input surface (fleet identity, networking, sizing, software pins, delegation toggle). 9 outputs covering instance IDs, IPs, SSM commands, workspace paths, secrets ARNs, VPC ID, task-ledger table/bucket. Module-aware structure is mostly there already.

## Blockers — must change for module consumption

### Blocker 1: Provider block lives inside the module

`main.tf:35` contains a `provider "aws" {}` block. Terraform modules **must not** declare providers — consumers configure providers and modules inherit. Today this works only because we apply directly from `infra/terraform/` as a top-level project.

**Fix:** Move the `provider "aws" { ... default_tags { ... } }` block from `main.tf` into a new top-level file (e.g. `provider.example.tf`) that ships *outside* the module. Consumers copy it into their own root config. The module's `main.tf` retains the `terraform { required_providers { aws = ... } }` block (which is correct — modules declare *required* providers, just not *configurations*).

### Blocker 2: Backend block lives inside the module

Already an empty partial config (`backend "s3" { encrypt = true }`). Same migration: consumers own backend configuration, so this block also moves out of the module's `main.tf`. The `backend.example.hcl` we ship today is operator-facing and stays.

### Blocker 3: Hardcoded values that should be operator-tunable

| Location | Current | Should be | Notes |
|----------|---------|-----------|-------|
| `rds.tf:31`, `secrets.tf:21`, `secrets.tf:44` | `recovery_window_in_days = 7` | `var.secret_recovery_window_days` | Different operators have different deletion/recovery policies |
| `modules/task-ledger/main.tf:621` | `batch_size = 1` (Pipe) | `var.pipe_batch_size` | Cheap fix, useful tuning knob |
| `modules/task-ledger/main.tf:628` | `maximum_retry_attempts = 3` (Pipe) | `var.pipe_retry_attempts` | Same |
| `modules/task-ledger/main.tf:713` | `maximum_retry_attempts = 2` (event-rule retry) | `var.event_rule_retry_attempts` | Same |

The submodule's `noncurrent_version_expiration_days` already a variable — good model.

**Fix (smallest):** add `var.secret_recovery_window_days` (default 7) and use it in all 3 secrets-tf locations. Task-ledger submodule tuning is deferred (lower priority).

## Non-blockers — clean wins to do alongside

### Clean win 1: `default_tags` propagation through the module

Today the provider's `default_tags` includes `{ Project = var.fleet_name, ManagedBy = "terraform" }`. When the provider moves to the consumer, the consumer also configures default_tags. We should *document this in the module's README* so consumers know to set those tags themselves.

### Clean win 2: Outputs.tf gap for `agent_iam_role_names`

The agent IAM role names are referenced from the consumer side (in `agent_orchestrators` / `agent_models` lookups). We currently expose `instance_ids` and `private_ips` but not `agent_iam_role_names` — useful if a consumer wants to attach additional policies to per-agent roles after `terraform apply`.

**Fix:** add an output:
```hcl
output "agent_iam_role_names" {
  description = "IAM role name per agent (suitable for attaching additional policies)."
  value       = { for k, v in aws_iam_role.agent : k => v.name }
}
```

### Clean win 3: Drop the redundant `random` provider declaration

`main.tf` requires `random ~> 3.0` but a grep finds no `random_*` resources in use. Either the provider was used historically or is reserved for future work.

**Fix:** confirm via `terraform validate` after removing, and drop if unused. (Defer until module refactor PR — touching `required_providers` is a minor breaking change for downstream tagged consumers.)

## Doc updates required when the refactor lands

- `docs/MULTI-FLEET.md` — replace "clone fleetmind, run terraform from `infra/terraform/`" with module-consumption pattern
- `docs/SETUP-A-FLEET.md` — replace section 3.4 ("Configure local Terraform backend") with the consumer-side `main.tf` example showing the `module "fleetmind"` block
- `infra/terraform/README.md` — describe what consumers need to provide (provider, backend) and what the module surfaces (variables, outputs)
- New `infra/terraform/MIGRATION.md` — for operators on the direct-apply pattern, document the migration path

## Recommended cut

Tonight: file this audit, file the small prep PR that adds `var.secret_recovery_window_days` + the `agent_iam_role_names` output (zero behavior change, clean wins).

Next session: full refactor — move provider/backend out, finalize tag `v0.5.0`, then create `fleetmind-template` repo and stand up a third fleet via module consumption to validate.

Filed alongside issue #26.
