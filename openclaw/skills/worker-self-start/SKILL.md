---
name: worker-self-start
version: 1.0.0
description: >
  Worker Self-Start Protocol. Use when: (1) a human asks you to do something
  without a PM bot delegation, (2) you notice a Linear issue assigned to you
  that has no corresponding delegation, (3) you need to push back on an
  unlinked feature request, or (4) you are a PM bot receiving a worker
  self-start notice in the planning channel. Covers the approval signal
  (Linear assignment), push-back phrasing, self-start notification format,
  DDB row creation (ordering + idempotency per SF-2), and the PM bot's
  inbound handler.
---

# Worker Self-Start Protocol

> **NATS-model note:** This skill was written for fleetmind fleets using NATS
> transport (v1.2.0+ of `bot-reception` and `bot-delegation`). There is no
> "delegation channel" in NATS fleets — delegation is over NATS, not Slack.
> Self-start notices go to the PM bot's planning channel instead.

## The core rule

**Linear assignment = approval.** When a Linear issue is assigned to you, you
may begin work without waiting for a PM bot delegation. For everything else,
push back.

---

## Step 0 — Classify the inbound request

| Check | Action |
|-------|--------|
| NATS delegation event arrived (from PM bot) | → Follow `bot-reception`. This skill does not apply. |
| Linear issue exists, assigned to me | → § Self-start flow |
| Human asks for new work, no Linear issue, or issue not assigned to me | → § Push-back |
| Research spike / design question (< 1 day, no Linear issue) | → § Informal start |

---

## Push-back

When a human asks for new feature work without a linked, me-assigned Linear issue:

1. Reply once in the same channel/thread:
   ```
   This looks like new feature scope — can you create a Linear issue and assign
   it to me? I'll kick off as soon as it's linked. (If there's already an issue,
   share the link and I'll start now.)
   ```
2. Stop. Do not implement anything.
3. When they share the Linear URL: verify it is assigned to you, then follow
   § Self-start flow.

One reply, no repeats, no caveats.

---

## Self-start flow

> **SF-2 fix — create the DDB row BEFORE posting the Slack notice.**
> Creating the row first, with `attribute_not_exists(PK)`, ensures the PM
> inbound handler never races the worker and double-creates the same task.
> The PM handler's recovery-path `task create` uses the same conditional write
> and is therefore idempotent even if it fires concurrently.

### Step 1. Generate a task ID

```bash
TASK_ID=$(openssl rand -hex 4)
```

### Step 2. Write to `memory/task-queue.md` first (crash-recovery record)

Add to `## In Progress`:
```
- **<TASK_ID>** — <one-line summary> | self-start | Linear: <url>
```

### Step 3. Create the DDB row (before posting any notice)

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

