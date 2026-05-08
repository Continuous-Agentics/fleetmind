---
name: bot-delegation
version: 1.0.0
description: >
  Delegate concrete dev work from a project-manager bot to worker bots,
  track through completion, and report back to the planning channel.
  Covers specialty-based worker routing, task ID generation, writing the
  DynamoDB task record via `fleetmind task create`, posting the delegation
  envelope in the target channel, watching for acknowledgement and threaded
  replies, escalating stale tasks on heartbeat, and closing the loop.
  Use when: (1) a planning conversation produces a concrete task with a clear
  definition of done and an assignee, (2) a worker bot reply lands and needs
  processing, (3) a heartbeat finds an active delegation past its deadline,
  (4) a DDB_TERMINAL_WAKE signal arrives.
  Triggers on phrases like "delegate this", "assign this", "hand off to
  <worker>", or any reply from a worker bot in an active delegation thread.
---

# Bot Delegation Protocol

This is the protocol for handing concrete work from a project-manager (PM) bot
to worker bots and tracking it through completion. The task ledger is the
canonical state store — DynamoDB for structured state, S3 for narrative content.
The fleet CLI (`fleetmind task`, `fleetmind narrative`, `fleetmind query`) does
the heavy lifting so the skill stays focused on coordination logic.

## Vocabulary

| Audit log state | DDB `status` |
|---|---|
| `pending` | `delegated` |
| `acked` | `accepted` |
| `in-review` | `shipped` + `lifecycle = requires-human-signoff` |
| `done` | `signed_off` (human approved) or `merged` (PR merged) |
| `blocked` | `blocked` |

The audit log (`memory/active-delegations.md`) is a human-readable supplement;
DDB is the live source of truth. Always query DDB for programmatic decisions.

## When to start a delegation

Only when the task is concrete. It MUST have:
- One-line summary
- Definition of done (what "done" looks like, not how)
- Assignee bot (worker agent ID from fleet.yaml)
- Target channel

If any are missing, push back to the human first. Do not delegate vague work.

## Step-by-step

### 1. Generate a task ID

8-character lowercase hex. Used to correlate the delegation envelope, DDB
record, and S3 narrative.

```bash
TASK_ID=$(python3 -c "import secrets; print(secrets.token_hex(4))")
# Or: openssl rand -hex 4
```

### 2. Write the task record to DynamoDB

Before posting the envelope, create the ledger record:

```bash
fleetmind task create \
  --project <project-slug> \
  --worker <worker-agent-id-or-slack-id> \
  --delegated-by <pm-bot-id> \
  --dod "<definition of done>" \
  --thread "<coordination-thread-url>" \
  --envelope-ts "<placeholder-ts-or-draft>" \
  --lifecycle requires-human-signoff \
  --task-id "${TASK_ID}" \
  --json
```

If `task create` exits non-zero with "already exists": regenerate the task ID.
If it fails with a network/permissions error: proceed with posting the envelope
anyway, log the failure in `memory/active-delegations.md` (field:
`ledger_write_failed: <reason>`), and retry on the next heartbeat.

**Picking the project slug:**
- A project is a durable initiative, not a single task. "website-rewrite" is a
  project; "add-date-filter" is a delegation inside it.
- Reuse an existing slug before creating a new one:
  ```bash
  fleetmind query pending --json | jq '[.delegated[].project, .accepted[].project] | unique'
  ```
- Slug format: lowercase, hyphen-separated, ≤30 chars.

**The `task_s3_key` is deterministic** — computed from the project slug, today's
UTC date, and task ID. It is stored in DDB at write time. The worker writes to
that exact path when done; the PM bot can fetch it later without listing S3.

### 3. Post the delegation envelope

In the worker's channel (do NOT reply in a thread — this must be a new top-level
message):

```
@<worker-bot> — task assignment

*Task:* <one-line summary>
*Task ID:* <8-char hex>
*Context:* <2-3 sentences, links if any>
*Definition of done:* <what "done" looks like>

React :eyes: when started. Reply in this thread (mentioning @<pm-bot>) when done or blocked.
```

Do NOT include external tracker IDs in the envelope — workers don't use them.

### 4. Update the audit log

Append a block to `memory/active-delegations.md` under `## Active`:
- `task_id`, `created` (ISO timestamp), `deadline` (created + 10 min)
- `status: pending`, `project`, `worker`
- `thread`: the envelope message timestamp
- `ledger_ddb_key`: `TASK#<task_id>`

### 5. Watch for responses

