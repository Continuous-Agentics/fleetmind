---
name: bot-reception
version: 1.6.0
description: "Worker protocol for NATS delegation receipt: session boot, DDB health precheck, task ack/ship/block via fleetmind task CLI, S3 narrative, and human-requestor Slack threading. Use when a NATS delegation arrives, a task needs to ship or block, or a human makes a direct request. Slack is human-facing only."
---

# Bot Reception Protocol

## Session boot

### Step 1: Start the NATS subscriber (mandatory)

Before accepting any work, ensure the NATS subscriber is running. Check once per session boot; do not re-start if already running.

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

The subscriber auto-acks the DDB row on receipt (`delegated → accepted`). No separate `fleetmind task ack` call is needed.

### Step 2: DDB write-health precheck (mandatory)

Run after subscriber startup, before doing any work.

Why: a worker with a broken DDB write path will receive delegations and silently fail to record `accepted`/`shipped`/`blocked`. A no-op precheck at boot turns the silent failure into a loud, explicit refusal.

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
  "requestor": "U_REQUESTOR",
  "tracker_link": "https://github.com/acme/repo/issues/42"
}
```

### Steps

The first three steps below are **bookkeeping**. **Step 4 (post in Slack) is the first thing the human sees.** Do steps 1–3 in any order, but **step 4 MUST land before you start any task work** — before reading files in the target repo, running `gh`, calling external APIs, or doing any LLM-visible reasoning about the work itself. The Slack post is how the human knows you're alive and on the task; without it, all subsequent activity is invisible until you ship, which feels like the bot died. If you find yourself about to call a tool whose purpose is to do the work (not to post in Slack, not to read DDB), and you haven't posted in step 4 yet, **stop and post first**.

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

4. **Post your picked-up announcement in YOUR home channel — BEFORE any task work.**

   **Your home channel** is the Slack channel under your `channels:` block in `fleet.yaml` (and renders into the channel-routing entry of your `openclaw.json`). It is the channel YOU live in — separate from the PM bot's channel where the human pinged. The subscriber may already have posted an instant *"👋 Received delegation"* line there and routed your wake into that fresh thread; check the active session's channel via your slack tool. Your job is to reply IN THAT THREAD with the considered picked-up message below. **Do not post in the PM's delegation thread — that thread lives in the PM's channel and is the PM↔human conversation.** Use the delegation_thread URL only as a back-link in your announcement so the human can trace which conversation triggered this work.

   This is the message the human is waiting for in YOUR channel; do not skip it, defer it, or parallelize it with the work itself.

   ```
   @<requestor> — picked up [<tracker_id>]: <title>

   <one-sentence description of what you'll build>
   Done when: <definition of done verbatim>
   Triggered by: <delegation_thread URL>
   <tracker_link if present>

   Let me know if anything needs clarification before I start.
   ```

   Store the Slack thread `ts` in `memory/task-queue.md` (replace `thread_ts: (pending)` with `thread_ts: <ts>`).

   **You may now begin task work.** Steps 5+ below are the work itself. All subsequent activity for this delegation (progress updates, the ship announcement) threads under the SAME root in YOUR home channel — never in the PM's delegation thread.

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

Also post a brief update in the requestor's Slack thread so they know where things stand. Keep it short — one or two sentences.

---

## DynamoDB Lifecycle State Management

### Ship (S3 narrative first, then DDB update)

**Critical ordering**: write S3 before DDB. The DDB update triggers the wake signal (DDB Streams → EventBridge Pipe → PM bot wake). Don't fire the signal before the narrative is readable.

Write the narrative first, then update DDB. Copy the exact templates from [references/narrative-template.md](references/narrative-template.md) - do not compose the frontmatter/section headers ad-hoc.

```bash
fleetmind task ship \
  --task-id <task_id> \
  --worker <your-agent-id-or-slack-user-id> \
  --project <project-slug>     # from the initial 'task get'; saves a GetItem round-trip
```

If `fleetmind narrative put` exits with code 2 (S3 failure, local fallback): write the local fallback path to `memory/task-queue.md`, surface it as a follow-up, and do NOT proceed to the DDB update yet.

### Block (same ordering)

Same S3-then-DDB ordering, using the block template (with `## Need`) from [references/narrative-template.md](references/narrative-template.md):

```bash
fleetmind task block \
  --task-id <task_id> \
  --worker <your-agent-id-or-slack-user-id> \
  --project <project-slug>     # from the initial 'task get'; saves a GetItem round-trip
```

---

## Unblock pattern

If you've called `task block` and the blocking condition has since been resolved (transient auth gap fixed, missing dep installed, etc.), call `task unblock` to transition back to `accepted` and resume:

```bash
fleetmind task unblock --task-id <hex> --worker <your-id> --reason "auth restored"
```

Then proceed with the normal ship pattern (`narrative put` → `task ship`).

If the DoD as written is ambiguous or impossible, you can request the PM update it via `task update` rather than blocking. Propose the revised wording in the delegation thread so the PM can run:

```bash
fleetmind task update --task-id <hex> --dod "..." --reason "clarified after worker review"
```

