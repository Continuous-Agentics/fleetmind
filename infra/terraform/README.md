# FleetMind — Terraform Infrastructure

EC2-per-agent infrastructure for long-lived OpenClaw agents.

## Architecture

```
                        ┌──────────────────────────────────────────┐
                        │                  AWS VPC                 │
                        │                                          │
                        │  Public Subnets                          │
                        │  ┌─────────────┐  ┌────────────────┐    │
                        │  │ EC2: Cond.  │  │  EC2: Pixel    │    │
                        │  │ OpenClaw    │  │  OpenClaw      │    │
  Slack Socket Mode ────┼─▶│ :18789      │  │  :18790        │    │
                        │  │ [EBS vol]   │  │  [EBS vol]     │    │
                        │  └─────────────┘  └────────────────┘    │
                        │  ┌─────────────┐                        │
                        │  │ EC2: Forge  │                        │
                        │  │ OpenClaw    │                        │
                        │  │ :18791      │                        │
                        │  │ [EBS vol]   │                        │
                        │  └─────────────┘                        │
                        │                                          │
                        │  Private Subnets                         │
                        │  ┌──────────────────────┐               │
                        │  │  RDS Postgres 16      │               │
                        │  │  (ContextStore / hive)│               │
                        │  └──────────────────────┘               │
                        └──────────────────────────────────────────┘
```

### Why EC2, not Fargate?

OpenClaw agents are *stateful*. Each agent has:
- A persistent workspace (`/workspace`) with memory files, skill state, session history
- Long-running processes that shouldn't be interrupted mid-task

Fargate containers are ephemeral. While EFS mounts can bridge that gap, they add latency and complexity. EC2 + EBS gives us:

| Property | EC2 + EBS | Fargate + EFS |
|---|---|---|
| Workspace persistence | ✅ Native | ⚠️ Needs EFS mount |
| Fault tolerance | ✅ systemd Restart=always | ✅ ECS service restarts |
| Instance replacement | ✅ EBS reattaches | ✅ New task mounts EFS |
| SSH/shell access | ✅ SSM Session Manager | ⚠️ ECS Exec (more setup) |
| Cost (3 agents) | ~$30-60/mo (t3.small) | ~$50-90/mo |
| Operational simplicity | ✅ Docker + systemd | ⚠️ ECS task defs, service config |

**Bottom line:** systemd's `Restart=always` + EBS persistence gives you the fault tolerance you need with far less moving parts.

### Fault tolerance model

Each agent runs as a systemd service:
- Container crash → systemd restarts it within 10s
- Instance reboot → EBS remounts, service starts automatically
- Instance termination → EBS volume survives (`prevent_destroy = true`), reattach to new instance

For higher availability, the next step would be an ASG (min=1, max=1) per agent that automatically replaces a failed instance and reattaches its EBS volume.

---

## Prerequisites

- AWS CLI configured (`aws configure` or IAM role)
- Terraform >= 1.5
- Appropriate AWS permissions (EC2, RDS, VPC, IAM, Secrets Manager)

## Quick Start

```bash
cd infra/terraform

# 1. Initialize
terraform init

# 2. Preview
terraform plan -var="fleet_name=acme-devteam"

# 3. Apply (takes ~10-15 min for RDS)
terraform apply -var="fleet_name=acme-devteam"
```

> **Remote state:** Before using with a team, uncomment the `backend "s3"` block in `main.tf` and create the S3 bucket + DynamoDB table first.

## Populate Secrets After Apply

After `terraform apply`, fill in real values:

```bash
# Anthropic API key (shared by all agents)
aws secretsmanager put-secret-value \
  --secret-id fleetmind/shared/anthropic \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-...","DATABASE_URL":"postgresql://..."}'

# Per-agent Slack tokens
aws secretsmanager put-secret-value \
  --secret-id fleetmind/agents/orchestrator/slack \
  --secret-string '{
    "SLACK_BOT_TOKEN":"xoxb-...",
    "SLACK_SIGNING_SECRET":"...",
    "SLACK_APP_TOKEN":"xapp-..."
  }'

aws secretsmanager put-secret-value \
  --secret-id fleetmind/agents/pixel/slack \
  --secret-string '{"SLACK_BOT_TOKEN":"xoxb-...","SLACK_SIGNING_SECRET":"...","SLACK_APP_TOKEN":"xapp-..."}'

aws secretsmanager put-secret-value \
  --secret-id fleetmind/agents/forge/slack \
  --secret-string '{"SLACK_BOT_TOKEN":"xoxb-...","SLACK_SIGNING_SECRET":"...","SLACK_APP_TOKEN":"xapp-..."}'

# Restart agents to pick up new secrets
aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --targets '[{"Key":"tag:Project","Values":["fleetmind"]}]' \
  --parameters '{"commands":["systemctl restart openclaw-agent"]}'
```

## Connect to an Agent (No SSH Required)

```bash
# Get the connect command from outputs
terraform output ssm_connect_commands

# Example:
aws ssm start-session --target i-0abc123def456 --region us-east-1

# Once connected, check agent status:
systemctl status openclaw-agent
journalctl -u openclaw-agent -f
docker logs openclaw-orchestrator
```

## Adding a New Bot

1. Add to `fleet.yaml` (new bot entry)
2. Add to `variables.tf` `agent_names` default and `agent_ports` map
3. Create Slack app and note tokens
4. `terraform apply` — creates new EC2 + EBS + Secrets Manager entry
5. Populate the new agent's Slack secret

## Variables Reference

| Variable | Default | Description |
|---|---|---|
| `fleet_name` | `fleetmind` | Namespace for all AWS resources |
| `aws_region` | `us-east-1` | Deployment region |
| `instance_type` | `t3.small` | EC2 size per agent |
| `agent_names` | `[orchestrator, pixel, forge]` | Agents to provision |
| `workspace_volume_size_gb` | `20` | EBS size per agent (GB) |
| `rds_multi_az` | `false` | Enable RDS Multi-AZ (for prod) |
| `allowed_ssh_cidrs` | `[]` | SSH CIDRs (empty = SSM only) |

## Open Questions / Next Steps

- [ ] **ASG per agent** — auto-replace failed instances and reattach EBS
- [ ] **VPN/Tailscale** — avoid exposing OpenClaw ports publicly; route Slack through private network
- [ ] **Multi-AZ RDS** — flip `rds_multi_az = true` for production
- [ ] **AMI pinning** — pin to a specific AL2023 AMI version for reproducibility
- [ ] **CI deploy pipeline** — GitHub Actions workflow for `terraform plan` on PR, `terraform apply` on merge
- [ ] **CloudWatch alarms** — alert on agent process down, RDS CPU, disk usage
- [ ] **Multi-client** — one Terraform workspace per client fleet; use Terraform workspaces or separate state files
