---
name: worker-self-start
version: 1.0.0
description: "Linear assignment is approval to self-start without a PM bot delegation. Use when a Linear issue is assigned to you but no delegation has arrived, or when pushing back on unlinked feature requests. PM bots receiving a worker self-start notice: see bot-delegation § Inbound Self-Start Notices."
---

# Worker Self-Start Protocol

> NATS fleets only — no "delegation channel"; self-start notices go to the PM bot's planning channel.

## The core rule

**Linear assignment = approval.** When a Linear issue is assigned to you, begin work without waiting for a PM bot delegation. Everything else: push back.

---

## Step 0 — Classify the inbound request

| Check | Action |
|-------|--------|
| NATS delegation event arrived (from PM bot) | → `bot-reception`. This skill doesn't apply. |
| Linear issue assigned to me | → § Self-start flow |
| No Linear issue, or issue not assigned to me | → § Push-back |
| Spike / design question (< 1 day, no issue) | → § Informal start |

---

## Push-back

When asked for new feature work without a linked, me-assigned Linear issue:

1. Reply once: `This looks like new feature scope — can you create a Linear issue and assign it to me? I'll kick off as soon as it's linked. (If there's already an issue, share the link and I'll start now.)`
2. Stop. Do not implement anything.
3. When they share the Linear URL: verify assigned to you → § Self-start flow.

One reply, no repeats, no caveats.

---

## Self-start flow

**SF-2: create the DDB row BEFORE posting the Slack notice.** `attribute_not_exists(PK)` makes a concurrent PM recovery write an idempotent no-op.

### Step 1. Generate a task ID

```bash
TASK_ID=$(openssl rand -hex 4)
```

### Step 2. Write to `memory/task-queue.md` (crash recovery)

Add to `## In Progress`:
```
- **<TASK_ID>** — <summary> | self-start | Linear: <url>
```

### Step 3. Create the DDB row (before any notice)

```bash
fleetmind task create \
  --project <best-fit-project-slug>         \
  --worker  <your-agent-id>                 \
  --delegated-by <your-agent-id>            \
  --dod "<definition of done — one line>"   \
  --tracker "<Linear issue URL>"            \
  --lifecycle requires-human-signoff        \
  --task-id  "${TASK_ID}"                   \
  --json
```

- `--lifecycle requires-human-signoff` — sign-off enforced by the ledger conditional-write (`ConditionExpression` in `TaskLedger`, PR #236). Not enforced at IAM level; raw-SDK bypass is the known gap tracked in #237.
- `--delegated-by <your-agent-id>` — self-delegation; PM bot did not create this row.
- `--tracker` — mandatory for Linear-assigned self-starts.
- `--thread` — omit here (notice not yet posted). PM bot falls back to `:main` session for ship/block wakes. SF-2 takes precedence over this limitation.

`fleetmind task create` uses `attribute_not_exists(PK)` — a duplicate create from a racing PM recovery write is a safe no-op returning `ConditionalCheckFailedException`.

### Step 4. Self-acknowledge (`delegated` → `accepted`)

If your worker-mode NATS subscriber (`fleetmind nats subscribe --mode worker`) is running, it will **auto-ack** this delegation the moment `fleetmind task create` publishes the NATS `delegation` event — no manual step needed.

Only run `task ack` manually if the row is still `delegated` (subscriber was not running when the row was created):

```bash
fleetmind task ack \
  --task-id "${TASK_ID}"       \
  --worker  <your-agent-id>    \
  --project <best-fit-project-slug>
```

If this fails with `TaskConditionError`, the subscriber already acked it — treat that as a no-op (already accepted).

### Step 5. Post self-start notice in the PM bot's planning channel

Post a **top-level message** (not a reply) within 60 seconds of beginning work. Skip if the PM bot already delegated this via NATS.

```
<@PM_BOT_SLACK_ID> — self-start notice

Worker: <your name and emoji>
Linear: <full Linear issue URL>
Task ID: <TASK_ID>
Summary: <one sentence — what you're starting and why>
```

Also in your home channel:
```
🏃 Self-starting on <Linear issue title> (TASK#<TASK_ID>). Linear: <url>
```

### Step 6. Do the work silently

Same voice discipline as delegated tasks (no "working on it…" posts).

### Step 7. Ship

1. Write narrative to S3 (`fleetmind narrative put --event shipped`)
2. `fleetmind task ship` — publishes NATS `ship` event. PM bot handles DDB lifecycle. Human sign-off required before `signed_off`.

---

## Informal start (spike / design question, < 1 day)

- Notice not required while work stays under 1 day.
- If it produces real deliverables: generate task ID, create DDB row with `--lifecycle shipped-is-done`, self-ack, post notice, proceed.
- `--lifecycle informal` is not a valid CLI option.

---

## PM inbound handler

PM bot receiving a worker self-start notice in the planning channel → see
[references/pm-inbound-handler.md](references/pm-inbound-handler.md).

---

## Hard limits

- ❌ Never self-start infrastructure changes (Terraform, AWS API writes) without a PR.
- ❌ Never pick up a Linear issue assigned to another worker.
- ❌ Never widen scope without human or PM bot sign-off.
- ❌ Never post the self-start notice before the DDB row exists (SF-2).
- ❌ Never claim IAM-level enforcement of `requires-human-signoff` (#237 tracks the gap).
- ✅ Create a DDB row for every self-started Linear task.
- ✅ Push back on unlinked feature requests — every time.
- ✅ Use `attribute_not_exists(PK)` on DDB row create.

---

## Changelog

- **1.0.0 (2026-07-09)** — Initial release (CON-91, re-authored from PR #169 onto NATS transport): no "delegation channel"; SF-2 ordering (DDB before notice); `attribute_not_exists(PK)` idempotency; `--lifecycle shipped-is-done` (not `informal`); IAM gap (#237); PM inbound handler moved to references/.
