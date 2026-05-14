# Multi-Fleet Deployments

fleetmind supports running multiple independent fleets in a single AWS account via Terraform workspaces. The Terraform itself lives in the separate [`terraform-aws-fleetmind`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind) module repo; operators consume it via the [`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template) starter.

**Idiomatic layout:** one clone of fleetmind-template with multiple `workspaces/<fleet>.tfvars` files — one per fleet. The template's backend `key` is intentionally omitted so Terraform workspaces auto-prefix state under `env:/<workspace>/`, which keeps each fleet's state isolated without a separate repo. Per-fleet clones also work if you need different `main.tf` overrides per fleet, but they're the exception.

Each Terraform workspace has its own state file, VPC, EC2 instances, IAM roles, S3 ledger bucket, DDB tasks table, and Secrets Manager namespace. Resource names are auto-prefixed by `var.fleet_name`, so a fleet named `gg-sandbox` and a fleet named `test-fleet-2` co-exist cleanly.

## One-time per AWS account: backend setup

### 1. Pick an S3 bucket for remote state

Use an existing account-level bucket or create a dedicated one:

```bash
aws s3api create-bucket \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

aws s3api put-bucket-versioning \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-encryption \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

### 2. Create the state lock table

Lock table is a one-time setup per account — it cannot be managed by the Terraform it locks (chicken-and-egg).

```bash
aws dynamodb create-table \
  --table-name fleetmind-tf-state-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-2
```

### 3. Write your local `backend.hcl`

From the root of your fleet repo (created from [`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template)):

```bash
cp backend.example.hcl backend.hcl
$EDITOR backend.hcl   # fill in bucket, region, etc.
```

`backend.hcl` is gitignored — each operator maintains their own.

### 4. Initialize Terraform with the backend config

```bash
terraform init -backend-config=backend.hcl
```

This sets up the S3 backend and DDB lock for all future Terraform operations.

## Per-fleet: workspace + tfvars

### 1. Create a Terraform workspace per fleet

```bash
terraform workspace new gg-sandbox        # first fleet
terraform workspace new test-fleet-2      # second fleet (parallel)
```

State files land at `s3://<bucket>/env:/<workspace>/fleetmind/terraform.tfstate` automatically.

### 2. Per-fleet tfvars

Each workspace needs its own `workspaces/<fleet>.tfvars` file (at the repo root).
Copy the template's starter and adjust:

```bash
cp workspaces/default.tfvars workspaces/test-fleet-2.tfvars
# Edit:
#   - aws_region (if different)
#   - agent_ports
#   - delegation_enabled
#   - wake_target_session_key
```

`fleetmind render` (or `push fleet`) also writes a companion `.derived.tfvars` for
the fleet-derived variables (agent names, models, orchestrators). Apply both
files together:

```bash
terraform workspace select gg-sandbox
terraform apply -var-file=workspaces/gg-sandbox.tfvars -var-file=workspaces/gg-sandbox.derived.tfvars

terraform workspace select test-fleet-2
terraform apply -var-file=workspaces/test-fleet-2.tfvars -var-file=workspaces/test-fleet-2.derived.tfvars
```

### 3. Per-fleet fleet.yaml

Each fleet needs its own `fleet.yaml` (or a top-level YAML with the same structure). Copy the existing `fleet.yaml` and edit:

- `fleet.name` (must be unique per AWS account)
- Per-agent Slack `bot_user_id`, `channels` (different Slack apps + channels per fleet)
- Network CIDR if the fleet shares an account with another fleet (non-overlapping)

Pass to fleetmind commands explicitly:

```bash
fleetmind push fleet --fleet ./fleet-test2.yaml --restart
fleetmind slack discover --fleet ./fleet-test2.yaml
fleetmind secrets populate --fleet ./fleet-test2.yaml --interactive
```

## Cost & quota considerations

Each fleet creates its own VPC, NAT Gateway, EC2 instances, and S3 ledger bucket. Approximate ongoing cost per fleet:

- NAT Gateway: ~$32/mo
- 2 EC2 t4g.medium: ~$60/mo (or higher with m7g.large)
- VPC interface endpoints (optional, `enable_interface_endpoints = true`): ~$80/mo

AWS account quotas worth checking before adding fleets:
- VPCs per region (default 5)
- Elastic IPs (default 5 — NAT uses 1 per fleet)
- EC2 instance limits per family

## Switching between fleets

```bash
terraform workspace list
terraform workspace show
terraform workspace select <name>
```

All fleetmind CLI commands (push, pull-self, secrets, discover, etc.) accept `--fleet <path>` to target a specific fleet.yaml. The renderer's per-agent slicing means each agent gets its own openclaw.json regardless of how many fleets exist.

## Migrating an existing local-state deploy to remote state

If you've been deploying with local state (`terraform.tfstate` on disk) and want to migrate:

```bash
terraform init -backend-config=backend.hcl -migrate-state
# Terraform asks: "Do you want to copy existing state to the new backend?" — yes.
```

After migration, the local `terraform.tfstate*` files can be deleted (they're orphaned).
