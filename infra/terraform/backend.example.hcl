# Terraform backend config — partial backend pattern.
#
# Copy this file to backend.hcl (gitignored) and fill in account-specific values.
# Then initialize with:
#
#   terraform init -backend-config=backend.hcl
#
# Per-fleet state is auto-isolated via Terraform workspaces. Create one per
# fleet:
#
#   terraform workspace new gg-sandbox
#   terraform workspace new test-fleet-2
#
# Terraform stores each workspace's state at env:/<workspace>/<key> automatically.

# ── S3 bucket holding remote state ──────────────────────────────────────────
# Use an AWS account-level content bucket (AFT often vends one as
# carpe-<account-id>-bot-content). Any operator-owned bucket works.
bucket = "REPLACE_ME-tfstate-bucket"

# ── S3 object key prefix ────────────────────────────────────────────────────
# Terraform workspaces add their own prefix (env:/<workspace>/), so this is
# just the trailing path. Use a fleet-product-shaped path so multiple Terraform
# projects can share one bucket.
key = "fleetmind/terraform.tfstate"

# ── Region of the S3 bucket ─────────────────────────────────────────────────
region = "us-west-2"

# ── DynamoDB table for state locking ────────────────────────────────────────
# Create once per AWS account (see docs/MULTI-FLEET.md for the one-time setup
# command). Table schema: hash key `LockID` (string), PAY_PER_REQUEST billing.
dynamodb_table = "fleetmind-tf-state-lock"
