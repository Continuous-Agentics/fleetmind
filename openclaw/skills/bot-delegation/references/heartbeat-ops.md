# Heartbeat operations — stale escalation, unblock, signoff watchdog, reconciliation

## § 6 — Stale task escalation (heartbeat)

Every heartbeat: query DDB directly for live active-delegation state. `active-delegations.md` is the audit log, not the source of truth.

```bash
# Tasks past their deadline
fleetmind query stale \
  --project <current-project> \
  --delegated-threshold 10 \
  --accepted-threshold 60 \
  --json
```

Every item returned is already past its deadline - escalate each one.

For each stale task: post in the planning thread, update audit log to `escalated`.

**DDB write retry on heartbeat**: if `ledger_write_failed` is set in the audit log for a task, retry `fleetmind task create` on this heartbeat.

Quiet otherwise. No "everything's fine" pings.

## § 6.5 — When a worker is blocked but the cause can be resolved

`blocked` is NOT terminal-final - it's a pause state that can resume. When a worker reports blocked (NATS block event, or DDB heartbeat sees `status=blocked`), assess whether the cause is something you (or a human in the planning thread) can resolve:

- _Auth gap, missing credential, missing dependency, infra glitch:_ often fixable in minutes. Resolve it, then either:
  - **Prompt the worker to unblock themselves**: post in the delegation thread "resolved - you can `fleetmind task unblock --task-id <hex> --worker <id> --reason "..."` and resume", OR
  - **Unblock on behalf of the worker** (operator decision): run `fleetmind task unblock --task-id <hex> --worker <worker_id> --reason "resolved by PM"` yourself. The worker's `task ack`/`ship` path continues to work from `accepted`.
- _Scope cut, missing requirement, design ambiguity:_ not a transient blocker. Treat as terminal blocked; close the loop normally (§ 7).

If you unblock, leave a note in the planning thread audit log explaining what changed, so the trail remains for human review.

## Signoff Watchdog (heartbeat-driven)

Tasks with `lifecycle: requires-human-signoff` sit at DDB `status: shipped` until a human approves. Without an explicit watchdog, they stall silently for hours - the bot ships, the work is done, but the planning thread never gets the final close because no human noticed. The watchdog surfaces them after a 4h grace period, with a per-task cooldown to avoid spam.

On each heartbeat, query for overdue in-review tasks:

```bash
fleetmind query shipped \
  --lifecycle requires-human-signoff \
  --delegated-by <pm-bot-id> \
  --stale-since 4h \
  --json
```

For each task returned, post **one** line in the planning channel (top-level, NOT in a thread):

```
Reminder: TASK#<task_id> (<one-liner from definition_of_done>) awaiting sign-off for <Nh>. <link to delegation thread>
```

Then record the nag time so we don't re-nag on the next heartbeat:

```bash
fleetmind task set-nag --task-id "${TASK_ID}"
```

_Hard rules:_

- One line per overdue task. No thread, no embellishment.
- Quiet hours apply (per HEARTBEAT.md). A task crossing 4h at 2 AM waits until morning.
- Never escalate to a DM; the planning channel is the right surface.
- Cooldown matches the threshold (4h): a still-pending task gets at most one nag per 4h window.

## Reconciliation (boot + heartbeat)

DDB drifts from the audit log when sessions die mid-write, when wake signals land twice, when a re-ship slips past idempotency, or when a parallel session edits the audit log. Reconciliation is a self-healing pass that runs _on session boot AND on every heartbeat_.

### 1. Query DDB for all live and recently-terminal tasks

```bash
fleetmind query all \
  --status delegated,accepted,shipped,blocked \
  --json
```

### 2. Diff against `## Active` blocks in `memory/active-delegations.md`

Three drift cases - handle each idempotently:

- **DDB row missing from audit log (adopt-on-wake).** A task exists in DDB but no block exists in the audit log. Synthesize the block from the DDB row and append to `## Active`. Set `Status:` from DDB status (using the vocabulary table at the top of `SKILL.md`).

- **Audit-log block whose DDB row is `merged` or `abandoned`.** Move the block to `## Closed` with `Status: done` (merged) or `Status: abandoned`. Set `Closed at:` to the DDB `merged_at` / `abandoned_at`. Set `last-handled-terminal-at:` to the same value.

- **Closed audit-log block whose DDB `shipped_at` or `blocked_at` is newer than `last-handled-terminal-at`.** Reopen-on-reship case. Run the [ddb-terminal-wake.md](ddb-terminal-wake.md) step 4 reopen procedure inline: move back to `## Active`, clear `Closeloop subagent:` / `Closeloop spawned at:`, then spawn a fresh close-the-loop sub-agent (per [close-the-loop.md](close-the-loop.md) § 7a discipline).

### 3. Post one summary line if drift was found

Gate the post on `drift_count > 0`. If nothing drifted, the heartbeat is silent.

```
Reconciled <N> drifted task(s): <comma-separated TASK#ids>.
```

Post in the planning channel top-level. Never post per-task narrative - one line, all ids. Adoption events count as drift; pure noops do not.

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
