# Enabling Delegation in a Fleet

This guide covers how to configure and deploy the task-ledger delegation feature
in a fleetmind fleet. After following this guide, your PM bot will be able to
delegate tasks to worker bots and track them through the full lifecycle.

## Prerequisites

- AWS account with DynamoDB and S3 access
- Terraform ≥ 1.5 (for applying the infrastructure module)
- fleetmind CLI installed (`npm install -g fleetmind`)
- A `fleet.yaml` with at least one PM bot and one worker bot defined

## Step 1: Apply the Terraform module

The `infra/terraform/modules/task-ledger/` module creates the DynamoDB table,
S3 bucket, IAM policies, and EventBridge wake pipeline.

Create a consuming Terraform root (or add to your existing fleet infra):

```hcl
# infra/terraform/my-fleet/main.tf

terraform {
  required_version = ">= 1.5.0"

  backend "s3" {
    bucket  = "my-terraform-state"
    key     = "my-fleet/task-ledger.tfstate"
    region  = "us-east-1"
    encrypt = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

module "task_ledger" {
  source = "../../../infra/terraform/modules/task-ledger"

  name_prefix    = "my-fleet-"
  aws_region     = "us-east-1"

  # Existing IAM role names (created by your bot EC2 module)
  pm_role_names     = ["my-fleet-pm-bot-role"]
  worker_role_names = ["my-fleet-worker-bot-role"]

  # Wake signaling: SSM Run Command target
  wake_target_instance_tag_key   = "Name"
  wake_target_instance_tag_value = "my-fleet-pm-bot"
  wake_target_session_key        = "agent:main:slack:channel:C123456789"

  # Optional: email for DLQ alarm notifications
  alert_email = "oncall@my-org.example.com"

  tags = {
    product = "my-fleet"
    env     = "production"
  }
}

output "table_name"   { value = module.task_ledger.table_name }
output "s3_bucket"    { value = module.task_ledger.s3_bucket_name }
output "pm_policy"    { value = module.task_ledger.pm_policy_arn }
output "worker_policy"{ value = module.task_ledger.worker_policy_arn }
```

Apply it:

```bash
cd infra/terraform/my-fleet
terraform init
terraform plan
terraform apply
```

Note the `table_name` and `s3_bucket` outputs — you'll need them in `fleet.yaml`.

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

## Step 4: Configure WORKER_SWEEP cron jobs

The PM bot needs recurring sweep jobs to poll each worker's in-flight tasks
and close the loop on terminal updates. These are seeded directly into the PM
bot's OpenClaw cron scheduler — **no additional AWS infrastructure is required**.

Add a `sweeps` block to the PM bot's `delegation` config in `fleet.yaml`:

```yaml
agents:
  list:
    - id: pm-bot
      orchestrator: true
      delegation:
        worker_bots: [worker-frontend, worker-backend]
        sweeps:
          - name: pm-sweep-worker-frontend
            worker_id: worker-frontend
            every: 5m
            model: haiku      # cost-optimised; same tier as heartbeat jobs
            description: "Poll Pixel's in-flight tasks for terminal status updates"
          - name: pm-sweep-worker-backend
            worker_id: worker-backend
            every: 5m
            model: haiku
            description: "Poll Forge's in-flight tasks for terminal status updates"
```

`fleetmind deploy` reads the `sweeps` block and idempotently seeds each job
into `~/.openclaw/cron/jobs.json` on the PM instance. The gateway hot-reloads
the file — no restart required.

**Schedule options:**

| Field | Example | When to use |
|---|---|---|
| `every` | `"5m"` | Simple fixed interval |
| `cron_expr` + `tz` | `"*/5 9-17 * * 1-5"` + `"America/Los_Angeles"` | Business-hours-only sweeps |

**Idempotency:** Re-running `fleetmind deploy` skips jobs whose `name` is
already registered in `jobs.json`. This means manual edits made via
`openclaw cron edit` on the PM instance survive subsequent deploys. To reset
a job to its fleet.yaml definition, remove it manually:

```bash
# SSH to the PM instance
openclaw cron rm <job-id>       # removes from jobs.json
fleetmind deploy fleet.yaml     # re-seeds from fleet.yaml
```

**Operations:**

```bash
# On the PM bot instance — check sweep jobs
openclaw cron list

# Inspect a specific sweep
openclaw cron show <job-id>

# Force-run a sweep now (useful after an incident)
openclaw cron run <job-id>

# View recent sweep run history
openclaw cron runs --id <job-id> --limit 20
```

**How WORKER_SWEEP works at runtime:**

Each sweep fires an isolated agent turn with `WORKER_SWEEP: <worker_id>`. The
PM bot's WORKER_SWEEP procedure (see `openclaw/pm-bot/workspace/AGENTS.md`):

1. Queries DDB for `delegated` / `acked` tasks owned by the target worker.
2. Checks each delegation thread for a terminal reply (`:white_check_mark:` or `:no_entry:`).
3. Transitions any newly terminal tasks and spawns close-the-loop sub-agents.
4. Replies `NO_REPLY` (silent run).

The sweep is the resilience layer: it closes the loop when the DDB stream wake
(EventBridge Pipe → SSM) missed a delivery or when the PM gateway was restarting
when the worker's terminal reply arrived.

## Step 5: Apply workspace snippets

The `openclaw/pm-bot/workspace/` and `openclaw/worker-bot/workspace/` directories
contain SOUL.md and AGENTS.md templates for each role. Push them to the
corresponding agent workspaces:

```bash
fleetmind deploy fleet.yaml
```

`fleetmind deploy` provisions workspaces, renders configs, and seeds cron
sweep jobs into `~/.openclaw/cron/jobs.json` for each PM bot.

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
→ Two wake paths exist:

1. **DDB stream wake** (fast, event-driven): Check the Pipe DLQ
   (`{prefix}ledger-pipe-dlq`) and wake DLQ (`{prefix}ledger-wake-dlq`) in
   the AWS console. Common causes: IAM permission on SSM SendCommand, wrong
   tag value for instance targeting, session key not in `sessions.json`.

2. **WORKER_SWEEP** (polling, resilience layer): Check sweep jobs on the PM
   instance — `openclaw cron list` and `openclaw cron runs --id <job-id>`.
   If sweeps aren't registered, re-run `fleetmind deploy fleet.yaml`.

**WORKER_SWEEP jobs missing after gateway restart**
→ Sweep jobs persist in `jobs.json` and survive gateway restarts. If they're
   missing, `jobs.json` may have been deleted or corrupted. Re-seed:
   ```bash
   fleetmind deploy fleet.yaml
   ```

**`task create` fails with "already exists"**
→ Regenerate the task ID (8 new hex bytes) and retry. Task IDs must be unique.
