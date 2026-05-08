# FleetMind

Deploy and manage OpenClaw multi-agent fleets. One config file, multiple AI bots, each with its own Slack identity, persona, and skills — coordinating natively in threads.

Built with TypeScript. Requires Node.js 20+.

## Architecture

```
┌──────────────────────────────────────────┐
│  FleetMind                               │
│  fleet.yaml → openclaw.json              │
│  workspace provisioning, skill lifecycle │
│  shared ContextStore (DynamoDB)          │
└────────────────────┬─────────────────────┘
                     │ generates config + workspaces
┌────────────────────▼─────────────────────┐
│  OpenClaw Gateway                        │
│  multi-agent runtime                     │
│  Conductor 🎼  Pixel 🎨  Forge ⚙️        │
│  (each a separate agent + Slack app)     │
└────────────────────┬─────────────────────┘
                     │ runs on infra from
┌────────────────────▼─────────────────────┐
│  openclaw-terraform                      │
│  EC2, IAM, networking, DynamoDB          │
│  consumes rendered/fleet.auto.tfvars     │
└──────────────────────────────────────────┘
```

Each agent is a fully isolated OpenClaw agent with its own workspace, Slack app, session memory, and skills. Agents communicate via OpenClaw's native `agentToAgent` messaging — Conductor delegates to Pixel or Forge, who reply directly in the Slack thread under their own bot identity.

Agents share state through the **ContextStore** — a DynamoDB-backed hive mind. Any service with IAM access to the table can read or write fleet context without routing through an agent.

## Quick Start

```bash
npm install -g fleetmind

# 1. Scaffold a new fleet
fleetmind init --name acme-fleet --client "Acme Corp"

# 2. Edit fleet.yaml — add agents, Slack tokens, skills
# 3. Store secrets
fleetmind secrets set CONDUCTOR_BOT_TOKEN xoxb-...
fleetmind secrets set CONDUCTOR_APP_TOKEN xapp-...
fleetmind secrets set PIXEL_BOT_TOKEN xoxb-...
fleetmind secrets set PIXEL_APP_TOKEN xapp-...

# 4. Preview changes
fleetmind diff

# 5. Deploy
fleetmind deploy

# 6. Restart OpenClaw gateway
openclaw gateway restart
```

## fleet.yaml Overview

```yaml
fleet:
  name: acme-fleet
  client: Acme Corp

skills_repo:
  url: https://github.com/your-org/skills-repo
  poll_interval: 60s

context:
  provider: dynamodb        # dynamodb | local (in-memory dev fallback)
  region: us-east-1         # defaults to AWS_REGION env var
  ttl_days: 30              # optional default TTL for context entries

agents:
  defaults:
    model: anthropic/claude-sonnet-4-6

  list:
    - id: conductor
      name: Conductor
      emoji: 🎼
      orchestrator: true
      slack:
        bot_token: ${CONDUCTOR_BOT_TOKEN}
        app_token: ${CONDUCTOR_APP_TOKEN}
      agent_to_agent:
        can_send_to: [pixel, forge]

    - id: pixel
      name: Pixel
      emoji: 🎨
      skills:
        - name: coding
        - name: github
          version: "2.1.0"   # pinned
      slack:
        bot_token: ${PIXEL_BOT_TOKEN}
        app_token: ${PIXEL_APP_TOKEN}
```

See `fleet.example.yaml` for the full annotated schema.

## CLI Reference

| Command | Description |
|---|---|
| `fleetmind init` | Scaffold a new fleet.yaml |
| `fleetmind deploy` | Provision workspaces + render openclaw.json |
| `fleetmind diff` | Show what deploy would change |
| `fleetmind render` | Emit openclaw.json + tfvars without deploying |
| `fleetmind watch` | GitOps: auto-push skill updates from skills repo |
| `fleetmind status` | Show fleet + workspace status |
| `fleetmind push skill <name> --agent <id>` | Push a skill to an agent |
| `fleetmind push skill <name> --all` | Push a skill to all agents |
| `fleetmind push plugin <name> --all` | Push a plugin fleet-wide |
| `fleetmind agent list` | List all agents |
| `fleetmind agent info <id>` | Show agent details |
| `fleetmind secrets set KEY value` | Store a secret |
| `fleetmind secrets list` | List stored secret keys |
| `fleetmind secrets export` | Export secrets as shell exports |
| `fleetmind context get <key>` | Read a value from the shared ContextStore |
| `fleetmind context set <key> <value>` | Write a value to the ContextStore |
| `fleetmind context delete <key>` | Delete a key |
| `fleetmind context list [prefix]` | List keys, optionally filtered by prefix |

## Shared ContextStore (Hive Mind)

All agents in a fleet share a DynamoDB-backed ContextStore. Keys are namespaced as `{fleetName}/{scope}/{key}`:

```bash
# Write shared context (any agent or external service can read this)
fleetmind context set acme-fleet/shared/last-deploy "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Read it back
fleetmind context get acme-fleet/shared/last-deploy

# List everything under a prefix
fleetmind context list acme-fleet/conductor/
```

In local/dev mode (`provider: local`), the store is in-memory only — data won't survive restarts. A warning is printed so you know you're not hitting real DynamoDB.

The DynamoDB table ARN is exported as a Terraform output (`context_store_table_arn`) so external services can be granted IAM access without hardcoding table names.

## Skills Repo (GitOps)

FleetMind watches a versioned skills repo and automatically pushes updates:

```
your-skills-repo/
  versions.json          ← {"coding": "1.2.0", "github": "2.1.0"}
  coding/
    SKILL.md
    package.json         ← {"name": "coding", "version": "1.2.0"}
  github/
    SKILL.md
    package.json
```

```bash
# Start the watcher (runs until Ctrl+C)
fleetmind watch

# Or push a specific skill manually
fleetmind push skill coding --agent forge
fleetmind push skill github --all --version 2.1.0
```

Unpinned skills (`- name: coding`) auto-update. Pinned skills (`version: "2.1.0"`) are skipped unless `--force`.

## Terraform Integration

FleetMind generates `rendered/fleet.auto.tfvars` for the [openclaw-terraform](https://github.com/Continuous-Agentics/openclaw-terraform) repo. Terraform picks this up automatically (`.auto.tfvars` files are loaded by default).

`fleetmind deploy` also provisions the DynamoDB ContextStore table via the included Terraform module in `infra/terraform/`.

## Requirements

- Node.js 20+
- AWS credentials (for DynamoDB ContextStore in production)
- OpenClaw installed on the target host

## License

Copyright (c) 2026 Continuous Agentics. All rights reserved.

This software is proprietary and confidential. Unauthorized copying, distribution, modification, or use of this software, in whole or in part, is strictly prohibited without prior written permission from Continuous Agentics.

For licensing inquiries, contact: gracegettert@gmail.com
