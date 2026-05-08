# OpenClaw Integration

How fleetmind composes an OpenClaw multi-agent gateway from a `fleet.yaml`.

## Architecture

```
                     ┌──────────────────────────┐
                     │  fleet.yaml              │
                     │  (one source of truth)   │
                     └────────────┬─────────────┘
                                  │
                      fleetmind render / deploy
                                  ▼
   ┌──────────────────────────────────────────────────────────┐
   │  OpenClaw Gateway (single process, multiple agents)      │
   │                                                          │
   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
   │  │  Agent: A    │  │  Agent: B    │  │  Agent: C    │   │
   │  │  workspace/  │  │  workspace/  │  │  workspace/  │   │
   │  │  Slack app   │  │  Slack app   │  │  Slack app   │   │
   │  │  skills      │  │  skills      │  │  skills      │   │
   │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
   │         │                 │                 │           │
   │         └─────────────────┼─────────────────┘           │
   │              agentToAgent message routing                │
   │                                                          │
   │  ContextStore (DynamoDB) — fleet-wide hive mind          │
   └──────────────────────────────────────────────────────────┘
                                  │
   ┌──────────────────────────────▼───────────────────────────┐
   │  Optional: task ledger substrate                         │
   │  (DynamoDB tasks table + S3 narratives + EventBridge     │
   │   wake pipeline) — enabled per fleet via                 │
   │   `delegation.enabled = true`                            │
   └──────────────────────────────────────────────────────────┘
```

Each agent is a fully isolated OpenClaw agent with its own workspace, Slack
identity, session memory, and skill catalog — but they all run inside one
gateway process. Agents coordinate via OpenClaw's native `agentToAgent`
messaging; fleet-wide shared state lives in the DynamoDB ContextStore (any
agent — or any external service with IAM access — can read or write).

When the optional delegation feature is enabled, agents also use the task
ledger substrate (separate from ContextStore) to record durable, queryable
delegation state. See [docs/protocol.md](../docs/protocol.md).

## How a request flows

1. A human posts in Slack — say `@conductor please ship a status banner`
2. The conductor agent's Slack account (registered in OpenClaw via
   `fleet.yaml → agents.list[].slack`) receives the message
3. Conductor decides which specialist should handle the work and emits an
   `agentToAgent.send` to (e.g.) `pixel`
4. Pixel's session picks up the message; their persona + skill catalog
   handle it. Pixel replies in the Slack thread under their own bot identity
5. *(With delegation enabled)* the orchestrator records the delegation in
   the task ledger via `fleetmind task create`; the worker `ack`s, `ship`s,
   etc. and the wake signal flows DDB Streams → EventBridge Pipe → SSM →
   conductor's wake handler

## Workspace layout

`fleet.yaml` defines agents; `fleetmind deploy` materialises one workspace
directory per agent under `OPENCLAW_STATE_DIR/agents/<id>/workspace/`. Each
contains:

```
workspace/
├── SOUL.md          # composed from openclaw/<bot-template>/workspace/SOUL.md +
│                    # the agent's `persona.soul` block in fleet.yaml
├── AGENTS.md        # composed from the role template + delegation snippets
├── IDENTITY.md      # generated from agent metadata (name, emoji, etc.)
└── skills/          # symlinked / copied from skills_repo + ClawHub + private
```

For delegation-aware fleets, see the per-role workspace contributions in:
- `openclaw/pm-bot/workspace/` — PM bot template (orchestrator role)
- `openclaw/worker-bot/workspace/` — worker bot template (specialty-agnostic;
  fleet.yaml fills in the specialty)

## Adding a specialist

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
   ```
2. Create the matching Slack app (use the manifest output from
   `fleetmind render` if available) and store the tokens via
   `fleetmind secrets set MY_SPECIALIST_BOT_TOKEN xoxb-…`
3. Run `fleetmind diff` to preview, then `fleetmind deploy`
4. Restart the OpenClaw gateway: `openclaw gateway restart`

## Enabling delegation on an existing fleet

See [`docs/integration/delegation.md`](../docs/integration/delegation.md). Short
version:

1. Apply the `infra/terraform/modules/task-ledger/` Terraform module
2. Add a `delegation:` block to `fleet.yaml`
3. Add `bot-delegation` to your PM bot's skills and `bot-reception` to each
   worker's skills (both ship in `openclaw/skills/`)
4. `fleetmind deploy` and restart the gateway

## Local development

For local single-process testing without DynamoDB, set
`context.provider: local` in `fleet.yaml`. The ContextStore will run
in-memory (data won't survive gateway restarts; a warning is printed at
startup). Delegation requires real DynamoDB — there's no in-memory mode
for the task ledger.

To run the gateway locally:

```bash
fleetmind render               # generate openclaw.json + workspaces
openclaw gateway --local       # uses the rendered openclaw.json
```
