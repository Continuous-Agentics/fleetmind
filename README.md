# FleetMind

Deploy and manage OpenClaw multi-agent fleets. One config file, multiple AI bots, each with its own EC2 host, OpenClaw gateway, Slack identity, persona, and skills — coordinating natively in threads.

Built with TypeScript. Requires Node.js 20+.

## 📦 Where did the operator docs go?

fleet bring-up, day-2 ops, and troubleshooting now live in the [`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template) repo, alongside the Terraform that calls the module. Module-level concerns live in [`terraform-aws-fleetmind`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind).

| Looking for... | Now lives at |
|---|---|
| Bring-up (QUICKSTART) | [`fleetmind-template/docs/QUICKSTART.md`](https://github.com/Continuous-Agentics/fleetmind-template/blob/main/docs/QUICKSTART.md) |
| Comprehensive setup reference | [`fleetmind-template/docs/SETUP-A-FLEET.md`](https://github.com/Continuous-Agentics/fleetmind-template/blob/main/docs/SETUP-A-FLEET.md) |
| Multi-fleet patterns | [`fleetmind-template/docs/MULTI-FLEET.md`](https://github.com/Continuous-Agentics/fleetmind-template/blob/main/docs/MULTI-FLEET.md) |
| Day-to-day ops (push, pull-self, restart) | [`fleetmind-template/docs/OPERATING.md`](https://github.com/Continuous-Agentics/fleetmind-template/blob/main/docs/OPERATING.md) |
| Troubleshooting (Slack, deploy, runtime) | [`fleetmind-template/docs/TROUBLESHOOTING.md`](https://github.com/Continuous-Agentics/fleetmind-template/blob/main/docs/TROUBLESHOOTING.md) |
| GitHub Apps per agent | [`fleetmind-template/docs/GITHUB-APPS.md`](https://github.com/Continuous-Agentics/fleetmind-template/blob/main/docs/GITHUB-APPS.md) |
| Vocabulary (CONCEPTS) | [`fleetmind-template/docs/CONCEPTS.md`](https://github.com/Continuous-Agentics/fleetmind-template/blob/main/docs/CONCEPTS.md) |
| BYO VPC, module troubleshooting, migrations | [`terraform-aws-fleetmind/docs/`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind#docs) |
| Standalone task-ledger consumption | [`terraform-aws-fleetmind/docs/TASK-LEDGER-STANDALONE.md`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind/blob/main/docs/TASK-LEDGER-STANDALONE.md) |

This repo (`fleetmind`) ships the CLI itself — commands, runtime, and the delegation protocol spec. See [`docs/protocol.md`](docs/protocol.md) and [`docs/integration/delegation.md`](docs/integration/delegation.md).

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

Bot EC2 hosts are provisioned by the [`terraform-aws-fleetmind`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind) module (currently `v0.1.6`). Operators don't write Terraform from scratch — they start from the [`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template) GitHub template repo, which contains a `main.tf` that calls the module, plus `variables.tf`, `outputs.tf`, `backend.example.hcl`, and a `workspaces/default.tfvars` starter. `fleetmind render` writes the derived tfvars (`workspaces/<fleet>.derived.tfvars`) inside that repo, and `terraform apply -var-file=workspaces/<fleet>.tfvars -var-file=workspaces/<fleet>.derived.tfvars` provisions the fleet. See [`docs/QUICKSTART.md`](docs/QUICKSTART.md), [`docs/SETUP-A-FLEET.md`](docs/SETUP-A-FLEET.md), and [`docs/MULTI-FLEET.md`](docs/MULTI-FLEET.md) for the full workflow.

## Installation

fleetmind is published to public npm:

```bash
npm install -g @continuous-agentics/fleetmind
```

## Quick Start

### AWS (one EC2 per agent)

