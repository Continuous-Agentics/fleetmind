# Multi-Fleet Deployments

fleetmind supports running multiple independent fleets in a single AWS account via Terraform workspaces. Each workspace has its own state file, VPC, EC2 instances, IAM roles, S3 ledger bucket, DDB tasks table, and Secrets Manager namespace. Resource names are auto-prefixed by `var.fleet_name`, so a fleet named `gg-sandbox` and a fleet named `test-fleet-2` co-exist cleanly.

## One-time per AWS account: backend setup

### 1. Pick an S3 bucket for remote state

Use an existing account-level bucket (AFT vends `carpe-<account-id>-bot-content` in Carpe accounts) or create one:

```bash
aws s3api create-bucket \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

aws s3api put-bucket-versioning \
  --bucket <YOUR-TFSTATE-BUCKET> \
  --versioning-configuration Status=Enabled
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

In `infra/terraform/`, copy the example:

```bash
cp backend.example.hcl backend.hcl
$EDITOR backend.hcl   # fill in bucket, region, etc.
```

`backend.hcl` is gitignored — each operator maintains their own.

### 4. Initialize Terraform with the backend config

```bash
cd infra/terraform
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

Each workspace needs its own `terraform-extras-<fleet>.tfvars` file:

```bash
cp terraform-extras.tfvars terraform-extras-test-fleet-2.tfvars
# Edit:
#   - aws_region (if different)
#   - agent_ports
#   - delegation_enabled
#   - agent_orchestrators
#   - wake_target_session_key
```

Then apply with the matching tfvars:

```bash
terraform workspace select gg-sandbox
terraform apply -var-file=terraform-extras.tfvars

terraform workspace select test-fleet-2
terraform apply -var-file=terraform-extras-test-fleet-2.tfvars
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
cd infra/terraform
terraform init -backend-config=backend.hcl -migrate-state
# Terraform asks: "Do you want to copy existing state to the new backend?" — yes.
```

After migration, the local `terraform.tfstate*` files can be deleted (they're orphaned).
