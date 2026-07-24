---
name: bot-delegation
version: 1.5.0
description: "PM bot protocol for delegating dev tasks to workers via NATS and tracking them through completion. Use when a planning conversation produces a concrete assignable task, a worker event (ack/progress/ship/block) arrives, a heartbeat finds a stale delegation, or a DDB_TERMINAL_WAKE signal fires. Triggers on 'delegate this', 'assign this', or 'hand off to a worker'."
---

# Bot Delegation Protocol

This is the protocol for handing concrete work from a project-manager (PM) bot to worker bots and tracking it through completion. The task ledger is the canonical state store - DynamoDB for structured state, S3 for narrative content. The fleet CLI (`fleetmind task`, `fleetmind narrative`, `fleetmind query`) does the heavy lifting so the skill stays focused on coordination logic.

> _Hard role boundary:_ Orchestrate only. Never write code, run deploys, or modify infrastructure. If tempted to do the work yourself, the task wasn't well-scoped - push back to the human.

## Vocabulary

| Audit log state | DDB `status` |
| --- | --- |
| `pending` | `delegated` |
| `acked` | `accepted` |
| `in-review` | `shipped` + `lifecycle = requires-human-signoff` |
| `done` | `signed_off` (human approved) or `merged` (PR merged) |
| `escalated` | _(audit-log only - task is past deadline; DDB still shows prior status)_ |
| `blocked` | `blocked` |

The audit log (`memory/active-delegations.md`) is a human-readable supplement; DDB is the live source of truth. Always query DDB for programmatic decisions.

## Session boot - PM subscriber startup (mandatory)

Before handling any work, ensure the NATS PM subscriber is running (`systemctl is-active fleetmind-nats-pm.service` or `pgrep -f "fleetmind nats subscribe.*--mode pm"`); start it with `fleetmind nats subscribe --mode pm --json` if not. This subscriber is the canonical wake path - there is no polling sweep. Full startup commands: [references/session-boot.md](references/session-boot.md).

## When to start a delegation

Only when the task is concrete. It MUST have:

- One-line summary
- Definition of done (what "done" looks like, not how)
- Assignee bot (worker agent ID from fleet.yaml)
- Human requestor Slack UID (so the worker can open a thread with them)

If any are missing, push back to the human first. Do not delegate vague work.

## Step-by-step

1. Generate an 8-char hex task ID.
2. `fleetmind task create` writes the DDB record and auto-publishes the `delegation` NATS event - no separate publish step. Amend with `fleetmind task update` (never abandon+recreate) if scope changes.
3. The worker receives the NATS delegation event and opens a Slack thread directly with the requestor - the PM bot is not in that thread unless escalated.
4. Append a block to `memory/active-delegations.md` under `## Active`.

Full commands, project-slug picking, and audit-log minimum fields: [references/create-delegation.md](references/create-delegation.md).

### Watch for worker events

Events arrive via the PM subscriber started in § Session boot.

| NATS event | Action |
| --- | --- |
| `ack` from worker | Status → acked in audit log; extend deadline +10 min |
| `progress` from worker | Log update; optionally surface to human if warranted |
| `ship` from worker | Close the loop |
| `block` from worker | Close as blocked |
| `DDB_TERMINAL_WAKE: TASK#<task_id>` | See § DDB Terminal Wake (fallback path) |
| Heartbeat finds expired deadline | Escalate - [references/heartbeat-ops.md](references/heartbeat-ops.md) |

**Semantic terminal signals**: ✅ and ⛔ are canonical examples, not literal triggers. Read the meaning ("done", "merged", "deployed" = ship; "blocked", "stuck", "need X" = blocked). When ambiguous, treat as terminal - missing a real ship is worse than a redundant noop.

### DDB Terminal Wake (fallback path)

_Idempotency contract: DDB is authoritative._ When `DDB_TERMINAL_WAKE: TASK#<task_id>` arrives, read DDB first, compare its terminal timestamp against the audit log's `last-handled-terminal-at`, reopen-on-reship if DDB is newer, then close the loop. Full procedure including the reopen and hard-short-circuit steps: [references/ddb-terminal-wake.md](references/ddb-terminal-wake.md).

### Stale escalation, blocked-but-resolvable, signoff watchdog, reconciliation (heartbeat)