This avoids the overhead of abandoning and recreating the task when only the definition of done needs refinement.

---

## On Completion

After the S3 + DDB writes succeed, post in the *requestor's* Slack thread:

```
✅ Done.

Summary: <what was done — one paragraph max>
Links: <PR / preview deploy / docs>
What I didn't do: <scope cuts, gotchas, follow-ups>
```

`fleetmind task ship` automatically publishes a `fleetmind.task.<id>.ship` NATS event — the PM bot receives it and closes out the DDB lifecycle. No separate reply to the PM bot is needed.

The "What I didn't do" line is mandatory.

## On Blocker

Post in the requestor's Slack thread:

```
⛔ Blocked.

Reason: <what's missing or wrong>
Need: <what would unblock — info, decision, dep fix, etc.>
```

`fleetmind task block` publishes `fleetmind.task.<id>.block` — the PM bot receives it automatically.

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

## Handling Human Requests (Non-Delegation)

Classify before acting:

- **Discussion / one-liner:** just answer.
- **New feature request (vague scope or indirect request):** push back — see § Push-back.
- **Human directly asks you to pick up a discrete piece of work (non-delegation):** follow `worker-self-start`.
- **Real task without a tracker (bug fix, triage, informal request):** still write a DDB row + S3 narrative with `--lifecycle shipped-is-done` — see § Informal-task ledger.

---

## Push-back (unlinked feature requests)

When asked for new feature work but the request is vague, indirect, or scope is unclear:

1. Reply once: `This looks like new feature scope — can you describe exactly what needs doing and confirm you'd like me to start? If there's a ticket or issue URL, share it and I'll begin now.`
2. Stop. Do not implement anything.
3. When they confirm (and optionally share a tracker URL): follow `worker-self-start`.

One reply only, no repeats, no workarounds.

---

## Informal-task ledger (direct human requests)

Not all meaningful work arrives via a PM bot NATS delegation. A human asks you a direct question, you open a PR to fix something you noticed, you run a non-trivial debug session in a thread — without a TASK# row, the PM bot is blind to a real chunk of dev-channel activity.

**Rule:** any non-trivial work you do outside of a formal delegation still gets a TASK# row in DDB and an S3 narrative, with `lifecycle: informal`. The wake pipeline fires the same way; the PM bot handles informal-lifecycle terminal events the same as delegation terminals.

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

When ambiguous, err on the side of writing the row — the cost is microscopic; the cost of the PM bot being blind is real.

### Creating an informal task row

```bash
fleetmind task create \
  --project <best-fit-project-slug> \
  --worker <your-agent-id> \
  --delegated-by <your-agent-id> \
  --dod "<one-line summary, no PII>" \
  --thread "<slack permalink to the thread the work originated in>" \
  --envelope-ts "<timestamp of the triggering Slack message>" \
  --lifecycle shipped-is-done \
  --task-id "${TASK_ID}" \
  --json

# Advance from 'delegated' to 'accepted'
fleetmind task ack \
  --task-id "${TASK_ID}" \
  --worker <your-agent-id> \
  --project <best-fit-project-slug>
```

Key differences from a standard delegation row:
- `--lifecycle shipped-is-done` — no human sign-off required; task closes
  automatically when shipped. (`--lifecycle informal` is not a valid CLI
  option; `--status accepted` is not a valid flag on `task create`.)
- `--delegated-by` = your own agent ID (self-delegation).
- `task ack` after `task create` advances the row from `delegated` to
  `accepted`. There is no `--status` flag on `task create`.
- `--envelope-ts` — use the timestamp of the Slack message that triggered
  the work (optional for NATS-only fleets).
- No tracker link by default.

Generate the task ID at the moment work becomes meaningful (first commit, first infra write, first significant debug step — not at the start of every reply).

### Completing an informal task

Write the S3 narrative first (per § Ship pattern), then call `fleetmind task ship`. The DDB Streams wake fires the same way; the PM bot adopts the row into its audit log on next heartbeat via its reconciliation pass.

---

## ACP Session Heuristic

**Inline (no ACP):** single-file edit, 1-2 tool calls, mostly mechanical. **Fork ACP session:** 3+ files, iterative work, test-driven loops, large refactors.

---

## Update task-queue.md

On receipt: add to `## In Progress` before starting any work (crash-recovery record). Update `thread_ts` once the Slack thread with the requestor is opened. On completion/blocked: move to `## Recently Shipped` or `## Blocked` with outcome note.

```
## In Progress
- **<task_id>** — <description> | started <date> | requestor: <slack_uid> | thread_ts: <ts>

## Recently Shipped
- **<task_id>** — <description> | shipped <date> | PR: <url>
```

---

## Reference files

Load these only when the task you're handling needs them:

- *[references/narrative-template.md](references/narrative-template.md)* -
  exact S3 narrative frontmatter/section templates for ship and block events.
  **Always copy from here; never compose the narrative headers ad-hoc.**

## Changelog

Latest: **1.6.0 (2026-07-09)** - tracker-agnostic self-start trigger (#241).
