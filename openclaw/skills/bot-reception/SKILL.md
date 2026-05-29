---
name: bot-reception
version: 1.3.0
description: >
  Protocol for receiving task delegations from a PM bot over NATS transport.
  Use when: (1) a NATS delegation event arrives, (2) you need to ship or block
  a task, (3) a human asks you to do something directly. Covers NATS subscriber
  startup, DDB write-health precheck, delegation event handling, opening a
  Slack thread with the human requestor, DynamoDB lifecycle management
  (ack/ship/block via `fleetmind task` CLI), S3 narrative writing via
  `fleetmind narrative put`, progress events via `fleetmind nats progress`,
  voice discipline, and ACP session heuristic. Slack is human-facing only —
  no delegation envelopes are posted or received on Slack.
---

# Bot Reception Protocol

## Session boot

### Step 1: Start the NATS subscriber (mandatory)

Before accepting any work, ensure the NATS subscriber is running. Check once
per session boot; do not re-start if already running.

```bash
systemctl is-active fleetmind-nats-worker.service 2>/dev/null \
  || pgrep -f "fleetmind nats subscribe" > /dev/null \
  || echo "NOT_RUNNING"
```

If not running:

```bash
fleetmind nats subscribe --mode worker --worker-id "$AGENT_ID" --json \
  | while IFS= read -r line; do
      TYPE=$(echo "$line" | jq -r '._type // .event')
      case "$TYPE" in
        delegation) handle_delegation "$line" ;;
      esac
    done
```

The subscriber auto-acks the DDB row on receipt (`delegated → accepted`).
No separate `fleetmind task ack` call is needed.

### Step 2: DDB write-health precheck (mandatory)

Run after subscriber startup, before doing any work.

Why: a worker with a broken DDB write path will receive delegations and
silently fail to record `accepted`/`shipped`/`blocked`. A no-op precheck
at boot turns the silent failure into a loud, explicit refusal.

```bash
ERR=$(fleetmind query pending --limit 1 --json 2>&1 >/dev/null)
RC=$?

if [ $RC -ne 0 ]; then
  if [ ! -f memory/ddb-write-unhealthy.flag ]; then
    echo "unhealthy at $(date -u +%Y-%m-%dT%H:%M:%SZ): $ERR" > memory/ddb-write-unhealthy.flag
  fi
  echo "ABORT: DDB write path unhealthy. Refusing new delegations until resolved."
  exit 1
fi

rm -f memory/ddb-write-unhealthy.flag
```

*While unhealthy:*
- Do NOT ack any delegation. Publish a NATS block event so the PM bot knows.
- Do NOT update DDB.
- Do NOT do the work.
- The unhealthy flag self-clears on the next clean precheck.



## On Receiving a Delegation

The subscriber emits one JSON line per delegation event:

```json
{
  "v": "1.0",
  "event": "delegation",
  "task_id": "a1b2c3d4",
  "project": "my-project",
  "worker": "forge",
  "delegated_by": "conductor",
  "at": "2026-05-20T23:00:00Z",
  "definition_of_done": "All tests pass and PR merged.",
  "description": "Refactor the auth module to use JWT instead of sessions.",
  "requestor": "U0ASYLGHU9E",
  "tracker_link": "https://linear.app/acme/issue/ENG-42"
}
```

### Steps

The first three steps below are **bookkeeping**. **Step 4 (post in Slack) is
the first thing the human sees.** Do steps 1–3 in any order, but **step 4
MUST land before you start any task work** — before reading files in the
target repo, running `gh`, calling external APIs, or doing any LLM-visible
reasoning about the work itself. The Slack post is how the human knows
you're alive and on the task; without it, all subsequent activity is
invisible until you ship, which feels like the bot died. If you find
yourself about to call a tool whose purpose is to do the work (not to
post in Slack, not to read DDB), and you haven't posted in step 4 yet,
**stop and post first**.

1. **Write to `memory/task-queue.md`** under `## In Progress` — crash recovery:
   ```
   - **<task_id>** — <description> | started <date> | requestor: <slack_uid> | thread_ts: (pending)
   ```

2. **DDB auto-acks** via the subscriber. Confirm `status === "accepted"` in the
   `ack_result` JSON line.

3. **Read the task record from DynamoDB** to get `project` and `task_s3_key`:
   ```bash
   fleetmind task get --task-id <task_id> --json
   ```

4. **Post your picked-up announcement in Slack — BEFORE any task work.**
   Post in the requestor's dev channel (your home channel for picked-up
   announcements), @-mentioning the requestor. This is the message the
   human is waiting for; do not skip it, defer it, or parallelize it with
   the work itself.

   ```
   @<requestor> — picked up [<tracker_id>]: <title>

   <one-sentence description of what you'll build>
   Done when: <definition of done verbatim>
   <tracker_link if present>

   Let me know if anything needs clarification before I start.
   ```

   Store the Slack thread `ts` in `memory/task-queue.md` (replace
   `thread_ts: (pending)` with `thread_ts: <ts>`).

   **You may now begin task work.** Steps 5+ below are the work itself.

