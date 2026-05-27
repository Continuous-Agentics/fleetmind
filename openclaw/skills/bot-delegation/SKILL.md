---
name: bot-delegation
version: 1.2.1
description: >
  Delegate concrete dev work from a project-manager bot to worker bots via
  NATS transport, track through completion, and report back to the human.
  Covers specialty-based worker routing, task ID generation, writing the
  DynamoDB task record via `fleetmind task create` (which auto-publishes the
  NATS delegation event), subscribing to worker events (ack/progress/ship/block),
  escalating stale tasks on heartbeat, and closing the loop. Slack is
  human-facing only — no delegation envelopes are posted in worker channels.
  Use when: (1) a planning conversation produces a concrete task with a clear
  definition of done and an assignee, (2) a worker NATS event arrives,
  (3) a heartbeat finds a stale delegation, (4) a DDB_TERMINAL_WAKE signal
  arrives. Triggers on phrases like "delegate this", "assign this", or
  "hand off to <worker>".
---

# Bot Delegation Protocol

This is the protocol for handing concrete work from a project-manager (PM) bot
to worker bots and tracking it through completion. The task ledger is the
canonical state store — DynamoDB for structured state, S3 for narrative content.
The fleet CLI (`fleetmind task`, `fleetmind narrative`, `fleetmind query`) does
the heavy lifting so the skill stays focused on coordination logic.

> _Hard role boundary:_ Orchestrate only. Never write code, run deploys, or
> modify infrastructure. If tempted to do the work yourself, the task
> wasn't well-scoped — push back to the human.

## Vocabulary

| Audit log state | DDB `status` |
|---|---|
| `pending` | `delegated` |
| `acked` | `accepted` |
| `in-review` | `shipped` + `lifecycle = requires-human-signoff` |
| `done` | `signed_off` (human approved) or `merged` (PR merged) |
| `escalated` | *(audit-log only — task is past deadline; DDB still shows prior status)* |
| `blocked` | `blocked` |

The audit log (`memory/active-delegations.md`) is a human-readable supplement;
DDB is the live source of truth. Always query DDB for programmatic decisions.

## Session boot — PM subscriber startup (mandatory)

Before handling any work, ensure the NATS PM subscriber is running.

```bash
systemctl is-active fleetmind-nats-pm.service 2>/dev/null \
  || pgrep -f "fleetmind nats subscribe.*--mode pm" > /dev/null \
  || echo "NOT_RUNNING"
```

If not running:

```bash
fleetmind nats subscribe --mode pm --json \
  | while IFS= read -r line; do
      EVENT=$(echo "$line" | jq -r '.event // empty')
      TASK_ID=$(echo "$line" | jq -r '.task_id // empty')
      case "$EVENT" in
        ack)      handle_worker_ack "$line" ;;
        progress) handle_worker_progress "$line" ;;
        ship)     handle_worker_ship "$line" ;;
        block)    handle_worker_block "$line" ;;
      esac
    done
```

This subscriber replaces sweep cron jobs. Workers push events; the PM bot
reacts to them. Leave `delegation.sweeps` empty or omit it in `fleet.yaml`.

---

## When to start a delegation

Only when the task is concrete. It MUST have:
- One-line summary
- Definition of done (what "done" looks like, not how)
- Assignee bot (worker agent ID from fleet.yaml)
- Human requestor Slack UID (so the worker can open a thread with them)

If any are missing, push back to the human first. Do not delegate vague work.

## Step-by-step

### 1. Generate a task ID

8-character lowercase hex. Used to correlate the NATS delegation event, DDB
record, and S3 narrative.

```bash
TASK_ID=$(python3 -c "import secrets; print(secrets.token_hex(4))")
# Or: openssl rand -hex 4
```

### 2. Write the task record to DynamoDB

Create the task ledger record:

```bash
fleetmind task create \
  --project <project-slug> \
  --worker <worker-agent-id> \
  --delegated-by <pm-bot-id> \
  --dod "<definition of done>" \
  --description "<what needs to be built — context for the worker>" \
  --requestor "<human_slack_uid>" \
  --tracker "<linear_or_jira_url>" \
  --thread "<slack_permalink_to_planning_discussion>" \
  --lifecycle requires-human-signoff \
  --task-id "${TASK_ID}" \
  --json
```