fleet bring-up happens from a [`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template) clone, not from this repo. Two paths:

- *Guided:* `fleetmind onboard` (interactive wizard — [README § Guided onboarding](https://github.com/Continuous-Agentics/fleetmind-template#guided-onboarding-recommended))
- *Manual:* [`docs/QUICKSTART.md`](https://github.com/Continuous-Agentics/fleetmind-template/blob/main/docs/QUICKSTART.md) — ~20–30 min, narrative walkthrough

### Local (Mac mini / single box, no cloud)

Agents that share a `local` target run in **one** OpenClaw gateway on that box (OpenClaw's native multi-agent model — each agent still has its own workspace, skills, Slack app, model, and persona). No AWS, no Terraform:

```bash
npm install -g @continuous-agentics/fleetmind openclaw   # openclaw needs Node 24 (or 22.19+)
fleetmind init                                            # scaffolds fleet.yaml — set a target to `provider: local`
fleetmind secrets set CONDUCTOR_BOT_TOKEN xoxb-...        # + app token + ANTHROPIC_API_KEY, per agent/provider
fleetmind up                                              # render → ~/.openclaw, secrets → ~/.openclaw/.env, start the gateway
```

`fleetmind up` renders the host's `~/.openclaw/openclaw.json`, writes resolved secrets to `~/.openclaw/.env` (chmod 600; OpenClaw substitutes them), provisions each agent's workspace, then delegates the daemon to `openclaw onboard --install-daemon`. Use `--no-daemon` to stage everything and start the gateway yourself, or `--dry-run` to preview.

This repo ships the fleetmind CLI itself — see [CLI Reference](#cli-reference) below for the commands the template drives.

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
      role: pm
      orchestrator: true
      slack:
        account_id: conductor                  # required: Slack account binding key
        bot_token: ${CONDUCTOR_BOT_TOKEN}
        app_token: ${CONDUCTOR_APP_TOKEN}
        channels: ["C…home", "C…delegation"]    # PM home + delegation channel
      agent_to_agent:
        can_send_to: [pixel, forge]

    - id: pixel
      name: Pixel
      emoji: 🎨
      role: frontend-worker
      skills:
        - name: coding
          source: client
        - name: github
          source: client
          version: "2.1.0"                     # pinned
      slack:
        account_id: pixel
        bot_token: ${PIXEL_BOT_TOKEN}
        app_token: ${PIXEL_APP_TOKEN}
        channels: ["C…delegation"]
```

See `fleet.example.yaml` for the full annotated schema.

## CLI Reference

### Workspace + deploy

| Command | Description |
|---|---|
| `fleetmind init` | Scaffold a new `fleet.yaml` |
| `fleetmind up [fleet] [--no-daemon] [--dry-run]` | **Local:** render → `~/.openclaw`, secrets → `~/.openclaw/.env`, start the OpenClaw gateway (one gateway hosts all agents on a `local` target) |
| `fleetmind render [fleet]` | Render `openclaw.json` + tfvars locally to `./rendered/` |
| `fleetmind deploy [fleet]` | Render workspaces locally (`./rendered/`) — does **not** push to EC2 |
| `fleetmind push fleet [--agent <id>] [--restart]` | **AWS:** render → upload to S3 → trigger `pull-self` on each bot (main deploy command) |
| `fleetmind pull-self [--apply] [--restart]` | Bot-side: pull latest workspace from S3 and apply (runs on EC2) |
| `fleetmind diff [fleet]` | Show what `deploy` would change without applying |
| `fleetmind watch [fleet]` | GitOps: auto-push skill updates from the skills repo |
| `fleetmind status [fleet]` | Show fleet configuration and workspace status |
| `fleetmind self-upgrade [--latest\|--version <v>] [--apply]` | Upgrade the fleetmind CLI in-place on a bot EC2 (run as root) |

### Skills + plugins

| Command | Description |
|---|---|
| `fleetmind push skill <name> --agent <id>` | Push a skill to a specific agent |
| `fleetmind push skill <name> --all` | Push a skill to all agents |
| `fleetmind push plugin <name> --all` | Push a plugin fleet-wide |

### Agents + secrets

| Command | Description |
|---|---|
| `fleetmind agent list` | List all agents |
| `fleetmind agent info <id>` | Show agent details |
| `fleetmind secrets set KEY value` | Store a secret locally (resolved in `${VAR}` fleet.yaml refs) |
| `fleetmind secrets list` | List stored secret keys |
| `fleetmind secrets export` | Export secrets as shell exports |
| `fleetmind secrets populate [--interactive]` | Push Slack + per-provider API keys into AWS Secrets Manager (one secret per `(agent, provider)` pair under `<fleet>/agents/<id>/providers/<provider>`) |
| `fleetmind secrets check` | Verify every expected `(agent, provider)` secret exists in AWS Secrets Manager without mutating anything |

### Slack

| Command | Description |
|---|---|
| `fleetmind slack manifests [--out <dir>]` | Generate per-agent Slack app manifest YAMLs from `fleet.yaml` |
| `fleetmind slack discover` | Resolve each agent's `bot_user_id` via auth.test and write back to `fleet.yaml` |

### GitHub Apps

| Command | Description |
|---|---|
| `fleetmind github-app store` | Push GitHub App credentials (app-id, installation-id, PEM) into SSM |

### Shared ContextStore

| Command | Description |
|---|---|
| `fleetmind context get <key>` | Read a value from the shared DynamoDB ContextStore |
| `fleetmind context set <key> <value>` | Write a value to the ContextStore |
| `fleetmind context delete <key>` | Delete a key |
| `fleetmind context list [prefix]` | List keys, optionally filtered by prefix |

### Task ledger (delegation)

| Command | Description |
|---|---|
| `fleetmind task create` | Create a task record (PM bot: initial delegation) |
| `fleetmind task ack` | Acknowledge a delegation (worker: `delegated→accepted`) |
| `fleetmind task ship` | Mark a task shipped (worker: `accepted→shipped`) |
| `fleetmind task block` | Mark a task blocked |
| `fleetmind task unblock` | Unblock a task (`blocked→accepted`) |
| `fleetmind task signoff` | Sign off on shipped work (`shipped→signed_off`) |
| `fleetmind task merge` | Mark a task merged (`shipped\|signed_off→merged`) |
| `fleetmind task abandon` | Abandon a task (any non-terminal status → abandoned) |
| `fleetmind task get` | Fetch a task record by ID |
| `fleetmind task update` | Update mutable task metadata (title, DoD, worker, thread) |
| `fleetmind task set-nag` | Record last nag timestamp (used by PM heartbeat sweeps) |
| `fleetmind narrative <get\|put>` | Read/write the S3-backed task narrative `.md` |
| `fleetmind query <pending\|shipped\|merged\|stale\|all>` | Query the task ledger by status/project |

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

The substrate is provisioned by the [`task-ledger`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind/tree/v0.1.6/modules/task-ledger) submodule inside [`terraform-aws-fleetmind`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind) — it activates automatically when `delegation_enabled = true` in your fleet's tfvars. Add the `bot-delegation` skill to the PM bot and the `bot-reception` skill to each worker (both ship in `openclaw/skills/`). Full walkthrough: [`docs/integration/delegation.md`](docs/integration/delegation.md). Protocol details: [`docs/protocol.md`](docs/protocol.md).

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

The Terraform module is in a separate repo: [`Continuous-Agentics/terraform-aws-fleetmind`](https://github.com/Continuous-Agentics/terraform-aws-fleetmind). Operators consume it via [`fleetmind-template`](https://github.com/Continuous-Agentics/fleetmind-template), whose `main.tf` already calls the module. `fleetmind render` writes derived tfvars (`fleet_name`, `agent_names`, `agent_orchestrators`, `wake_target_session_key`) into the template repo's `workspaces/<fleet>.derived.tfvars`; the operator passes that file + their hand-edited `<fleet>.tfvars` to `terraform apply -var-file=...`. For the full module surface, BYO VPC, troubleshooting, and per-version migration notes, see the [terraform-aws-fleetmind docs](https://github.com/Continuous-Agentics/terraform-aws-fleetmind#docs).

## CI

GitHub Actions runs on every push to `main` and every pull request:

| Job | What it does |
|-----|--------------|
| `build-and-test` | `npm ci` → `npm run build` (tsc) → `npm test` (320+ tests) → `npm pack --dry-run` (verifies published tarball contains `dist/`, `README.md`, `LICENSE`, and the public `docs/*.md` set; rejects `src/`, `test/`, internal `docs/{audits,design,test}/`, and unexpected `docs/integration/` files) |
| `shellcheck` | Runs ShellCheck on all `infra/scripts/*.sh` standalone scripts |

A `publish.yml` workflow skeleton is also present for release-on-tag — it is **manual-only** (`workflow_dispatch`) until the flow is validated. See [RELEASING.md](RELEASING.md) for publish instructions.

## Requirements

- Node.js 20+
- AWS credentials (for DynamoDB ContextStore + delegation in production)
- OpenClaw installed on each agent's target EC2 host

## License

Copyright (c) 2026 Continuous Agentics. All rights reserved.

This software is proprietary and confidential. Unauthorized copying, distribution, modification, or use of this software, in whole or in part, is strictly prohibited without prior written permission from Continuous Agentics.

For licensing inquiries, contact: gracegettert@gmail.com