5. *(Optional)* Read prior task narratives for context:
   ```bash
   fleetmind query merged --project <project> --limit 5 --json \
     | jq -r '.merged[].task_id' \
     | head -3 \
     | xargs -I{} fleetmind narrative get --task-id {}
   ```

6. **Do the work silently.** See Voice Discipline below.

7. When done or blocked: write the narrative to S3, update DDB, then post in
   the requestor's Slack thread.

---

## Mid-task: Progress Updates

At meaningful milestones (PR open, test suite passing, waiting on review):

```bash
fleetmind nats progress \
  --task-id <task_id> \
  --worker "$AGENT_ID" \
  --project <project> \
  --delegated-by <pm_bot_id> \
  --message "PR open at https://github.com/.../pull/42 — awaiting review"
```

Also post a brief update in the requestor's Slack thread so they know
where things stand. Keep it short — one or two sentences.

---

## DynamoDB Lifecycle State Management

### Ship (S3 narrative first, then DDB update)

**Critical ordering**: write S3 before DDB. The DDB update triggers the wake
signal (DDB Streams → EventBridge Pipe → PM bot wake). Don't fire the signal
before the narrative is readable.

**Step 1: Write the narrative to S3**

```bash
cat <<'NARRATIVE' | fleetmind narrative put --task-id <task_id> --event shipped
---
v: 0.2
task_id: <task_id>
---

## Task
<one-paragraph statement of what was delegated>

## What I did
<narrative — outcomes, not a tool-call transcript>

## What I didn't do
<scope cuts, follow-ups, gotchas>

## Links
- PR: <url>
- Preview: <url>

## Learned
<2-5 non-obvious bullets, or []>
NARRATIVE
```

If `fleetmind narrative put` exits with code 2 (S3 failure, local fallback):
write the local fallback path to `memory/task-queue.md`, surface it as a
follow-up, and do NOT proceed to DDB update yet.

**Step 2: Update DDB status to shipped**

```bash
fleetmind task ship \
  --task-id <task_id> \
  --worker <your-agent-id-or-slack-user-id> \
  --project <project-slug>     # from the initial 'task get'; saves a GetItem round-trip
```

### Block (same ordering)

**Step 1: Write the narrative to S3 (with `## Need` section)**

```bash
cat <<'NARRATIVE' | fleetmind narrative put --task-id <task_id> --event blocked
---
v: 0.2
task_id: <task_id>
---

## Task
<what was delegated>

## What I tried
<what you attempted>

## Need
<what would unblock — info, decision, dep fix>

## Learned
<bullets or []>
NARRATIVE
```

**Step 2: Update DDB status to blocked**

```bash
fleetmind task block \
  --task-id <task_id> \
  --worker <your-agent-id-or-slack-user-id> \
  --project <project-slug>     # from the initial 'task get'; saves a GetItem round-trip
```

---

## Unblock pattern

If you've called `task block` and the blocking condition has since been resolved (transient auth gap
fixed, missing dep installed, etc.), call `task unblock` to transition back to `accepted` and resume:

```bash
fleetmind task unblock --task-id <hex> --worker <your-id> --reason "auth restored"
```

Then proceed with the normal ship pattern (`narrative put` → `task ship`).

If the DoD as written is ambiguous or impossible, you can request the PM update it via `task update`
rather than blocking. Propose the revised wording in the delegation thread so the PM can run:

```bash
fleetmind task update --task-id <hex> --dod "..." --reason "clarified after worker review"
```

This avoids the overhead of abandoning and recreating the task when only the definition of done
needs refinement.

---

## On Completion

After the S3 + DDB writes succeed, post in the *requestor's* Slack thread:

```
✅ Done.

Summary: <what was done — one paragraph max>
Links: <PR / preview deploy / docs>
What I didn't do: <scope cuts, gotchas, follow-ups>
```

`fleetmind task ship` automatically publishes a `fleetmind.task.<id>.ship`
NATS event — the PM bot receives it and closes out the DDB lifecycle.
No separate reply to the PM bot is needed.

The "What I didn't do" line is mandatory.

## On Blocker

Post in the requestor's Slack thread:

```
⛔ Blocked.

Reason: <what's missing or wrong>
Need: <what would unblock — info, decision, dep fix, etc.>
```

`fleetmind task block` publishes `fleetmind.task.<id>.block` — the PM bot
receives it automatically.

## After Completion

- On human sign-off: PM bot handles the DDB `signed_off` transition on receipt
  of the `ship` NATS event.
- On PR merge: PM bot handles the DDB `merged` transition.
- `abandoned` is PM-only: if asked to abandon, the PM bot calls
  `fleetmind task abandon`.

---

## `Learned` section: good vs. bad

```
✅ Good:
- Astro 5's getStaticPaths no longer accepts async iterators in dev mode.
- The IAM role doesn't have secretsmanager:GetSecretValue in us-west-2 by default.

❌ Bad (rejected):
- I read the codebase and made changes
- Wrote some code, ran tests, fixed bugs
- <technology> is a <category>
```

If you can't write 2-5 non-obvious bullets, use `[]`.

---

## Voice Discipline (Mandatory)