`fleetmind task create` automatically publishes the `delegation` event to
`fleetmind.delegation.<worker_id>` when NATS is configured. No separate
publish step is needed.

If `task create` exits non-zero with "already exists": regenerate the task ID.
If it fails with a network/permissions error: log the failure in `memory/active-delegations.md` (field:
`ledger_write_failed: <reason>`) and retry on the next heartbeat.

**Amending task metadata after delegation:**
If the scope changes after a task is delegated (worker pushback, PM clarification, reassignment),
use `fleetmind task update` instead of abandoning and recreating. Update history is preserved.

```bash
# Narrow the DoD after worker review
fleetmind task update --task-id <hex> --dod "..." --reason "scope cut after worker review"

# Reassign to a specialist
fleetmind task update --task-id <hex> --worker <new-worker-id> --reason "specialist now available"

# Fix a wrong thread URL
fleetmind task update --task-id <hex> --thread "https://slack.com/archives/..."
```

Immutable fields (rejected by `task update`): `task_id`, `status`, `created_at`, `created_by`,
and all transition timestamps (`accepted_at`, `shipped_at`, etc.). Terminal tasks (`merged`,
`abandoned`) are frozen — update will exit 2 with `TaskConditionError`.

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

### 3. Delegation is sent via NATS

`fleetmind task create` (step 2) handles the publish. The worker receives a
NATS delegation event containing `task_id`, `description`, `definition_of_done`,
`requestor`, and `tracker_link`. No Slack envelope is posted.

The worker opens a Slack thread directly with the human requestor — the PM
bot is not involved in that thread unless the human escalates.

### 4. Update the audit log

Append a block to `memory/active-delegations.md` under `## Active`. See
[references/active-delegations-format.md](references/active-delegations-format.md)
for the full template.

Minimum fields:
- `task_id`, `created` (ISO timestamp), `deadline` (created + 10 min)
- `status: pending`, `project`, `worker`
- `Source planning channel` + `Source planning thread`: where the delegation was discussed
- `ledger_ddb_key`: `TASK#<task_id>`

### 5. Watch for worker events

Events arrive via the PM subscriber started in § Session boot.

| NATS event | Action |
|--------|--------|
| `ack` from worker | Status → acked in audit log; extend deadline +10 min |
| `progress` from worker | Log update; optionally surface to human if warranted |
| `ship` from worker | Close the loop (step 7) |
| `block` from worker | Close as blocked (step 7) |
| `DDB_TERMINAL_WAKE: TASK#<task_id>` | See § DDB Terminal Wake (fallback path) |
| Heartbeat finds expired deadline | See § Escalation |

**Semantic terminal signals**: ✅ and ⛔ are canonical examples, not literal
triggers. Read the meaning ("done", "merged", "deployed" = ship; "blocked",
"stuck", "need X" = blocked). When ambiguous, treat as terminal — missing a
real ship is worse than a redundant noop.

### 5a. DDB Terminal Wake

*Idempotency contract: DDB is authoritative.* The audit log is a cache of DDB
state; when they disagree, DDB wins. The previous pattern — "check audit log
first; short-circuit if the task is in `## Closed`" — silently dropped
legitimate re-ships (a re-ship after close, a blocked→shipped retry, or a
scope-amendment cycle arrives after the task was already closed). The correct
order is: read DDB first, derive the decision from DDB timestamps, use the
audit log only for presentation and to find the matching block.

When `DDB_TERMINAL_WAKE: TASK#<task_id>` arrives:

1. Parse the task_id from the message.
2. **Read DDB first.** This is the authoritative read.
   ```bash
   ITEM=$(fleetmind task get --task-id "${TASK_ID}" --json)
   STATUS=$(echo "$ITEM" | jq -r '.status')
   SHIPPED_AT=$(echo "$ITEM" | jq -r '.shipped_at // empty')
   BLOCKED_AT=$(echo "$ITEM" | jq -r '.blocked_at // empty')
   MERGED_AT=$(echo "$ITEM" | jq -r '.merged_at // empty')
   ABANDONED_AT=$(echo "$ITEM" | jq -r '.abandoned_at // empty')
   LIFECYCLE=$(echo "$ITEM" | jq -r '.lifecycle')
   TASK_S3_KEY=$(echo "$ITEM" | jq -r '.task_s3_key')

   # Pick the most recent terminal timestamp DDB knows about.
   TERMINAL_AT=$(printf '%s\n' "$SHIPPED_AT" "$BLOCKED_AT" "$MERGED_AT" "$ABANDONED_AT" \
     | grep -v '^$' | sort | tail -1)
   ```
   If `fleetmind task get` fails (not found or network error): fall back to
   audit-log idempotency WITH A WARNING — log the degradation, surface for
   human investigation, do not guess.

