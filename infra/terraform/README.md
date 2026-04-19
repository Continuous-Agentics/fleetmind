# FleetMind — Terraform Infrastructure

One EC2 instance per client fleet. All agents run as co-located systemd services directly on the instance — no Docker, no custom AMI.

## Architecture

```
Client Fleet (single EC2 t3.medium)
│
├── systemd: openclaw-orchestrator   → port 18789
├── systemd: openclaw-pixel          → port 18790
└── systemd: openclaw-forge          → port 18791
│
├── /opt/openclaw/workspace/
│   ├── orchestrator/    ← EBS-backed agent memory + state
│   ├── pixel/
│   └── forge/
│
└── → RDS Postgres (private subnet, shared ContextStore)
```

## Design decisions

*Why not Docker?*
OpenClaw is a long-lived Node.js daemon, not a containerized microservice. Running it directly with systemd is simpler, easier to debug (`journalctl -u openclaw-orchestrator`), and eliminates a layer of indirection. Upgrades are `npm install -g openclaw@x.y.z` + `systemctl restart`.

*Why not one EC2 per agent?*
Three OpenClaw agents are well within the resource envelope of a `t3.medium`. Co-locating them on one instance keeps the fleet billing simple (one instance = one client) and is easy to split apart later if resource contention warrants it.

*Why not a custom AMI?*
AMI baking (Packer pipelines, versioning, refresh cadence) is overhead that isn't justified when bootstrap takes ~2 minutes via user_data. If boot time ever becomes a concern at scale, AMI baking is an easy addition.

*Fault tolerance*
- Process crash → systemd `Restart=always`, back in 10 seconds
- Instance reboot → EBS remounts via fstab, all services auto-start
- Instance loss → EBS volume has `prevent_destroy = true`, reattach to replacement

## Prerequisites

- AWS CLI configured with appropriate permissions (EC2, RDS, VPC, IAM, Secrets Manager)
- Terraform >= 1.5

## Quick Start

```bash
cd infra/terraform

# Initialize
terraform init

# Preview (use your client/fleet name)
terraform plan -var="fleet_name=acme-devteam"

# Apply (~10-15 min, most of it waiting for RDS)
terraform apply -var="fleet_name=acme-devteam"
```

> **Team state:** Before sharing with the team, uncomment the `backend "s3"` block in `main.tf` and create the S3 bucket + DynamoDB table first.

## Populate Secrets After Apply

After apply, fill in real values (placeholder secrets are created automatically):

```bash
# Anthropic API key (shared by all agents)
aws secretsmanager put-secret-value \
  --secret-id acme-devteam/shared/anthropic \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-...","DATABASE_URL":"postgresql://..."}'

# Per-agent Slack tokens
for AGENT in orchestrator pixel forge; do
  aws secretsmanager put-secret-value \
    --secret-id "acme-devteam/agents/$AGENT/slack" \
    --secret-string '{
      "SLACK_BOT_TOKEN":"xoxb-...",
      "SLACK_SIGNING_SECRET":"...",
      "SLACK_APP_TOKEN":"xapp-..."
    }'
done

# Restart all agents to pick up secrets
INSTANCE_ID=$(terraform output -raw instance_id)
aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["systemctl restart openclaw-orchestrator openclaw-pixel openclaw-forge"]'
```

## Connect to the Instance (No SSH Required)

```bash
# Get the connect command
terraform output ssm_connect

# Example output:
# aws ssm start-session --target i-0abc123 --region us-east-1

# Once connected:
systemctl status openclaw-orchestrator
journalctl -u openclaw-pixel -f
```

## Upgrading OpenClaw

```bash
INSTANCE_ID=$(terraform output -raw instance_id)

aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=[
    "source /opt/nvm/nvm.sh",
    "npm install -g openclaw@latest",
    "systemctl restart openclaw-orchestrator openclaw-pixel openclaw-forge"
  ]'
```

Or pin a version by setting `openclaw_version = "1.2.3"` in your tfvars and re-applying.

## Adding a New Agent

1. Add to `fleet.yaml` (new bot entry)
2. Add name to `agent_names` and port to `agent_ports` in `terraform.tfvars`
3. `terraform apply` — updates user_data, creates new Secrets Manager entry
4. Populate the new agent's Slack secret
5. On the instance: `systemctl start openclaw-<newagent>`

## Variables

| Variable | Default | Description |
|---|---|---|
| `fleet_name` | `fleetmind` | Namespace for all AWS resources |
| `aws_region` | `us-east-1` | Deployment region |
| `instance_type` | `t3.medium` | EC2 size (handles 3 agents comfortably) |
| `agent_names` | `[orchestrator, pixel, forge]` | Agents to provision |
| `openclaw_version` | `latest` | npm package version |
| `workspace_volume_size_gb` | `40` | Shared EBS size (GB) |
| `rds_multi_az` | `false` | Enable for production |
| `allowed_ssh_cidrs` | `[]` | SSH access (empty = SSM only) |

## Next Steps

- [ ] ASG (min=1) per fleet for automatic instance replacement + EBS reattach
- [ ] VPN/Tailscale to keep OpenClaw ports off the public internet
- [ ] `rds_multi_az = true` for production deployments
- [ ] GitHub Actions: `terraform plan` on PR, `terraform apply` on merge
- [ ] CloudWatch alarms: agent process health, RDS metrics, disk usage
- [ ] Terraform workspaces for multi-client state isolation