**In Slack (human-facing only):**
- Open a thread with the requestor on delegation receipt ✅
- Post progress updates and clarifying questions in that thread ✅
- Post the final completion or blocker summary in that thread ✅
- Do NOT narrate tool calls ("I'm now running...") ❌
- Do NOT post raw NATS event JSON ❌
- Do NOT post in the PM bot's planning channel ❌

**NATS (agent-to-agent — never visible to humans):**
- `delegation` — received from PM bot ✅
- `ack` — auto-published by subscriber ✅
- `progress` — you publish at milestones ✅
- `ship` / `block` — published by `fleetmind task ship/block` ✅

---

## Handling Human Requests (Non-Envelope)

- **Discussion:** just answer.
- **Real task:** treat like a delegation, skip task-id formality on the Slack surface,
  but **still write a DDB row + S3 narrative under `lifecycle: informal`** — see
  § Informal-task ledger below.

---

## Informal-task ledger (direct human requests)

Not all meaningful work arrives via a PM bot NATS delegation. A human asks
you a direct question, you open a PR to fix something you noticed, you run a
non-trivial debug session in a thread — without a TASK# row, the PM bot is blind
to a real chunk of dev-channel activity.

**Rule:** any non-trivial work you do outside of a formal delegation still gets a
TASK# row in DDB and an S3 narrative, with `lifecycle: informal`. The wake
pipeline fires the same way; the PM bot handles informal-lifecycle terminal
events the same as delegation terminals.

### What counts as "non-trivial"

*Write a row:*
- Any work that touches a repo (commit, PR, branch push).
- Any work that touches infrastructure (Terraform, AWS API write, deploy).
- Any debugging session that takes more than ~5 minutes of meaningful work.
- Any human request you'd treat as a real task per § Handling Human Requests.

*Do NOT write a row:*
- One-line answers to a question.
- Reactions on someone else's thread.
- Acknowledgements ("yes", "on it", "got it").
- Reading and not acting.

When ambiguous, err on the side of writing the row — the cost is microscopic;
the cost of the PM bot being blind is real.

### Creating an informal task row

```bash
fleetmind task create \
  --project <best-fit-project-slug> \
  --worker <your-agent-id> \
  --delegated-by <your-agent-id> \
  --dod "<one-line summary, no PII>" \
  --thread "<slack permalink to the thread the work originated in>" \
  --lifecycle informal \
  --task-id "${TASK_ID}" \
  --status accepted \
  --json
```

Key differences from a standard delegation row:
- `--lifecycle informal` (the PM bot's signoff watchdog ignores these).
- `--delegated-by` = your own agent ID (self-delegation).
- `--status accepted` from the start (no separate `delegated` step).
- No tracker link by default.

Generate the task ID at the moment work becomes meaningful (first commit, first
infra write, first significant debug step — not at the start of every reply).

### Completing an informal task

Write the S3 narrative first (per § Ship pattern), then call `fleetmind task ship`.
The DDB Streams wake fires the same way; the PM bot adopts the row into its audit
log on next heartbeat via its reconciliation pass.

---

## ACP Session Heuristic

**Inline (no ACP):** single-file edit, 1-2 tool calls, mostly mechanical.
**Fork ACP session:** 3+ files, iterative work, test-driven loops, large refactors.

---

## Update task-queue.md

On receipt: add to `## In Progress` before starting any work (crash-recovery record).
Update `thread_ts` once the Slack thread with the requestor is opened.
On completion/blocked: move to `## Recently Shipped` or `## Blocked` with outcome note.

```
## In Progress
- **<task_id>** — <description> | started <date> | requestor: <slack_uid> | thread_ts: <ts>

## Recently Shipped
- **<task_id>** — <description> | shipped <date> | PR: <url>
```

---

## Changelog

- **1.2.0 (2026-05-21)** — Rewrite for NATS-only transport (CON-115):
  - Removed Slack envelope recognition entirely. Delegation arrives via NATS
    subscriber, not a Slack message with `Task ID:` / `React :eyes:`.
  - Session boot now has two steps: NATS subscriber startup (new) then DDB
    write-health precheck. DDB unhealthy → publish NATS block event instead
    of posting in Slack channel.
  - "On Receiving a Delegation" rewritten: handle NATS JSON event, open Slack
    thread with the human requestor (not a reaction in a bot channel), store
    `thread_ts` in task-queue.md.
  - New § Mid-task Progress Updates: `fleetmind nats progress` at milestones
    + brief update in the requestor's Slack thread.
  - Completion/blocker replies go in the requestor's Slack thread, not a
    reply mentioning the PM bot. `fleetmind task ship/block` publishes the
    NATS event automatically; PM bot receives and closes DDB lifecycle.
  - Voice discipline rewritten: Slack is human-facing only; NATS is
    agent-to-agent only.
  - task-queue.md now tracks `thread_ts` for the requestor's Slack thread.
  - `bot-delegation-nats` and `bot-reception-nats` standalone skills removed;
    NATS transport is now the only transport in these core skills.
- **1.1.0 (2026-05-11)** — DDB write-health precheck, informal-task ledger,
  task-queue-before-eyes ordering.
- **1.0.0** — Initial release.
