# backend.example.hcl — copy to `backend.hcl` (gitignored) and fill in.
#
# Pass to terraform init with:
#   terraform init -backend-config=backend.hcl
#
# Prerequisites (one-time, per operator account):
#   aws s3 mb s3://my-fleet-tfstate --region us-west-2
#   aws dynamodb create-table \
#     --table-name my-fleet-tfstate-lock \
#     --attribute-definitions AttributeName=LockID,AttributeType=S \
#     --key-schema AttributeName=LockID,KeyType=HASH \
#     --billing-mode PAY_PER_REQUEST \
#     --region us-west-2
#
# Use a unique, explicit key for each fleet. Do not rely on Terraform CLI
# workspaces for new-fleet state isolation; they are supported only for legacy
# state migration.

bucket         = "my-fleet-tfstate"
region         = "us-west-2"
key            = "fleets/my-fleet/terraform.tfstate"
dynamodb_table = "my-fleet-tfstate-lock"