| Signal | Action |
|--------|--------|
| `:eyes:` reaction on the envelope | Status → acked in audit log; extend deadline +10 min |
| Worker threaded reply with ship terminal (✅, "done", "shipped", "PR merged") | Close the loop (step 7) |
| Worker threaded reply with block terminal (⛔, "blocked", "stuck", "need help") | Close as blocked (step 7) |
| `DDB_TERMINAL_WAKE: TASK#<task_id>` message from the wake script | See § DDB Terminal Wake |
| Heartbeat finds expired deadline | See § Escalation |

**Semantic terminal signals**: ✅ and ⛔ are canonical examples, not literal
triggers. Read the meaning ("done", "merged", "deployed" = ship; "blocked",
"stuck", "need X" = blocked). When ambiguous, treat as terminal.

### 5a. DDB Terminal Wake

When `DDB_TERMINAL_WAKE: TASK#<task_id>` arrives:

1. Parse the task_id.
2. Read the DDB record:
   ```bash
   fleetmind task get --task-id "${TASK_ID}" --json
   ```
3. Check the `status` field. If `merged` or `abandoned` — duplicate wake, skip.
4. Check the audit log for duplicate `shipped` re-deliveries:
   if the task is already in `## Closed` in `active-delegations.md`, skip.
5. Otherwise: close the loop (step 7).

### 6. Stale task escalation (heartbeat)

```bash
# Tasks past their deadline
fleetmind query stale \
  --project <current-project> \
  --delegated-threshold 10 \
  --accepted-threshold 60 \
  --json
```

For each stale task: post in the planning thread, update audit log to `escalated`.

**DDB write retry on heartbeat**: if `ledger_write_failed` is set in the audit
log for a task, retry `fleetmind task create` on this heartbeat.

### 7. Close the loop

On terminal status (shipped or blocked):

1. Read the DDB record: `fleetmind task get --task-id "${TASK_ID}" --json`.
   Capture `${PROJECT}` from the response — you'll thread it into the
   subsequent transitions to skip the GetItem round-trip on each.
2. Read the narrative from S3 (for the closeout summary context):
   ```bash
   fleetmind narrative get --task-id "${TASK_ID}"
   ```
3. Post a summary in the planning thread:
   - Task ID, worker, outcome (shipped / blocked)
   - One-line summary of what got done (or what's blocked + what's needed)
   - Link to artifact (PR, deploy, etc.)
   - Reference to the S3 narrative key (humans can read it via `fleetmind narrative get`)
4. If lifecycle = `requires-human-signoff` and status = `shipped`: transition to
   `in-review` in the audit log. Wait for human signoff before closing.
5. On human signoff: `fleetmind task signoff --task-id "${TASK_ID}" --project "${PROJECT}"`
   Then update audit log to done.
6. On PR merge: `fleetmind task merge --task-id "${TASK_ID}" --project "${PROJECT}"`
7. Move delegation block from `## Active` to `## Closed` in audit log.

### Lifecycle: worker-shipped ≠ milestone-done

When `lifecycle = requires-human-signoff` (default), the worker's ✅ reply is
*not* enough to close. Two-step:

1. Worker ships → DDB at `shipped` → audit log `in-review` → post artifact in
   planning thread for human review.
2. Human approves → `fleetmind task signoff --task-id ... --project ...` → DDB at
   `signed_off` → audit log `done` → run step 7.

If/when the PR merges: `fleetmind task merge --task-id ... --project ...`.

## Planning Queries (before drafting a new envelope)

Before drafting a new delegation, check prior work for patterns:

```bash
# Recent merged tasks for the current project
fleetmind query merged --project <slug> --limit 10 --json

# Cross-project merged tasks
fleetmind query merged --limit 20 --json

# Read a specific task's narrative
fleetmind narrative get --task-id <task_id>
```

Scan the `## Learned` sections for patterns relevant to the new task. Name
specifics in the new delegation envelope when they bear on the work.

## Abandoning a task (PM bot only)

```bash
fleetmind task abandon --task-id "${TASK_ID}" --project "${PROJECT}"
```

Worker bots cannot abandon tasks — they ping the PM bot and the PM bot calls
`fleetmind task abandon`. Pass `--project` from the prior `task get` to avoid
an extra GetItem round-trip.

## Hard limits

- 🚫 Do NOT delegate ambiguous work. Push back first.
- 🚫 Do NOT post in worker channels outside of delegation envelopes and active threads.
- 🚫 Do NOT write code, run deploys, or modify infrastructure. Orchestrate.
- 🚫 Do NOT rely on `active-delegations.md` for live state — query DDB instead.
- ✅ Always close the loop in the planning thread on every delegation.
- ✅ Always query DDB on heartbeat for live task state.
- ✅ Worker bots cannot `fleetmind task create` — only PM bots create records.
