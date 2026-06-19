# dogfood test fleet

First real test of fleetmind end-to-end, deployed in the `dogfood` AWS
account (`624905204775`).

## Fleet shape

| Agent | Role | Specialty | Model |
|---|---|---|---|
| Conductor | PM (orchestrator) | — | claude-sonnet-4-6 |
| Forge | Worker | backend | claude-haiku-4 |

Both run in the same Slack channel (set in `terraform-extras.tfvars`).

## Files in this branch

- `fleet.yaml` (root) — declarative fleet definition
- `infra/terraform/terraform-extras.tfvars` — infra-only vars (region, ports,
  delegation, wake-target session key). Append to `rendered/fleet.derived.tfvars`
  after running `npx fleetmind render`.
- `docs/test/gg-sandbox/slack-manifests/{conductor,forge}.yaml` — paste these
  at <https://api.slack.com/apps/manifest> to create the two Slack apps.

## Open placeholders

1. `terraform-extras.tfvars` line ~22 — `wake_target_session_key` needs the
   real Slack channel ID where Conductor + Forge live (format:
   `agent:main:slack:channel:C0XXXXX`).

## Deploy steps

```bash
# Set AWS profile for dogfood
export AWS_PROFILE=dogfood

# Install fleetmind deps
npm install

# Render workspace + tfvars from fleet.yaml
npx fleetmind render

# Merge the infra-only extras with the rendered tfvars
cat infra/terraform/terraform-extras.tfvars >> rendered/fleet.derived.tfvars
cp rendered/fleet.derived.tfvars infra/terraform/terraform.tfvars

# Provision infra
cd infra/terraform
terraform init
terraform plan
terraform apply

# Populate per-agent secrets (Slack + Anthropic)
# (commands inserted here after `terraform apply` outputs the secret ARNs)
```

## Post-apply manual step (deploy-transport gap, issue #7)

`fleetmind deploy` is currently filesystem-only. Workaround:
1. `fleetmind deploy` locally renders each agent's workspace to
   `workspace-<agent_id>/`
2. Transfer each workspace to its EC2 via SSM Session Manager (instances are in
   **private subnets with no public IPs** — SCP/SSH direct is not available):
   ```bash
   # Use SSM + S3 to push files, or AWS Systems Manager Run Command
   # See: aws ssm start-session --target <instance-id> --region <region>
   ```
3. `systemctl restart openclaw-gateway` via SSM Run Command

Once the deploy transport (issue #7-#15) lands, this collapses to a single
`fleetmind deploy` call.
