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
      orchestrator: true
      role: project-manager
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
      role: worker
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
      role: worker
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

## Step 4: Apply workspace snippets

The `openclaw/pm-bot/workspace/` and `openclaw/worker-bot/workspace/` directories
contain SOUL.md and AGENTS.md templates for each role. Push them to the
corresponding agent workspaces:

```bash
fleetmind deploy fleet.yaml
```

`fleetmind deploy` provisions workspaces and renders configs. The delegation
workspace files are picked up automatically based on the `role` field in fleet.yaml.

## Step 5: Verify

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
→ Check the Pipe DLQ (`{prefix}ledger-pipe-dlq`) and wake DLQ (`{prefix}ledger-wake-dlq`)
   in the AWS console. Common causes: IAM permission on SSM SendCommand, wrong
   tag value for instance targeting, session key not in `sessions.json`.

**`task create` fails with "already exists"**
→ Regenerate the task ID (8 new hex bytes) and retry. Task IDs must be unique.
