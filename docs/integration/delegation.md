# Enabling Delegation in a Fleet

This guide covers how to configure and deploy the task-ledger delegation feature
in a fleetmind fleet. After following this guide, your PM bot will be able to
delegate tasks to worker bots and track them through the full lifecycle.

## Prerequisites

- AWS account with DynamoDB and S3 access
- Terraform ≥ 1.5 (for applying the infrastructure module)
- FleetMind CLI installed (`npm install -g @continuous-agentics/fleetmind`)
- A `fleet.yaml` with at least one PM bot and one worker bot defined

## Step 1: Provision the task-ledger infrastructure

The task-ledger Terraform submodule ships with FleetMind at [`infra/terraform/modules/task-ledger`](../../infra/terraform/modules/task-ledger). It provisions the DynamoDB table, S3 narrative bucket, and scoped IAM required for delegation; terminal delivery is handled by the agent NATS subscriber installed during bootstrap.

**Canonical path:** consume the embedded `fleetmind` Terraform module using the same FleetMind release tag as the runtime package. The submodule activates automatically when `delegation_enabled = true` in your tfvars.

**Standalone path:** if you need delegation infrastructure without the EC2/VPC stack, use the in-repo [`docs/terraform/TASK-LEDGER-STANDALONE.md`](../terraform/TASK-LEDGER-STANDALONE.md) example.

Either way, note the `table_name` and `s3_bucket` outputs — you'll need them in `fleet.yaml` (next step).

## Step 2: Configure `fleet.yaml`

Add a top-level `delegation` block and per-agent `delegation` blocks:

```yaml
fleet:
  name: my-fleet
  # ... rest of fleet metadata

# Fleet-level delegation settings
delegation:
  enabled: true
  table_name: my-fleet-tasks        # from Terraform output
  s3_bucket: my-fleet-ledger        # from Terraform output
  s3_key_template: "v0/projects/{project}/tasks/{date}-{task_id}.md"
  aws_region: us-east-1

agents:
  defaults:
    model: anthropic/claude-sonnet-4-6

  list:
    - id: pm-bot
      name: Conductor
      emoji: 🎼
      orchestrator: true                                # PM ⇒ orchestrator: true
      delegation:
        worker_bots: [worker-frontend, worker-backend]  # agent IDs from this list
      skills:
        - name: bot-delegation
          source: client
      slack:
        bot_token: ${PM_BOT_TOKEN}
        app_token: ${PM_APP_TOKEN}

    - id: worker-frontend
      name: Pixel
      emoji: 🎨
      delegation:
        specialty: frontend     # used by the PM bot for routing decisions
      skills:
        - name: bot-reception
          source: client
      slack:
        bot_token: ${PIXEL_BOT_TOKEN}
        app_token: ${PIXEL_APP_TOKEN}

    - id: worker-backend
      name: Forge
      emoji: ⚙️
      delegation:
        specialty: backend
      skills:
        - name: bot-reception
          source: client
      slack:
        bot_token: ${FORGE_BOT_TOKEN}
        app_token: ${FORGE_APP_TOKEN}
```

## Step 3: Install the skills

The delegation and reception skills ship with fleetmind in `openclaw/skills/`.
Push them to each bot:

```bash
# PM bot gets bot-delegation
fleetmind push skill bot-delegation --agent pm-bot

# Worker bots get bot-reception
fleetmind push skill bot-reception --agent worker-frontend
fleetmind push skill bot-reception --agent worker-backend

# Or push to all agents that have the skill in fleet.yaml
fleetmind push skill bot-delegation --all
fleetmind push skill bot-reception --all
```

## Step 4: Close-the-loop is NATS-push (no sweeps)

> **Removed in 0.8.0-beta.8:** the `delegation.sweeps` config field and the
> `WORKER_SWEEP` cron procedure. Close-the-loop now runs on the NATS-wake
> turn triggered by the worker's terminal `task.*` event, not on a poll.

Each agent runs a `fleetmind-nats-<agent>.service` subscriber (provisioned by
the terraform module). When a worker publishes `task.shipped` / `task.blocked`,
the PM bot's subscriber wakes the PM on the original delegation thread with
the full event payload. The PM then posts the close-the-loop summary directly
on that wake turn — there is no deferral, no polling, no sweep job.

If you have a legacy fleet with seeded `forge-sweep`-style jobs still in
`~/.openclaw/cron/jobs.json`, remove them once:

```bash
# SSH to the PM instance
openclaw cron list                # find the WORKER_SWEEP job(s)
openclaw cron rm <job-id>         # remove each one
```

`fleetmind deploy` no longer seeds these jobs, so they will not return.

## Step 5: Apply workspace snippets

The `openclaw/pm-bot/workspace/` and `openclaw/worker-bot/workspace/` directories
contain SOUL.md and AGENTS.md templates for each role. Push them to the
corresponding agent workspaces:

```bash
fleetmind deploy fleet.yaml
```

`fleetmind deploy` provisions workspaces and renders configs for each agent.

## Step 6: Verify

Test that the CLI can reach DynamoDB:

```bash
# Create a test task (will fail unless DDB is deployed)
fleetmind task create \
  --project test-project \
  --worker worker-frontend \
  --delegated-by pm-bot \
  --dod "Verify the delegation wiring works" \
  --thread "https://example.com" \
  --envelope-ts "test-$(date +%s)" \
  --lifecycle shipped-is-done \
  --json

# Check it was created (default output is human-readable; pass --json for raw)
fleetmind task get --task-id <task_id_from_above>

# Query pending
fleetmind query pending --project test-project --json

# Clean up (abandon the test task) — pass --project to skip the GetItem round-trip
fleetmind task abandon --task-id <task_id> --project test-project
```

