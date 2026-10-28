# Independent fleet self-start flow — full detail

Direct/solo work and same-Gateway native children do not use this flow. Children report privately; the parent owns public closeout. Independent fleet work requires delegation enabled and a safe configured ownership/dispatch path. The current CLI may auto-publish a NATS assignment on `task create`, including self-start; if duplicate execution cannot be excluded, stop registration and report the producer gap. Do not start a subscriber to work around it.

**SF-2: create the DDB row BEFORE posting any self-start notice.** `attribute_not_exists(PK)` makes a concurrent PM recovery write an idempotent no-op.

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
- `--thread` — use an existing trusted originating URL when available. A missing route is not a guarantee of a resumed coordinator; preserve it as a delivery gap.

`fleetmind task create` uses `attribute_not_exists(PK)` — a duplicate create may return a conditional failure; reread and verify the existing row/owner before treating it as handled. Never create a second task to retry.

## Step 3. Self-acknowledge (`delegated` → `accepted`)

Reread DDB and verify worker identity and actual pickup. If the configured
legacy subscriber already advanced the row, verify it instead of acknowledging
again. An accepted row alone does not prove native execution or human approval.
Only acknowledge a still-delegated task that you are actually taking:

```bash
fleetmind task ack \
  --task-id "${TASK_ID}"       \
  --worker  <your-agent-id>    \
  --project <best-fit-project-slug>
```

If a conditional transition fails, reread the record; confirm owner and state rather than assuming another consumer accepted it safely.

## Step 4. Post self-start notice in the PM bot's planning channel

Use the configured coordination route and provider-appropriate mention. Skip self-start registration for an existing assignment. The following mention is a **legacy Slack example**; other providers use their supported routing/mention syntax. Native children do not send this notice.

```
<@PM_BOT_SLACK_ID> — self-start notice

Worker: <your name and emoji>
Tracker: <issue URL if provided, otherwise "none">
Task ID: <TASK_ID>
Summary: <one sentence — what you're starting and why>
```

If an independent worker home-channel update is authorized:

```
🏃 Self-starting on <task summary> (TASK#<TASK_ID>).<if tracker: " Tracker: <url>">
```

## Step 5. Do the work silently

Same voice discipline as delegated tasks (no "working on it…" posts).

## Step 6. Ship

1. Write narrative to S3 (`fleetmind narrative put --event shipped`)
2. `fleetmind task ship` — updates the ledger and attempts legacy NATS publication when configured. The parent reviews and handles authorized lifecycle transitions; delivery/recovery is not guaranteed by publication. Human approval is required before `signed_off`; PR work finishes only at verified `merged`.
