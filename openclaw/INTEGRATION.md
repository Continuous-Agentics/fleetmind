# OpenClaw Integration

How fleetmind composes a fleet of OpenClaw gateways — *one per agent, each
on its own EC2 instance* — from a single `fleet.yaml`.

## Architecture

```
                  ┌──────────────────────────┐
                  │  fleet.yaml              │
                  │  (one source of truth)   │
                  └────────────┬─────────────┘
                               │ fleetmind render / deploy
                  ┌────────────┼────────────┐
                  ▼            ▼            ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │  EC2: A      │  │  EC2: B      │  │  EC2: C      │
   │  Gateway A   │  │  Gateway B   │  │  Gateway C   │
   │  Agent A     │  │  Agent B     │  │  Agent C     │
   │  workspace/  │  │  workspace/  │  │  workspace/  │
   │  Slack app   │  │  Slack app   │  │  Slack app   │
   │  skills      │  │  skills      │  │  skills      │
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          │                 │                 │
          └─────────────────┼─────────────────┘
                            ▼
   coordination surfaces (shared across gateways):
     • Slack threads — each agent posts under its own bot identity
     • Cross-gateway delegation — PM bot → worker bot via the task ledger
     • ContextStore (DynamoDB) — fleet-wide hive mind
     • Task ledger (optional) — DynamoDB tasks + S3 narratives +
       EventBridge wake pipeline; enabled via `delegation.enabled`
```

Each agent is a fully isolated OpenClaw agent: *its own EC2 instance, its
own gateway process, its own workspace, its own Slack identity, its own
session memory, its own skill catalog.* There is no shared process and no
co-tenancy — isolation is strict. Agents coordinate over external surfaces
only: primarily Slack threads (every agent has a Slack app and posts under
its own bot identity) and, when delegation is enabled, the task ledger
substrate. Fleet-wide shared key/value state is available via the DynamoDB
ContextStore (any agent — or any external service with IAM access — can
read or write).

This shape favours *isolation over efficiency*. A misbehaving worker can't
crash the orchestrator; a runaway skill on one bot doesn't starve another;
each agent can be redeployed, restarted, or rolled back independently. The
cost is more EC2 instances (one per agent per fleet) and slightly more
network hops for coordination — both deemed acceptable for the durability
and blast-radius properties.

## How a request flows

1. A human posts in Slack — say `@conductor please ship a status banner`
2. The conductor agent's gateway (running on its own EC2) receives the
   message via its Slack app
3. Conductor decides which specialist should handle the work
4. *(Delegation enabled)* Conductor records the delegation in the task
   ledger via `fleetmind task create`, then posts a delegation envelope
   in a coordination Slack thread @-mentioning the worker's bot
5. The worker's gateway (a *different* EC2) sees the @-mention in the
   thread, picks up the envelope, and `ack`s the task in the ledger
6. The worker does the work and replies in-thread under their own bot
   identity. On completion they `ship` the task; the wake signal flows
   DDB Streams → EventBridge Pipe → SSM Run Command → Conductor's gateway
7. Conductor wakes, reads the narrative, and reports back to the human

## Workspace layout

`fleet.yaml` defines agents; `fleetmind deploy` materialises one workspace
directory per agent and pushes it to that agent's EC2 host. The workspace
lives at `<workspace_base>/workspace-<agent_id>/` — e.g. with the default
`workspace_base: /home/ec2-user/.openclaw`, conductor's workspace is
`/home/ec2-user/.openclaw/workspace-conductor/`. Each contains:

```
workspace/
├── SOUL.md          # composed from openclaw/<role-template>/workspace/SOUL.md +
│                    # the agent's `persona.soul` block in fleet.yaml
├── AGENTS.md        # composed from the role template + delegation snippets
├── IDENTITY.md      # generated from agent metadata (name, emoji, etc.)
└── skills/          # synced from skills_repo + ClawHub + private registry
```

For delegation-aware fleets, see the per-role workspace contributions in:
- `openclaw/pm-bot/workspace/` — PM bot template (orchestrator role)
- `openclaw/worker-bot/workspace/` — worker bot template (specialty-agnostic;
  fleet.yaml fills in the specialty)

## Adding a specialist

Adding a specialist provisions a new EC2 + gateway + Slack app for the
agent. fleetmind handles the workspace render and skill push; the EC2
host itself comes from the [`openclaw-terraform`](https://github.com/Continuous-Agentics/openclaw-terraform)
repo (or whatever module you use to bring up bot hosts), which fleetmind
feeds via the rendered `fleet.auto.tfvars`.

1. Add a new entry under `agents.list` in `fleet.yaml`:
   ```yaml
   - id: my-specialist
     name: "My Specialist"
     emoji: 🎯
     description: "What this specialist owns"
     slack:
       account_id: my-specialist
       bot_token: ${MY_SPECIALIST_BOT_TOKEN}
       app_token: ${MY_SPECIALIST_APP_TOKEN}
     skills:
       - name: <relevant-skill>
     agent_to_agent:
       can_send_to: [conductor]
     delegation:                # optional; remove if delegation isn't enabled
       specialty: <label>       # for workers; PMs use `worker_bots: [<id>, ...]` instead
   ```
2. Create the matching Slack app (use the manifest output from
   `fleetmind render` if available) and store the tokens via
   `fleetmind secrets set MY_SPECIALIST_BOT_TOKEN xoxb-…`
3. Provision the EC2 host (via openclaw-terraform or equivalent) with the
   agent's IAM role, including the relevant ledger policies if delegation
   is enabled
4. Run `fleetmind diff` to preview, then `fleetmind deploy` — this renders
   the workspace and pushes it to the agent's EC2
5. Restart the agent's OpenClaw gateway: `openclaw gateway restart` on
   that host

## Enabling delegation on an existing fleet

See [`docs/integration/delegation.md`](../docs/integration/delegation.md). Short
version:

1. Apply the `infra/terraform/modules/task-ledger/` Terraform module
2. Add a fleet-level `delegation:` block to `fleet.yaml`. PM-vs-worker
   is inferred from each agent's existing `orchestrator: true` flag.
   Add a per-agent `delegation:` block too: `worker_bots: [...]` for
   PMs, `specialty: <label>` for workers
3. Attach the matching IAM ledger policy to each agent's EC2 instance
   role (PM policy for orchestrator agents, worker policy for the rest)
4. `fleetmind deploy` to push updated workspaces, then restart each
   agent's gateway on its EC2

## Local development

For local testing of a single agent without provisioning EC2, set
`context.provider: local` in `fleet.yaml`. The ContextStore will run
in-memory (data won't survive gateway restarts; a warning is printed at
startup). Delegation requires real DynamoDB — there's no in-memory mode for the
task ledger. For local development against DynamoDB Local, set
`AWS_ENDPOINT_URL_DYNAMODB` in the environment (the AWS SDK picks it up).

To run a single agent's gateway locally:

```bash
fleetmind render               # generate openclaw.json + workspace for one agent
openclaw gateway --local       # uses the rendered openclaw.json
```

Multi-agent flows (delegation, cross-gateway coordination) require running
each agent's gateway separately — either as multiple local processes on
different ports or, more commonly, on per-agent EC2 hosts.
