# Self-start flow — full detail

**SF-2: create the DDB row BEFORE posting the Slack notice.** `attribute_not_exists(PK)` makes a concurrent PM recovery write an idempotent no-op.

## Step 1. Generate a task ID

```bash
TASK_ID=$(openssl rand -hex 4)
```

## Step 2. Create the DDB row (before any notice)

```bash
fleetmind task create \
  --project <best-fit-project-slug>         \
  --worker  <your-agent-id>                 \
  --delegated-by <your-agent-id>            \
  --dod "<definition of done — one line>"   \
  --tracker "<tracker URL if provided>"     \
  --lifecycle requires-human-signoff        \
  --task-id  "${TASK_ID}"                   \
  --json
```

- `--lifecycle requires-human-signoff` — sign-off enforced by the ledger conditional-write (`ConditionExpression` in `TaskLedger`, PR #236). Not enforced at IAM level; raw-SDK bypass is the known gap tracked in #237.
- `--delegated-by <your-agent-id>` — self-delegation; PM bot did not create this row.
- `--tracker` — optional. Include when the human provides a tracker URL (Linear, Jira, GitHub Issues, or any other system). Omit if no ticket was referenced.
- `--thread` — omit here (notice not yet posted). PM bot falls back to `:main` session for ship/block wakes. SF-2 takes precedence over this limitation.

`fleetmind task create` uses `attribute_not_exists(PK)` — a duplicate create from a racing PM recovery write is a safe no-op returning `ConditionalCheckFailedException`.

## Step 3. Self-acknowledge (`delegated` → `accepted`)

If your worker-mode NATS subscriber (`fleetmind nats subscribe --mode worker`) is running, it will **auto-ack** this delegation the moment `fleetmind task create` publishes the NATS `delegation` event — no manual step needed.

Only run `task ack` manually if the row is still `delegated` (subscriber was not running when the row was created):

```bash
fleetmind task ack \
  --task-id "${TASK_ID}"       \
  --worker  <your-agent-id>    \
  --project <best-fit-project-slug>
```

If this fails with `TaskConditionError`, the subscriber already acked it — treat that as a no-op (already accepted).

## Step 4. Post self-start notice in the PM bot's planning channel

Post a **top-level message** (not a reply) within 60 seconds of beginning work. Skip if the PM bot already delegated this via NATS.

```
<@PM_BOT_SLACK_ID> — self-start notice

Worker: <your name and emoji>
Tracker: <issue URL if provided, otherwise "none">
Task ID: <TASK_ID>
Summary: <one sentence — what you're starting and why>
```

Also in your home channel:

```
🏃 Self-starting on <task summary> (TASK#<TASK_ID>).<if tracker: " Tracker: <url>">
```

## Step 5. Do the work silently

Same voice discipline as delegated tasks (no "working on it…" posts).

## Step 6. Ship

1. Write narrative to S3 (`fleetmind narrative put --event shipped`)
2. `fleetmind task ship` — publishes NATS `ship` event. PM bot handles DDB lifecycle. Human sign-off required before `signed_off`.