Every heartbeat: query DDB for stale/blocked/shipped-awaiting-signoff tasks and reconcile drift between DDB and the audit log. Full procedures: [references/heartbeat-ops.md](references/heartbeat-ops.md).

### Close the loop

On terminal status (shipped or blocked): read the DDB record and narrative, route the close-the-loop summary based on task origin (threaded reply for human-originated tasks, top-level for follow-on operational tasks), handle the `requires-human-signoff` / merge / abandon paths, then move the block to `## Closed`. **Every spawned sub-agent must end its final turn with the literal token `NO_REPLY`** and post at most one Slack message, per the templates in [assets/sub-agent-task-templates.md](assets/sub-agent-task-templates.md). Full steps, the closeout completion checklist, and the NO_REPLY discipline: [references/close-the-loop.md](references/close-the-loop.md).

## Planning Queries (before creating a new delegation)

Check prior work for patterns before drafting a new delegation:

```bash
fleetmind query merged --project <slug> --limit 10 --json   # recent merged tasks for the project
fleetmind query merged --limit 20 --json                     # cross-project
fleetmind narrative get --task-id <task_id>                  # a specific task's narrative
```

Scan `## Learned` sections for patterns relevant to the new task. Name specifics when they bear on the work.

## Abandoning a task (PM bot only)

```bash
fleetmind task abandon --task-id "${TASK_ID}" --project "${PROJECT}"
```

Worker bots cannot abandon tasks - they ping the PM bot and the PM bot calls this.

## Inbound Self-Start Notices (from worker bots)

Workers running `worker-self-start` may self-start when a human directly asks them to pick up discrete work, then post a self-start notice (`"— self-start notice"`, `Task ID:`, `Tracker:` - `"none"` valid) in this planning channel. No NATS delegation event is published - the worker is already running.

Run the handler inline (no sub-agent): verify legitimacy, react `:white_check_mark:`, resolve the project slug (ask rather than guess), check/recover the DDB row idempotently, then log it in `memory/active-delegations.md` marked `[self-start]`. Full step-by-step: [references/inbound-self-start.md](references/inbound-self-start.md) - a rare path; do not deduplicate against `worker-self-start`'s own copy (independent skill resolution makes that unsafe).

## Hard limits

- 🚫 Do NOT delegate ambiguous work. Push back first.
- 🚫 Do NOT post in worker channels. Delegation is NATS-only; Slack is human-facing only.
- 🚫 Do NOT write code, run deploys, or modify infrastructure. Orchestrate.
- 🚫 Do NOT rely on `active-delegations.md` for live state - query DDB instead.
- 🚫 Do NOT respond to worker bot messages outside the delegation protocol (exception: self-start notices - see § Inbound Self-Start Notices).
- 🚫 Do NOT post close-the-loop summaries inline on a wake turn - spawn a sub-agent.
- ✅ Always close the loop in the planning thread on every delegation.
- ✅ Always query DDB on heartbeat for live task state.
- ✅ Every delegation-lifecycle sub-agent ends its final turn with `NO_REPLY` and posts at most ONE threaded planning-thread message.

## Reference files

Load these only when the task you're handling needs them. `assets/` holds copy-pasteable templates; `references/` holds detailed procedures.

- [references/session-boot.md](references/session-boot.md) - full PM subscriber startup commands.
- [references/create-delegation.md](references/create-delegation.md) - task-ID generation, `task create`/`task update` commands, project-slug picking, audit-log fields.
- [references/ddb-terminal-wake.md](references/ddb-terminal-wake.md) - full DDB-authoritative terminal-wake handler, reopen-on-reship, hard short-circuit.
- [references/close-the-loop.md](references/close-the-loop.md) - full § 7 close-the-loop steps, closeout checklist, § 7a NO_REPLY discipline.
- [references/heartbeat-ops.md](references/heartbeat-ops.md) - stale escalation, resolvable-blocked handling, signoff watchdog, reconciliation.
- [references/inbound-self-start.md](references/inbound-self-start.md) - full handler for worker self-start notices.
- [assets/active-delegations-format.md](assets/active-delegations-format.md) - exact block template for `memory/active-delegations.md`, field semantics, reopen-on-reship.
- [assets/sub-agent-task-templates.md](assets/sub-agent-task-templates.md) - canonical, copy-pasteable `task:` briefs for every delegation-lifecycle sub-agent. **Always copy from here; never compose ad-hoc.**