3. **Compare `last-handled-terminal-at` from the audit log block against the
   DDB terminal timestamp:**
   ```bash
   LAST_HANDLED=$(awk -v id="${TASK_ID}" '
     /^## Delegation:/ { in_block = ($0 ~ id) }
     in_block && /last-handled-terminal-at:/ { sub(/^[^:]*:[ ]*/, ""); print; exit }
   ' memory/active-delegations.md 2>/dev/null)

   if [ -n "$LAST_HANDLED" ] && [ -n "$TERMINAL_AT" ]; then
     if [[ "$LAST_HANDLED" == "$TERMINAL_AT" ]] || [[ "$LAST_HANDLED" > "$TERMINAL_AT" ]]; then
       echo "INFO: TASK#${TASK_ID} terminal at ${TERMINAL_AT} already handled. Duplicate delivery — skipping."
       exit 0
     fi
     # DDB has a NEWER terminal timestamp — re-ship, blocked→shipped retry,
     # or scope-amendment cycle. Reopen the block and run close-the-loop fresh.
     echo "INFO: TASK#${TASK_ID} re-terminal detected (DDB ${TERMINAL_AT} > last-handled ${LAST_HANDLED}). Reopening."
     REOPEN=1
   fi
   ```

4. **Reopen-on-reship (silent).** If `REOPEN=1`, move the block from
   `## Closed` back to `## Active` in the audit log:
   - Set `Status:` back to `acked` (or `in-review` if `LIFECYCLE=requires-human-signoff` and DDB `status=shipped`).
   - Clear `Closeloop subagent:` and `Closeloop spawned at:` fields.
   - Remove `Closed at:` and `Outcome:` fields.
   - Leave `last-handled-terminal-at:` in place — the close-the-loop sub-agent overwrites it on completion.
   - **Do NOT post anything to the coordination channel about the reopen.** This
     is silent self-healing. The close-the-loop sub-agent posts normally when done.

5. **Hard short-circuit on already-final DDB status.** If DDB itself says
   `merged` or `abandoned` AND the audit log shows the block in `## Closed`,
   it's a confirmed noop:
   ```bash
   if [[ "$STATUS" == "merged" || "$STATUS" == "abandoned" ]] && \
      awk '/^## Closed/,0' memory/active-delegations.md 2>/dev/null | grep -q "task_id: ${TASK_ID}"; then
     echo "INFO: TASK#${TASK_ID} terminal in DDB (${STATUS}) and closed in audit log. Noop."
     exit 0
   fi
   ```
   *(Defense-in-depth: the `last-handled-terminal-at` comparison in step 3 is
   the primary gate; this is a belt-and-suspenders backstop.)*

6. **Read the narrative** (for context in the closeout summary):
   ```bash
   NARRATIVE=$(fleetmind narrative get --task-id "${TASK_ID}")
   if [ $? -ne 0 ]; then
     echo "WARNING: Narrative not yet available for ${TASK_ID} — worker may still be writing. Retry in 30s."
   fi
   ```

7. **Close the loop** (step 7 of the main protocol), grounding the summary in
   the `## What I did` and `## Learned` sections from the narrative already
   fetched in step 6. Use the canonical brief template from
   [references/sub-agent-task-templates.md](references/sub-agent-task-templates.md)
   — copy the matching variant verbatim into the `task` field of
   `sessions_spawn`. Do not compose ad-hoc.

### 6. Stale task escalation (heartbeat)

Every heartbeat: query DDB directly for live active-delegation state.
`active-delegations.md` is the audit log, not the source of truth.

```bash
# Tasks past their deadline
fleetmind query stale \
  --project <current-project> \
  --delegated-threshold 10 \
  --accepted-threshold 60 \
  --json
```

Every item returned is already past its deadline — escalate each one.

For each stale task: post in the planning thread, update audit log to `escalated`.

**DDB write retry on heartbeat**: if `ledger_write_failed` is set in the audit
log for a task, retry `fleetmind task create` on this heartbeat.

Quiet otherwise. No "everything's fine" pings.

