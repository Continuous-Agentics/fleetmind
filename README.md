# FleetMind

Deploy and manage OpenClaw multi-agent fleets. One config file, multiple AI bots, each with its own EC2 host, OpenClaw gateway, Slack identity, persona, and skills — coordinating natively in threads.

Built with TypeScript. Requires Node.js 20+.

## Architecture

*One EC2 instance per agent. One OpenClaw gateway per EC2.* fleetmind renders per-agent workspaces from `fleet.yaml` and pushes each to its respective host. Agents coordinate over Slack threads, the optional delegation task ledger, and a shared DynamoDB ContextStore — never via shared process state.

```
        ┌──────────────────────────────────────────┐
        │  FleetMind (CLI on operator laptop / CI) │
        │  fleet.yaml → per-agent workspaces       │
        │  workspace push, skill lifecycle, ledger │
        └────────────────────┬─────────────────────┘
                             │ render + push workspaces/skills
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
   ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
   │  EC2: A        │  │  EC2: B        │  │  EC2: C        │
   │  Gateway A     │  │  Gateway B     │  │  Gateway C     │
   │  Conductor 🎼   │  │  Pixel 🎨       │  │  Forge ⚙️       │
   │  workspace +   │  │  workspace +   │  │  workspace +   │
   │  Slack app     │  │  Slack app     │  │  Slack app     │
   └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
           │                   │                   │
           └───────────────────┼───────────────────┘
                               ▼
       Slack threads • ContextStore (DDB) • task ledger
                 • openclaw-terraform (infra) •
```

Each agent is a fully isolated OpenClaw agent: *its own EC2, its own gateway, its own workspace, its own Slack app, its own session memory, its own skill catalog.* Coordination happens **only** over external surfaces — primarily Slack threads (each agent posts under its own bot identity) and, when enabled, the delegation task ledger. There is no shared process state, no co-tenancy, no per-fleet super-process.

Fleet-wide shared key/value state is available via the **ContextStore** — a DynamoDB-backed hive mind. Any agent or external service with IAM access to the table can read or write fleet context.

### Why one EC2 per agent?

Isolation over efficiency. A misbehaving worker can't crash the orchestrator; a runaway skill on one bot doesn't starve another; each agent can be redeployed, restarted, or rolled back independently. The cost is more EC2 instances per fleet — deemed acceptable for the durability and blast-radius properties.

Bot EC2 hosts come from the [openclaw-terraform](https://github.com/Continuous-Agentics/openclaw-terraform) repo, fed by the `rendered/fleet.auto.tfvars` fleetmind generates.

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

# 5. Deploy — renders workspaces locally to ./rendered/workspaces/<agent_id>/
#    and outputs openclaw.json + fleet.auto.tfvars to ./rendered/
fleetmind deploy

# 6. Copy rendered workspaces to each EC2 (until deploy transport ships in issue #7)
#    The local ./rendered/workspaces/<agent_id>/ dirs map to <workspace_base>/<agent_id>/
#    on EC2 (workspace_base from fleet.yaml, typically /opt/openclaw/workspace).
#    e.g.: scp -r ./rendered/workspaces/conductor ec2-user@<ip>:<workspace_base>/
#          scp -r ./rendered/cron               ec2-user@<ip>:<workspace_base>/

# 7. Restart each agent's gateway on its EC2
#    e.g. via SSM: aws ssm send-command --targets ... --parameters \
#      'commands=["openclaw gateway restart"]'
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
  region: us-west-2         # required (no silent default since 0.3.0)
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
| `fleetmind deploy` | Render per-agent workspaces and push to each EC2 |
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
| `fleetmind task <create\|ack\|ship\|block\|signoff\|abandon\|merge\|get>` | Drive a task through its lifecycle in the delegation ledger |
| `fleetmind narrative <get\|put>` | Read/write the S3-backed task narrative `.md` |
| `fleetmind query <pending\|merged\|stale>` | Query the delegation ledger by status / project |

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

## Delegation (PM bot → worker bot)

fleetmind 0.3.0 added a durable task ledger for orchestrator-to-specialist delegation. When `delegation.enabled: true` is set in `fleet.yaml`, the PM bot can record delegations to a DynamoDB-backed task table, workers can `ack`/`ship`/`block` against it, and a wake pipeline (DDB Streams → EventBridge Pipe → SSM Run Command) notifies the PM bot when a worker reaches a terminal state. Narratives (what the worker did + what they learned) are written to S3.

The wake pipeline is what makes per-EC2 isolation practical: when the worker on EC2 B finishes, the SSM Run Command target fires on the orchestrator's EC2 A — no shared process or socket required.

```yaml
# fleet.yaml — minimal delegation config
delegation:
  enabled: true
  aws_region: us-west-2
  table_name: acme-fleet-tasks
  s3_bucket: acme-fleet-ledger
```

Per-agent: PM bots already use `orchestrator: true`; add `delegation.worker_bots: [...]`
to list the worker IDs they can delegate to. Worker agents add
`delegation.specialty: <label>` for routing. Wake-pipeline targeting (SSM
session key, EC2 tag) is configured at the Terraform layer.

Provision the substrate via the [`infra/terraform/modules/task-ledger/`](infra/terraform/modules/task-ledger) Terraform module. Add the `bot-delegation` skill to the PM bot and the `bot-reception` skill to each worker (both ship in `openclaw/skills/`). Full walkthrough: [`docs/integration/delegation.md`](docs/integration/delegation.md). Protocol details: [`docs/protocol.md`](docs/protocol.md).

## Skills Repo (GitOps)

FleetMind watches a versioned skills repo and automatically pushes updates to each agent's EC2:

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

FleetMind generates `rendered/fleet.auto.tfvars` for the [openclaw-terraform](https://github.com/Continuous-Agentics/openclaw-terraform) repo, which provisions the per-agent EC2 hosts, IAM roles, networking, and any AWS-side glue. Terraform picks the tfvars file up automatically (`.auto.tfvars` files are loaded by default).

`fleetmind deploy` also provisions the DynamoDB ContextStore table via the included Terraform module in `infra/terraform/modules/context-store/`. The optional task ledger substrate lives in `infra/terraform/modules/task-ledger/` and is applied separately when delegation is enabled.

## Requirements

- Node.js 20+
- AWS credentials (for DynamoDB ContextStore + delegation in production)
- OpenClaw installed on each agent's target EC2 host

## License

Copyright (c) 2026 Continuous Agentics. All rights reserved.

This software is proprietary and confidential. Unauthorized copying, distribution, modification, or use of this software, in whole or in part, is strictly prohibited without prior written permission from Continuous Agentics.

For licensing inquiries, contact: gracegettert@gmail.com