### CLI conventions for transitions

Lifecycle-transition subcommands (`ack`, `ship`, `block`, `signoff`, `abandon`,
`merge`) accept an optional `--project <slug>` flag. When the caller already
knows the project (e.g. from a prior `task get`), passing it skips the
`GetItem` lookup the CLI would otherwise need to update GSI keys. The flag
is backward-compatible: omit it and the CLI fetches the project itself.

```bash
# Without --project (one extra GetItem)
fleetmind task ship --task-id a1b2c3d4 --worker worker-frontend

# With --project (single PutItem; preferred when you already know it)
fleetmind task ship --task-id a1b2c3d4 --worker worker-frontend --project website-rewrite
```

PM-bot and worker-bot skills (`bot-delegation`, `bot-reception`) already
thread `--project` through where it's known.

### Region requirement

fleetmind 0.3.0 fails loud when no AWS region is configured. Set
`delegation.aws_region` in `fleet.yaml`, or export `AWS_REGION` /
`AWS_DEFAULT_REGION` before running CLI commands. Previously the CLI
silently defaulted to `us-east-1`, which produced confusing
`ResourceNotFoundException`s when fleets lived in other regions.

## Agent workflow overview

```
Planning channel                Dev channel
────────────────                ───────────
Human: "Build X"
                ↓
PM bot reads bot-delegation skill
PM bot: fleetmind task create
PM bot: posts envelope ──────────────────→ Worker bot sees envelope
                                           Worker: fleetmind task ack
                                           Worker: :eyes: reaction
                                           Worker does the work
                                           Worker: fleetmind narrative put
                                           Worker: fleetmind task ship
                                           Worker: posts ✅ reply
                       DDB terminal event
                    ←──────────────────────
PM bot wakes (DDB_TERMINAL_WAKE)
PM bot: fleetmind task get
PM bot: fleetmind narrative get
PM bot: posts closeout summary
(if lifecycle=requires-human-signoff)
Human: "LGTM"
PM bot: fleetmind task signoff
PM bot: fleetmind task merge (on PR merge)
```

## Wake script (`ddb-wake.sh`)

The EventBridge Pipe → SSM Run Command calls `/opt/openclaw/ddb-wake.sh` on the
PM bot's EC2 with the session key and DDB primary key as arguments. The script
should:

1. Validate the PK format (`TASK#[0-9a-f]{8}`).
2. Resolve the session UUID from `sessions.json` using the session key.
3. Detach: `setsid openclaw agent --session-id <UUID> --message "DDB_TERMINAL_WAKE: TASK#<task_id>" &`.

The `setsid` detach is critical — SSM Run Command has a 15-second timeout; the
OpenClaw agent session may take longer to process the wake.

Example stub:

```bash
#!/usr/bin/env bash
# /opt/openclaw/ddb-wake.sh <session_key> <pk>
set -euo pipefail

SESSION_KEY="$1"
PK="$2"

# Validate PK format
if [[ ! "$PK" =~ ^TASK#[0-9a-f]{8}$ ]]; then
  echo "ERROR: unexpected PK format: $PK" >&2
  exit 1
fi

TASK_ID="${PK#TASK#}"

# Resolve session UUID
SESSION_UUID=$(jq -r --arg key "$SESSION_KEY" '.[$key]' /home/openclaw/.openclaw/sessions.json 2>/dev/null)
if [ -z "$SESSION_UUID" ] || [ "$SESSION_UUID" = "null" ]; then
  echo "ERROR: session key not found: $SESSION_KEY" >&2
  exit 1
fi

# Detach the wake invocation
setsid openclaw agent \
  --session-id "$SESSION_UUID" \
  --message "DDB_TERMINAL_WAKE: TASK#${TASK_ID}" \
  </dev/null >/dev/null 2>&1 &

echo "Dispatched wake for task ${TASK_ID} to session ${SESSION_UUID}"
```

## Troubleshooting

**`delegation is not enabled` error from CLI**
→ Check that `delegation.enabled = true` and `delegation.table_name` are set in `fleet.yaml`.

**`ConditionalCheckFailedException` on ack/ship/block**
→ The task is in an unexpected state. Use `fleetmind task get --task-id <hex>` to check current status.

**S3 write failed, fallback written locally**
→ Check `~/.fleetmind/ledger-pending/` for pending files. Retry:
```bash
cat ~/.fleetmind/ledger-pending/<task-id>-shipped.md | fleetmind narrative put --task-id <task-id>
```

**PM bot not waking on terminal events**
→ The wake path is NATS-push:

1. Check the PM's `fleetmind-nats-<agent>.service` is `active (running)`:
   `systemctl status fleetmind-nats-<pm-id>`.
2. Confirm the worker actually published — `journalctl -u fleetmind-nats-<worker-id>`
   should show a `task.shipped` or `task.blocked` log line.
3. If both subscribers are healthy and no wake fired, check the PM's gateway
   log for an openclaw CLI invocation around the publish time — the session
   key may not be matching any active session (PM is in a different thread).

**`task create` fails with "already exists"**
→ Regenerate the task ID (8 new hex bytes) and retry. Task IDs must be unique.