### 6.5. When a worker is blocked but the cause can be resolved

`blocked` is NOT terminal-final — it's a pause state that can resume. When a
worker reports blocked (NATS block event, or DDB heartbeat sees `status=blocked`), assess whether the cause is something you (or a human in the planning
thread) can resolve:

- *Auth gap, missing credential, missing dependency, infra glitch:* often
  fixable in minutes. Resolve it, then either:
  - **Prompt the worker to unblock themselves**: post in the delegation thread
    "resolved — you can `fleetmind task unblock --task-id <hex> --worker <id>
    --reason "..."` and resume", OR
  - **Unblock on behalf of the worker** (operator decision): run
    `fleetmind task unblock --task-id <hex> --worker <worker_id> --reason
    "resolved by PM"` yourself. The worker's `task ack`/`ship` path continues to
    work from `accepted`.
- *Scope cut, missing requirement, design ambiguity:* not a transient blocker.
  Treat as terminal blocked; close the loop normally (Step 7).

If you unblock, leave a note in the planning thread audit log explaining what
changed, so the trail remains for human review.

### 7. Close the loop

On terminal status (shipped or blocked):

1. Read the DDB record: `fleetmind task get --task-id "${TASK_ID}" --json`.
   Capture project, lifecycle, task_s3_key. If you arrived from § DDB Terminal
   Wake, reuse the `$ITEM` and `$NARRATIVE` already fetched there — do not
   re-fetch.
2. Read the narrative: `fleetmind narrative get --task-id "${TASK_ID}"`.
   The `Learned` section is the durable signal future delegations benefit from.
   Ground the closeout summary in it.
3. Post a summary in the planning thread:
   - Task ID, worker, outcome (shipped / blocked)
   - One-line summary of what got done (or what's blocked + what's needed)
   - Link to artifact (PR, deploy, etc.)
   - Reference to the narrative (`fleetmind narrative get --task-id <task_id>`)
4. If lifecycle = `requires-human-signoff` and status = `shipped`:
   - Use template **(b)** from
     [references/sub-agent-task-templates.md](references/sub-agent-task-templates.md) —
     In-Review handoff, NOT close-the-loop.
   - Update audit log to `in-review`. Wait for human signoff before closing.
5. On human signoff: `fleetmind task signoff --task-id "${TASK_ID}" --project "${PROJECT}"`
   Then update audit log to done. Use template **(c)**.
6. On PR merge: `fleetmind task merge --task-id "${TASK_ID}" --project "${PROJECT}"`
7. Move delegation block from `## Active` to `## Closed` in audit log.
   Set `closed_at`. Update `last-handled-terminal-at` to the DDB terminal
   timestamp as the **last** mutation before moving the block to `## Closed`.

**Closeout completion check (MANDATORY before reporting done):** verify each of
steps 3–7 actually happened in this turn before finishing:

- [ ] Threaded planning-channel post sent (got back a `messageId` from `message(action=send, ...)`).
- [ ] `active-delegations.md` block has been *moved* (not just edited) from `## Active` to `## Closed` with `Closed at: <iso-8601-utc>`.
- [ ] DDB status is now `merged` / `abandoned` (via `fleetmind task merge` / `fleetmind task abandon`), or explicitly skipped with reason.
- [ ] `last-handled-terminal-at` is set to the DDB terminal timestamp in the now-closed block.

If any box is unchecked, do that step now. Posting the planning summary and
stopping is not closing the loop — it leaves the block in `## Active` and the
heartbeat watchdog firing forever.

*Spawn task brief:* Use the canonical template from
[references/sub-agent-task-templates.md](references/sub-agent-task-templates.md).
Match the variant to the trigger (a=close-the-loop, b=In-Review, c=signoff,
d=blocked-handler). Copy verbatim; fill placeholders.

*Self-check before calling `sessions_spawn`:* search the `task` string for the
literal substring `NO_REPLY`. If it's not there, the template is wrong — abort
and add it.

### 7a. Sub-agent discipline (NO_REPLY-final-turn)

*This rule is non-negotiable. It applies to **every** sub-agent spawned from
this skill — close-the-loop handlers, In-Review handoffs, signoff closers,
blocked-handlers, or any future variant.*