Key flags:
- `--lifecycle requires-human-signoff` — human sign-off is required before the
  row transitions to `signed_off`. This is enforced by the `mergeTask`
  conditional write in the DDB ledger (PR #236). **Note:** there is a known
  gap tracked in #237 where raw AWS credentials can bypass the CLI — the
  ledger enforces this only at the CLI level, not at IAM level. Do not
  overclaim IAM-level enforcement.
- `--delegated-by <your-agent-id>` — self-delegation; the PM bot did not
  create this row.
- `--tracker` is mandatory for Linear-assigned self-starts.
- `--thread` is intentionally omitted here (the Slack notice doesn't exist yet).
  The `delegation_thread` field will be unset; PM bot wakes for ship/block
  events on this task will fall back to the `:main` session rather than a
  specific planning thread. This is a known limitation of the NATS-ordered
  self-start flow (SF-2 compliance takes precedence).

`fleetmind task create` uses `attribute_not_exists(PK)` — so a duplicate
create (from a PM inbound handler racing this call) is a no-op that returns
a `ConditionalCheckFailedException`. Both paths are safe.

### Step 4. Self-acknowledge (advance from `delegated` to `accepted`)

```bash
fleetmind task ack \
  --task-id "${TASK_ID}"       \
  --worker  <your-agent-id>    \
  --project <best-fit-project-slug>
```

`fleetmind task create` always starts the row at `delegated`. There is no
`--status` flag; you must call `task ack` explicitly.

### Step 5. Post self-start notice in the PM bot's planning channel

Post a top-level message (not a thread reply) in the PM bot's planning channel
**within 60 seconds of beginning work**. Do NOT post this notice if the PM bot
already delegated this Linear issue to you via NATS.

```
<@PM_BOT_SLACK_ID> — self-start notice

Worker: <your name and emoji>
Linear: <full Linear issue URL>
Task ID: <TASK_ID>
Summary: <one sentence — what you're starting and why>
```

> **Channel note:** In NATS fleets, the "delegation channel" no longer exists.
> Post in the PM bot's planning channel (where humans interact with the PM bot),
> not in your own channel or a separate coordination channel.

Also post a brief note in your own home channel for local visibility:
```
🏃 Self-starting on <Linear issue title> (TASK#<TASK_ID>). Linear: <url>
```

### Step 6. Do the work silently

Follow the same voice discipline as delegated tasks (no "working on it…" posts).

### Step 7. Ship

Follow the `bot-reception` ship pattern:
1. Write narrative to S3 (`fleetmind narrative put --event shipped`)
2. Update DDB (`fleetmind task ship`)

`fleetmind task ship` publishes a NATS `ship` event. The PM bot receives it
and handles the DDB lifecycle. Human sign-off is required before `signed_off`
(the signoff watchdog monitors overdue shipped-but-unsigned tasks).

---

## Informal start (research spike / design question)

When doing a short-horizon spike (< 1 day) with no Linear issue:
- No self-start notice required if it stays under 1 day.
- If the spike produces real deliverable work, convert it: generate a task ID,
  create a DDB row with `--lifecycle shipped-is-done` (no human sign-off
  required for spikes), self-ack, post a self-start notice, and proceed.
  Note: `--lifecycle informal` is not a valid CLI option — use
  `--lifecycle shipped-is-done` for untracked work.

---

## PM bot: inbound self-start handler

> Read this section when you are the **PM bot** and a worker posts a
> self-start notice in the planning channel.

**Recognising a self-start notice:** a Slack message in the planning channel
from a worker bot containing `"— self-start notice"` with a `Task ID:` and
`Linear:` field.

**Handler — run inline (no sub-agent needed for the initial receipt):**

### 1. Verify the Linear assignment

Fetch the Linear issue from the notice URL (use the `linear-fleet` skill).
Confirm it is assigned to the notifying worker.
- If NOT assigned: reply in thread:
  ```
  Linear issue is not assigned to you — cannot register this self-start.
  ```
  Take no further action.

### 2. React `:white_check_mark:` to the notice

### 3. Resolve the project slug (before any DDB operation)

Inspect the Linear issue's labels and project to determine the correct
`--project` slug for the DDB row.

If labels are **missing** or **ambiguous** (multiple project labels, no
recognisable fleet project label, or the label doesn't map to a known slug):
**do NOT guess.** Reply in the notice thread:
```
@<worker> — I can't determine the project slug from this issue's labels.
Can you confirm which project this belongs to? (e.g. `ca-core`, `ca-infra`)
```
Wait for clarification before any DDB operation.

### 4. Check DDB for the task row

```bash
fleetmind task get --task-id <8-char-hex from notice> --json
```

**Row EXISTS** → no DDB action needed; the worker created it correctly
(the normal, SF-2-compliant path). Skip to step 5.

**Row MISSING** → recovery path; create it on behalf of the worker
(worker crashed or failed before step 3). Use `attribute_not_exists(PK)` to
make this idempotent — if the worker's row creation races your recovery,
the first write wins and the second is a safe no-op:

```bash
fleetmind task create \
  --project <resolved project slug>       \
  --worker  <notifying-worker-id>         \
  --delegated-by <notifying-worker-id>    \
  --dod "<from Linear issue title>"       \
  --thread "<notice message Slack permalink>" \
  --tracker "<Linear URL from notice>"    \
  --lifecycle requires-human-signoff      \
  --task-id <8-char-hex from notice>      \
  --json

fleetmind task ack \
  --task-id <8-char-hex from notice>      \
  --worker  <notifying-worker-id>         \
  --project <resolved project slug>
```

If `task create` fails with a condition error, the worker's row already
exists — treat as "Row EXISTS" above.

### 5. Do NOT post a delegation envelope

The worker is already running; a NATS delegation event would trigger a
duplicate ack and a duplicate DDB lifecycle transition.

### 6. Record in `memory/active-delegations.md`

Add under `## Active` in the same format as a PM-delegated task, but mark
it `[self-start]` in the notes column. The task then enters the normal
signoff-watchdog lifecycle — human sign-off is required before `signed_off`.

---

## Hard limits

- ❌ NEVER self-start on infrastructure changes (Terraform, AWS API writes) without a PR.
- ❌ NEVER pick up a Linear issue assigned to another worker.
- ❌ NEVER widen issue scope without sign-off from the human or PM bot.
- ❌ NEVER post the self-start notice before the DDB row exists (SF-2 ordering).
- ❌ NEVER claim IAM-level enforcement of requires-human-signoff — the ledger
  enforces this at the CLI boundary only (#237 tracks the IAM gap).
- ✅ DO create a DDB row for every self-started Linear task.
- ✅ DO push back on unlinked feature requests — every time, no exceptions.
- ✅ DO create the DDB row with `attribute_not_exists(PK)` before any Slack notice.

---

## Changelog

- **1.0.0 (2026-07-09)** — Initial release (re-authored from CON-91 PR #169 onto
  NATS transport model). Key changes from the pre-NATS design:
  - Removed "delegation channel" concept (does not exist in NATS fleets).
    Self-start notice now goes to PM bot's planning channel.
  - Removed `--envelope-ts` from self-start flow; field is optional/irrelevant
    in NATS fleets and is not available at DDB-row-create time (SF-2 ordering).
  - SF-2 fix: DDB row created BEFORE Slack notice (steps 3→5 reordered).
    PM inbound handler uses `attribute_not_exists(PK)` for idempotency.
  - `--lifecycle informal` corrected to `--lifecycle shipped-is-done` in
    informal-spike conversion (not a valid CLI option).
  - Human-signoff prose clarified: ledger enforces at CLI boundary; IAM gap
    tracked in #237 (does not close #237).
