# FleetMind Terraform module

Terraform module for [Fleetmind](https://github.com/Continuous-Agentics/fleetmind) — multi-bot fleet infrastructure on AWS.

Provisions a fleet of OpenClaw agent EC2 instances with a DynamoDB ContextStore, optional task-ledger primitives (DynamoDB single-table, S3 narratives bucket, IAM policies), per-agent IAM roles, VPC + endpoints, and security groups.

## Status

FleetMind's v1 AWS module baseline. Operators normally consume this module through [`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template). See the FleetMind [compatibility matrix](https://github.com/Continuous-Agentics/fleetmind/blob/main/docs/COMPATIBILITY.md) before upgrading a fleet.

## Module layout

```
FleetMind Terraform module/
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
  source = "github.com/Continuous-Agentics/FleetMind Terraform module?ref=v1.1.1"

  fleet_name              = "my-fleet"
  aws_region              = "us-west-2"
  agent_names             = ["pm", "fe"]
  agent_orchestrators     = { pm = true, fe = false }
  agent_providers         = { pm = ["anthropic"], fe = ["anthropic"] }   # REQUIRED — explicit list of model providers per agent
  delegation_enabled      = true
  # ...see variables.tf for the full input surface
}
```

**Recommended: explicit per-fleet root stacks with explicit backend keys.** Give each fleet its own state by setting a distinct `key` in the consumer's `backend "s3"` block, for example `key = "fleets/<fleet-name>/terraform.tfstate"`. Do this either by maintaining a separate root module directory per fleet (e.g. `fleets/<fleet-name>/main.tf`, each with its own hardcoded `backend "s3" { key = ... }`), or with a single root module plus a small wrapper (`terraform init -backend-config="key=fleets/<fleet-name>/terraform.tfstate" -reconfigure`) driven per-fleet from CI/CD. Explicit keys make each fleet's state independently discoverable in the S3 console/CLI, make CI logs and IAM/bucket policies easier to reason about, and avoid relying on the operator's currently selected CLI workspace.

**CLI workspaces (`terraform workspace new <fleet-name>`) are supported only as an optional, ephemeral/dev-only variant** — quick to spin up for a scratch fleet or local experiment, where the backend `key` is left unset so workspaces auto-prefix state under `env:/<workspace>/`. Don't use bare workspaces for anything you intend to keep around or run in CI: it's easy to `terraform workspace select` the wrong fleet and apply against the wrong state, and workspace-derived state paths are less explicit in reviews and runbooks. If you're currently on workspaces and want to move to explicit keys, see ["Migrating from CLI workspaces to explicit backend keys"](MODULE-TROUBLESHOOTING.md#migrating-from-cli-workspaces-to-explicit-backend-keys) in `MODULE-TROUBLESHOOTING.md`.

## ContextStore backend

`var.context_store_backend` (default `"dynamodb"`) selects the storage backend for the fleet's shared cross-agent key-value state. Today only `"dynamodb"` is supported — the agent runtime (`src/runtime/context.ts`) only speaks DynamoDB. The variable exists to set up a clean seam for future backends (e.g. `"rds"`) without an interface break.

## What this module manages

- VPC + subnets + endpoints (via upstream `terraform-aws-modules/vpc/aws` and `//modules/vpc-endpoints`; BYO VPC via `var.vpc_id`)
- Fleet security group
- Per-agent EC2 instances, IAM roles, and Secrets Manager placeholders (via `modules/agent/`, one call per agent). Model-provider API keys live in one Secrets Manager secret **per (agent, provider)** at `<fleet_name>/agents/<agent>/providers/<provider>`. Slack + hooks secrets remain at the existing `<fleet_name>/agents/<agent>/{slack,hooks}` paths.
- DynamoDB ContextStore table (when `context_store_backend = "dynamodb"`)
- *Optional* task-ledger submodule (`var.delegation_enabled = true`): DynamoDB tasks table, S3 narratives bucket, and PM/worker IAM policies. Terminal-state agent wake-ups are delivered over NATS push (the `fleetmind nats subscribe` units installed by the agent bootstrap), not an EventBridge Pipe/SSM Run Command wake pipeline (that path was removed).

## Examples

- [`examples/basic`](examples/basic.md) — two-agent fleet with module-managed VPC, NATS, ContextStore, deploy-staging bucket, and task-ledger substrate. The executable example is at [`infra/terraform/examples/basic/`](../../infra/terraform/examples/basic/).
- [`examples/existing-vpc`](examples/existing-vpc.md) — smallest BYO-VPC footprint for an existing private subnet layout. The executable example is at [`infra/terraform/examples/existing-vpc/`](../../infra/terraform/examples/existing-vpc/).

## Requirements, providers, resources, inputs, and outputs

The API reference below is generated by [`terraform-docs`](https://terraform-docs.io/) from `.terraform-docs.yml`. Run `terraform-docs .` before opening a PR that changes variables, outputs, providers, modules, or resources.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.5 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | ~> 5.0 |
## Providers

| Name | Version |
|------|---------|
| <a name="provider_aws"></a> [aws](#provider\_aws) | 5.100.0 |
## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_agent"></a> [agent](#module\_agent) | ./modules/agent | n/a |
| <a name="module_nats"></a> [nats](#module\_nats) | ./modules/nats | n/a |
| <a name="module_task_ledger"></a> [task\_ledger](#module\_task\_ledger) | ./modules/task-ledger | n/a |
| <a name="module_vpc"></a> [vpc](#module\_vpc) | terraform-aws-modules/vpc/aws | ~> 5.0 |
| <a name="module_vpc_endpoints"></a> [vpc\_endpoints](#module\_vpc\_endpoints) | terraform-aws-modules/vpc/aws//modules/vpc-endpoints | ~> 5.0 |
## Resources

| Name | Type |
|------|------|
| [aws_dynamodb_table.context_store](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dynamodb_table) | resource |
| [aws_iam_policy.deploy_staging_read](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) | resource |
| [aws_iam_role_policy_attachment.deploy_staging_read](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy_attachment) | resource |
| [aws_s3_bucket.ledger](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket) | resource |
| [aws_s3_bucket_lifecycle_configuration.ledger](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_lifecycle_configuration) | resource |
| [aws_s3_bucket_ownership_controls.ledger](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_ownership_controls) | resource |
| [aws_s3_bucket_policy.ledger](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_policy) | resource |
| [aws_s3_bucket_public_access_block.ledger](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_public_access_block) | resource |
| [aws_s3_bucket_server_side_encryption_configuration.ledger](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_server_side_encryption_configuration) | resource |
| [aws_s3_bucket_versioning.ledger](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_versioning) | resource |
| [aws_security_group.fleet](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/security_group) | resource |
| [aws_security_group.vpc_endpoints](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/security_group) | resource |
| [aws_service_discovery_private_dns_namespace.fleet](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/service_discovery_private_dns_namespace) | resource |
| [aws_ami.al2023](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/ami) | data source |
| [aws_availability_zones.available](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/availability_zones) | data source |
| [aws_iam_policy_document.deploy_staging_read](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_iam_policy_document.ledger_bucket_policy](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_vpc.existing](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/vpc) | data source |
## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_agent_instance_types"></a> [agent\_instance\_types](#input\_agent\_instance\_types) | Per-agent EC2 instance type overrides (map of agent\_id → instance\_type). Falls back to var.instance\_type for any agent not listed. | `map(string)` | `{}` | no |
| <a name="input_agent_names"></a> [agent\_names](#input\_agent\_names) | List of agent names. Each gets its own EC2 instance, IAM role, and per-agent secrets. Must be non-empty and unique. | `list(string)` | <pre>[<br/>  "orchestrator",<br/>  "pixel",<br/>  "forge"<br/>]</pre> | no |
| <a name="input_agent_orchestrators"></a> [agent\_orchestrators](#input\_agent\_orchestrators) | Map of agent\_id → bool indicating which agents are PM/orchestrator bots. Used by the task-ledger module to split IAM policy attachments: orchestrators get the pm policy; non-orchestrators get the worker policy. | `map(bool)` | `{}` | no |
| <a name="input_agent_providers"></a> [agent\_providers](#input\_agent\_providers) | REQUIRED. Map of agent\_id → list of lowercase model-provider tokens (e.g. {ranger = ["anthropic"], copilot = ["anthropic", "openai"]}). Drives per-provider Secrets Manager secrets at <fleet\_name>/agents/<agent>/providers/<provider>. Explicit declaration is required — there is no inference from model strings. Every name in var.agent\_names must have an entry with at least one provider. | `map(list(string))` | n/a | yes |
| <a name="input_agent_rollout_trigger"></a> [agent\_rollout\_trigger](#input\_agent\_rollout\_trigger) | Arbitrary rollout token for agent instances. Change this value to force replacement when user\_data/AMI changes are otherwise ignored. | `string` | `""` | no |
| <a name="input_allowed_ssh_cidrs"></a> [allowed\_ssh\_cidrs](#input\_allowed\_ssh\_cidrs) | CIDRs allowed to SSH to the fleet instance. Default empty — use SSM Session Manager instead. | `list(string)` | `[]` | no |
| <a name="input_ami_id"></a> [ami\_id](#input\_ami\_id) | AMI ID override. Defaults to latest Amazon Linux 2023 if left empty. | `string` | `""` | no |
| <a name="input_architecture"></a> [architecture](#input\_architecture) | CPU architecture for both the AMI and the instance type. Must be 'arm64' (Graviton, default) or 'x86\_64' (Intel/AMD). var.instance\_type and var.agent\_instance\_types entries must match this architecture (e.g. t4g.* for arm64, t3.* for x86\_64). | `string` | `"arm64"` | no |
| <a name="input_aws_region"></a> [aws\_region](#input\_aws\_region) | AWS region to deploy into. | `string` | `"us-east-1"` | no |
| <a name="input_context_store_backend"></a> [context\_store\_backend](#input\_context\_store\_backend) | Backend for the fleet ContextStore (cross-agent shared key-value state). Only "dynamodb" is supported today; the variable exists to set up the seam for future backends (e.g. "rds") without an interface break. When the runtime gains additional backends, valid values will be widened here. | `string` | `"dynamodb"` | no |
| <a name="input_delegation_enabled"></a> [delegation\_enabled](#input\_delegation\_enabled) | Instantiate the task-ledger submodule (DynamoDB task table, S3 narratives bucket, IAM policies). Default true — the bot-delegation flow is a core Fleetmind feature. Set false only for fleets that explicitly do not use delegation (e.g. single-bot fleets) to skip the substrate. Note: terminal task events reach the PM over NATS push, not an EventBridge Pipe/SSM wake pipeline (that path was removed). | `bool` | `true` | no |
| <a name="input_enable_interface_endpoints"></a> [enable\_interface\_endpoints](#input\_enable\_interface\_endpoints) | Provision VPC interface endpoints for SSM (ssm, ssmmessages, ec2messages) and Secrets Manager. Adds ~$80/mo (4 endpoints × ~$20/mo). Default false. Recommended for fleets in fully-private subnets without NAT, or operators who want SSM resilience independent of NAT health. | `bool` | `false` | no |
| <a name="input_existing_private_subnet_ids"></a> [existing\_private\_subnet\_ids](#input\_existing\_private\_subnet\_ids) | IDs of existing private subnets (1+ required, 2+ recommended for AZ HA) when deploying into an existing VPC. Agents are round-robin-placed across whatever subnets you provide; NATS uses the first one. | `list(string)` | `[]` | no |
| <a name="input_existing_public_subnet_ids"></a> [existing\_public\_subnet\_ids](#input\_existing\_public\_subnet\_ids) | IDs of existing public subnets when deploying into an existing VPC. Currently unused by the module — agents and NATS live in private subnets — but accepted for parity with the created-VPC path and to leave room for future public-facing resources (e.g. an ALB). Pass an empty list if you don't have public subnets to share. | `list(string)` | `[]` | no |
| <a name="input_fleet_name"></a> [fleet\_name](#input\_fleet\_name) | Name of the FleetMind fleet. Used to namespace all AWS resources and workspace paths. | `string` | `"fleetmind"` | no |
| <a name="input_fleetmind_version"></a> [fleetmind\_version](#input\_fleetmind\_version) | Version of @continuous-agentics/fleetmind to install on each agent EC2. | `string` | `"latest"` | no |
| <a name="input_instance_type"></a> [instance\_type](#input\_instance\_type) | EC2 instance type. Must match var.architecture (t4g.* for arm64, t3.*/t4.*/m*.* for x86\_64). t4g.large comfortably runs a single OpenClaw agent; bump up if the agent does heavy work. | `string` | `"t4g.large"` | no |
| <a name="input_nats_auth_token"></a> [nats\_auth\_token](#input\_nats\_auth\_token) | Optional NATS auth token. When set, clients must present this token to connect. Leave empty to disable token auth. | `string` | `""` | no |
| <a name="input_nats_enabled"></a> [nats\_enabled](#input\_nats\_enabled) | When true, provisions a single-node NATS server EC2 instance and a Cloud Map private DNS namespace (<fleet\_name>.internal). Agents discover the NATS server at nats://<fleet\_name>.internal:4222. Default true when delegation is enabled — the standard inter-bot messaging transport. Set false to skip NATS provisioning (rare). | `bool` | `true` | no |
| <a name="input_nats_instance_type"></a> [nats\_instance\_type](#input\_nats\_instance\_type) | EC2 instance type for the NATS server. Must match var.architecture (t4g.small for arm64, t3.small for x86\_64). t4g.small comfortably handles thousands of bot messages per second. | `string` | `"t4g.small"` | no |
| <a name="input_nats_rollout_trigger"></a> [nats\_rollout\_trigger](#input\_nats\_rollout\_trigger) | Arbitrary rollout token for the NATS instance. Change this value to force replacement when user\_data/AMI changes are otherwise ignored. | `string` | `""` | no |
| <a name="input_nats_tls_ca_pem"></a> [nats\_tls\_ca\_pem](#input\_nats\_tls\_ca\_pem) | Optional PEM-encoded CA certificate for NATS TLS. Set when you want to require client cert validation. | `string` | `""` | no |
| <a name="input_nats_tls_cert_pem"></a> [nats\_tls\_cert\_pem](#input\_nats\_tls\_cert\_pem) | PEM-encoded TLS certificate for the NATS server. Used only when nats\_tls\_enabled = true. | `string` | `""` | no |
| <a name="input_nats_tls_enabled"></a> [nats\_tls\_enabled](#input\_nats\_tls\_enabled) | Enable TLS listener on the NATS server. Requires nats\_tls\_cert\_pem and nats\_tls\_key\_pem. | `bool` | `false` | no |
| <a name="input_nats_tls_key_pem"></a> [nats\_tls\_key\_pem](#input\_nats\_tls\_key\_pem) | PEM-encoded private key for the NATS server TLS certificate. Used only when nats\_tls\_enabled = true. | `string` | `""` | no |
| <a name="input_nats_version"></a> [nats\_version](#input\_nats\_version) | NATS server version to install from GitHub releases (semver without 'v' prefix). Pin this for reproducible deploys. | `string` | `"2.14.1"` | no |
| <a name="input_node_version"></a> [node\_version](#input\_node\_version) | Node.js major version to install via NodeSource RPMs. | `string` | `"22"` | no |
| <a name="input_openclaw_version"></a> [openclaw\_version](#input\_openclaw\_version) | OpenClaw npm package version to install. Use 'latest' or pin to a specific version. | `string` | `"latest"` | no |
| <a name="input_secret_recovery_window_days"></a> [secret\_recovery\_window\_days](#input\_secret\_recovery\_window\_days) | AWS Secrets Manager recovery window (days) after deletion. Applied to per-agent Slack and model-provider secrets. Must be 0 (delete immediately, useful for ephemeral test fleets) or 7–30 (AWS-enforced range). | `number` | `7` | no |
| <a name="input_vpc_cidr"></a> [vpc\_cidr](#input\_vpc\_cidr) | CIDR block for the created VPC. Ignored when vpc\_id is set (BYO VPC mode). | `string` | `"10.0.0.0/16"` | no |
| <a name="input_vpc_id"></a> [vpc\_id](#input\_vpc\_id) | ID of an existing VPC to deploy into. Leave empty to create a new VPC. | `string` | `""` | no |
## Outputs

| Name | Description |
|------|-------------|
| <a name="output_agent_iam_role_names"></a> [agent\_iam\_role\_names](#output\_agent\_iam\_role\_names) | IAM role name per agent. Useful for consumers that want to attach additional policies to per-agent roles after terraform apply (e.g. project-specific access grants). |
| <a name="output_agent_provider_secret_arns"></a> [agent\_provider\_secret\_arns](#output\_agent\_provider\_secret\_arns) | Map of agent\_id → (map of provider id → Secrets Manager ARN). |
| <a name="output_agent_provider_secret_names"></a> [agent\_provider\_secret\_names](#output\_agent\_provider\_secret\_names) | Map of agent\_id → (map of provider id → Secrets Manager secret name). |
| <a name="output_agent_service_names"></a> [agent\_service\_names](#output\_agent\_service\_names) | systemd service name per agent. |
| <a name="output_agent_workspace_paths"></a> [agent\_workspace\_paths](#output\_agent\_workspace\_paths) | Workspace directory path on each agent's instance. |
| <a name="output_cloud_map_namespace_name"></a> [cloud\_map\_namespace\_name](#output\_cloud\_map\_namespace\_name) | Cloud Map private DNS namespace name (e.g. 'fleetmind.internal'). Empty string when nats\_enabled = false. |
| <a name="output_context_store_backend"></a> [context\_store\_backend](#output\_context\_store\_backend) | Active ContextStore backend (echoes var.context\_store\_backend). Useful for consumers that branch agent-side configuration on backend type. |
| <a name="output_context_store_table_arn"></a> [context\_store\_table\_arn](#output\_context\_store\_table\_arn) | DynamoDB table ARN for the fleet ContextStore. Empty string when context\_store\_backend != "dynamodb". |
| <a name="output_context_store_table_name"></a> [context\_store\_table\_name](#output\_context\_store\_table\_name) | DynamoDB table name for the fleet ContextStore. Empty string when context\_store\_backend != "dynamodb". |
| <a name="output_instance_ids"></a> [instance\_ids](#output\_instance\_ids) | EC2 instance ID per agent. |
| <a name="output_ledger_bucket_name"></a> [ledger\_bucket\_name](#output\_ledger\_bucket\_name) | S3 bucket name used for deploy staging and (when delegation\_enabled) task narrative content. |
| <a name="output_nats_enabled"></a> [nats\_enabled](#output\_nats\_enabled) | Whether the NATS transport is provisioned. |
| <a name="output_nats_instance_id"></a> [nats\_instance\_id](#output\_nats\_instance\_id) | EC2 instance ID of the NATS server. Empty string when nats\_enabled = false. |
| <a name="output_nats_url"></a> [nats\_url](#output\_nats\_url) | NATS connection URL for fleet agents (Cloud Map DNS). Empty string when nats\_enabled = false. |
| <a name="output_private_ips"></a> [private\_ips](#output\_private\_ips) | Private IP per agent. |
| <a name="output_secrets_arns"></a> [secrets\_arns](#output\_secrets\_arns) | Secrets Manager ARNs — slack secret + per-provider model secrets per agent. Keys are <agent>\_slack and <agent>\_provider\_<provider>. |
| <a name="output_ssm_connect"></a> [ssm\_connect](#output\_ssm\_connect) | SSM Session Manager connect commands, one per agent. |
| <a name="output_task_ledger_pm_policy_arn"></a> [task\_ledger\_pm\_policy\_arn](#output\_task\_ledger\_pm\_policy\_arn) | ARN of the bot-ledger-pm IAM policy. Empty string when delegation\_enabled = false. |
| <a name="output_task_ledger_s3_bucket"></a> [task\_ledger\_s3\_bucket](#output\_task\_ledger\_s3\_bucket) | S3 bucket name for task narrative content (same as ledger\_bucket\_name). Empty string when delegation\_enabled = false. |
| <a name="output_task_ledger_table_name"></a> [task\_ledger\_table\_name](#output\_task\_ledger\_table\_name) | DynamoDB task-ledger table name. Used by 'fleetmind task ack/ship' and the bot-delegation/bot-reception skills. Empty string when delegation\_enabled = false. |
| <a name="output_task_ledger_worker_policy_arn"></a> [task\_ledger\_worker\_policy\_arn](#output\_task\_ledger\_worker\_policy\_arn) | ARN of the bot-ledger-worker IAM policy. Empty string when delegation\_enabled = false. |
| <a name="output_vpc_id"></a> [vpc\_id](#output\_vpc\_id) | VPC ID — either the VPC this module created via terraform-aws-modules/vpc/aws (when var.vpc\_id is empty) or the BYO VPC adopted from var.vpc\_id. |
<!-- END_TF_DOCS -->


Selected consumer-facing outputs include per-agent maps (`instance_ids`, `private_ips`, `ssm_connect`, `agent_workspace_paths`, `agent_service_names`, `agent_iam_role_names`, `secrets_arns`), networking (`vpc_id`), ContextStore (`context_store_backend`, `context_store_table_name`, `context_store_table_arn`), the always-created deploy-staging bucket (`ledger_bucket_name`), and task-ledger outputs when delegation is enabled.

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

- [`docs/EXISTING-VPC.md`](EXISTING-VPC.md) — deploying into an existing VPC (BYO VPC mode), requirements, current interface-endpoints limitation.
- [`docs/TASK-LEDGER-STANDALONE.md`](TASK-LEDGER-STANDALONE.md) — calling `modules/task-ledger/` directly from your own Terraform root, for callers who don't want the full fleetmind EC2/VPC stack.
- [`docs/MODULE-TROUBLESHOOTING.md`](MODULE-TROUBLESHOOTING.md) — IaC-side failures: state lock recovery, derived.tfvars propagation, per-agent taint/replace, DLQ inspection, `secret_recovery_window_days` gotchas.
- [`docs/MIGRATIONS.md`](MIGRATIONS.md) — per-version upgrade notes.

## License

MIT. See [LICENSE](../../LICENSE).