> **Hard rule for every spawned sub-agent:** Must end its final turn with the
> literal token `NO_REPLY` and nothing else. Slack writes are limited to
> *exactly* the channel posts named in its task brief, posted via the `message`
> tool with explicit `target` and `replyTo`. Report-back to the parent goes via
> the **tool result** (plain-text return value of the `task`), never via a Slack
> message. A top-level "Done. Accomplished: …" post (or any unsolicited post) in
> the planning channel is a **bug**, not a feature. This failure mode has
> recurred multiple times across real delegations; the `NO_REPLY` discipline and
> literal templates exist specifically to prevent it.

Concretely, every sub-agent `task` block in this skill must contain a section
like:

```
## Output discipline (READ THIS LAST, OBEY IT FIRST)

- Your ONLY permitted Slack writes are those explicitly named in this brief
  (e.g., one threaded reply in the planning thread). List them here with
  target + replyTo.
- ZERO top-level posts in any channel. ZERO additional planning-thread posts.
  ZERO DMs.
- Report-back to the parent goes via this sub-agent's *tool return value* (the
  text emitted on the assistant turn immediately before `NO_REPLY`). The parent
  reads that text directly; do NOT mirror it to a Slack channel.
- Final assistant turn must be exactly the literal token `NO_REPLY` (9 chars,
  no quotes, no trailing punctuation).
```

*Authoring checklist when adding a sub-agent spawn block to this skill:*
1. The `task` field includes the Output discipline block (or verbatim reference to § 7a).
2. The discipline block is the last substantive section in the prompt, so it cannot be missed.
3. The single allowed Slack write(s) are enumerated explicitly with target + replyTo.
4. The `NO_REPLY` final-turn requirement is stated.
5. The task brief says: "Your report-back goes in the tool return value, NOT as a Slack post."

## Signoff Watchdog (heartbeat-driven)

Tasks with `lifecycle: requires-human-signoff` sit at DDB `status: shipped`
until a human approves. Without an explicit watchdog, they stall silently for
hours — the bot ships, the work is done, but the planning thread never gets
the final close because no human noticed. The watchdog surfaces them after a
4h grace period, with a per-task cooldown to avoid spam.

On each heartbeat, query for overdue in-review tasks:

```bash
fleetmind query shipped \
  --lifecycle requires-human-signoff \
  --delegated-by <pm-bot-id> \
  --stale-since 4h \
  --json
```

For each task returned, post **one** line in the planning channel (top-level,
NOT in a thread):

```
Reminder: TASK#<task_id> (<one-liner from definition_of_done>) awaiting sign-off for <Nh>. <link to delegation thread>
```

Then record the nag time so we don't re-nag on the next heartbeat:

```bash
fleetmind task set-nag --task-id "${TASK_ID}"
```

*Hard rules:*
- One line per overdue task. No thread, no embellishment.
- Quiet hours apply (per HEARTBEAT.md). A task crossing 4h at 2 AM waits until morning.
- Never escalate to a DM; the planning channel is the right surface.
- Cooldown matches the threshold (4h): a still-pending task gets at most one nag per 4h window.

## Reconciliation (boot + heartbeat)

DDB drifts from the audit log when sessions die mid-write, when wake signals
land twice, when a re-ship slips past idempotency, or when a parallel session
edits the audit log. Reconciliation is a self-healing pass that runs *on session
boot AND on every heartbeat*.

### 1. Query DDB for all live and recently-terminal tasks

```bash
fleetmind query all \
  --status delegated,accepted,shipped,blocked \
  --json
```

### 2. Diff against `## Active` blocks in `memory/active-delegations.md`

Three drift cases — handle each idempotently:

- **DDB row missing from audit log (adopt-on-wake).** A task exists in DDB but
  no block exists in the audit log. Synthesize the block from the DDB row and
  append to `## Active`. Set `Status:` from DDB status (using the vocabulary
  table at the top of this skill).

- **Audit-log block whose DDB row is `merged` or `abandoned`.** Move the block
  to `## Closed` with `Status: done` (merged) or `Status: abandoned`. Set
  `Closed at:` to the DDB `merged_at` / `abandoned_at`. Set
  `last-handled-terminal-at:` to the same value.

- **Closed audit-log block whose DDB `shipped_at` or `blocked_at` is newer
  than `last-handled-terminal-at`.** Reopen-on-reship case. Run the § 5a
  step 4 reopen procedure inline: move back to `## Active`, clear
  `Closeloop subagent:` / `Closeloop spawned at:`, then spawn a fresh
  close-the-loop sub-agent (per § 7a discipline).

### 3. Post one summary line if drift was found

Gate the post on `drift_count > 0`. If nothing drifted, the heartbeat is silent.

```
Reconciled <N> drifted task(s): <comma-separated TASK#ids>.
```

Post in the planning channel top-level. Never post per-task narrative — one
line, all ids. Adoption events count as drift; pure noops do not.

### 4. Drift banner (silent unless divergence)

After reconciliation, compare counts:

```
active    = audit-log blocks in ## Active with Status: pending|acked
in_review = audit-log blocks in ## Active with Status: in-review
ddb_active    = DDB rows where status IN (delegated, accepted)
ddb_in_review = DDB rows where status=shipped AND lifecycle=requires-human-signoff
```

If they match exactly, **do not post anything**. If they diverge, post one line:

```
Tracking drift: audit-log <active> active / <in_review> in-review. DDB: <ddb_active> active / <ddb_in_review> in-review.
```

## Planning Queries (before creating a new delegation)

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
specifics in the new delegation when they bear on the work.

## Abandoning a task (PM bot only)

```bash
fleetmind task abandon --task-id "${TASK_ID}" --project "${PROJECT}"
```

Worker bots cannot abandon tasks — they ping the PM bot and the PM bot calls
`fleetmind task abandon`.

## Reference files

Load these only when the task you're handling needs them:

- *[references/active-delegations-format.md](references/active-delegations-format.md)* —
  exact block template for `memory/active-delegations.md`, field semantics, and
  the reopen-on-reship procedure.

- *[references/sub-agent-task-templates.md](references/sub-agent-task-templates.md)* —
  canonical, copy-pasteable `task:` briefs for every delegation-lifecycle
  sub-agent (close-the-loop, In-Review, signoff, blocked). Each template embeds
  the § 7a hard rule verbatim. **Always copy from here; never compose ad-hoc.**

## Hard limits

- 🚫 Do NOT delegate ambiguous work. Push back first.
- 🚫 Do NOT post in worker channels. Delegation is NATS-only; Slack is human-facing only.
- 🚫 Do NOT write code, run deploys, or modify infrastructure. Orchestrate.
- 🚫 Do NOT rely on `active-delegations.md` for live state — query DDB instead.
- 🚫 Do NOT respond to worker bot messages outside the delegation protocol.
- 🚫 Do NOT post close-the-loop summaries inline on a wake turn — spawn a sub-agent.
- ✅ Always close the loop in the planning thread on every delegation.
- ✅ Always query DDB on heartbeat for live task state.
- ✅ Every delegation-lifecycle sub-agent ends its final turn with `NO_REPLY` and posts at most ONE threaded planning-thread message — see § 7a.

## Changelog

- **1.2.1 (2026-05-27)** — Documentation fix: Step 4 minimum fields now
  correctly reference `Source planning channel` + `Source planning thread`
  instead of removed `thread` field. Aligns with active-delegations-format
  schema.
- **1.2.0 (2026-05-21)** — Rewrite for NATS-only transport (CON-115):
  - New § Session boot — PM subscriber startup: start `fleetmind nats
    subscribe --mode pm` before handling any work. This is the replacement
    for sweep cron jobs — workers push events, PM bot reacts.
  - `fleetmind task create` now includes `--description`, `--requestor`,
    and `--tracker` flags. Removed `--envelope-ts` (no envelope). The command
    auto-publishes the NATS delegation event — no separate publish step.
  - § 3 "Post the delegation envelope" replaced with § 3 "Delegation is sent
    via NATS". No Slack envelope is posted in the worker's channel.
  - § 5 table updated: `:eyes:` reaction and threaded reply signals replaced
    with NATS `ack`/`progress`/`ship`/`block` events from the subscriber.
    `DDB_TERMINAL_WAKE` retained as a fallback path.
  - `references/envelope-template.md` removed from reference files (no
    envelope format to maintain).
  - `bot-delegation-nats` and `bot-reception-nats` standalone skills removed;
    NATS transport is now the only transport in these core skills.
- **1.1.0 (2026-05-11)** — DDB-first idempotency, reopen-on-reship, signoff
  watchdog, reconciliation, § 7 completion checklist, NO_REPLY sub-agent
  discipline, canonical sub-agent task templates.
- **1.0.0** — Initial release.
