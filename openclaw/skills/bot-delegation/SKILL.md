---
name: bot-delegation
version: 1.6.0
description: "Coordinator protocol for direct work, same-Gateway native children and independent fleet workers and tracking them through completion. Use when a planning conversation produces a concrete assignable task, a worker event (ack/progress/ship/block) arrives, a heartbeat finds a stale delegation, or a DDB_TERMINAL_WAKE signal fires. Triggers on 'delegate this', 'assign this', or 'hand off to a worker'."
---

# Bot Delegation Protocol

This is the protocol for handing concrete work from a project-manager (PM) bot to worker bots and tracking it through completion. The task ledger is the canonical state store - DynamoDB for structured state, S3 for narrative content. The fleet CLI (`fleetmind task`, `fleetmind narrative`, `fleetmind query`) does the heavy lifting so the skill stays focused on coordination logic.

## Choose the execution mode

- **Direct work:** perform authorized focused coding or other bounded work yourself. Coordinator roles can implement; preserve scope and human approval gates.
- **Same-Gateway native children:** use available, authorized native capabilities. Children report privately to the parent with artifacts, checks and blockers; the parent owns user-facing closeout. No separate fleet task or subscriber is required just for a child.
- **Independent fleet workers:** apply the DDB/S3 procedures below only when fleet delegation is enabled and this is a separately assigned worker. Envelopes contain what, why and DoD, not implementation instructions. Transport receipt is not admission proof.

## Vocabulary

| Audit log state | DDB `status` |
| --- | --- |
| `pending` | `delegated` |
| `acked` | `accepted` |
| `in-review` | `shipped` + `lifecycle = requires-human-signoff` |
| `approved` | `signed_off` (human approved; PR still awaiting merge) |
| `done` | `merged` for PR work; authorized non-PR lifecycle completion |
| `escalated` | _(audit-log only - task is past deadline; DDB still shows prior status)_ |
| `blocked` | `blocked` |

The audit log (`memory/active-delegations.md`) is a human-readable supplement; DDB is the live source of truth. Always query DDB for programmatic decisions.

## Session boot and recovery capability

Identify the execution mode and actual configured wake/reconciliation owner. Do not start, stop or repair subscribers from this skill. Legacy NATS checks and limitations: [references/session-boot.md](references/session-boot.md). Missing delivery/recovery capability is an explicit blocker, not a watchdog guarantee.

## When to start a delegation

Only when the task is concrete. It MUST have:

- One-line summary
- Definition of done (what "done" looks like, not how)
- Assignee bot (worker agent ID from fleet.yaml)
- Human requestor and trusted provider/account/recipient/thread routing for authorized updates (channel-less native children return privately)

If any are missing, push back to the human first. Do not delegate vague work.

## Step-by-step

1. Generate an 8-char hex task ID.
2. For an independent fleet task, `fleetmind task create` writes DDB and attempts a legacy NATS publish when configured; success is not worker admission or recovery evidence. Amend with `fleetmind task update` (never abandon+recreate) if scope changes.
3. The independent worker verifies current task/recipient state and uses its trusted authorized route for updates. Native children return to the parent privately.
4. Append a block to `memory/active-delegations.md` under `## Active`.

Full commands, project-slug picking, and audit-log minimum fields: [references/create-delegation.md](references/create-delegation.md).

### Watch for worker events

Use events actually delivered by the configured route; legacy NATS event names follow. Reread DDB before acting. A notification alone is not proof of execution.

| Delivered signal (legacy NATS names) | Action |
| --- | --- |
| `ack` from worker | Status → acked in audit log; extend deadline +10 min |
| `progress` from worker | Log update; optionally surface to human if warranted |
| `ship` from worker | Close the loop |
| `block` from worker | Close as blocked |
| `DDB_TERMINAL_WAKE: TASK#<task_id>` | See § DDB Terminal Wake (fallback path) |
| Heartbeat finds expired deadline | Escalate - [references/heartbeat-ops.md](references/heartbeat-ops.md) |

**Semantic terminal signals**: ✅ and ⛔ are canonical examples, not literal triggers. Read the meaning ("done", "merged", "deployed" = ship; "blocked", "stuck", "need X" = blocked). When ambiguous, query the authoritative task and artifact; do not invent a terminal transition.

### DDB Terminal Wake (fallback path)

_Idempotency contract: DDB is authoritative._ When `DDB_TERMINAL_WAKE: TASK#<task_id>` arrives, read DDB first, compare its terminal timestamp against the audit log's `last-handled-terminal-at`, reopen-on-reship if DDB is newer, then close the loop. Full procedure including the reopen and hard-short-circuit steps: [references/ddb-terminal-wake.md](references/ddb-terminal-wake.md).

### Stale escalation, blocked work, signoff follow-up and reconciliation

On an actual configured check or explicit review, query DDB and reconcile the audit log. Prose does not install a scheduler or guarantee recovery. Full procedures: [references/heartbeat-ops.md](references/heartbeat-ops.md).

### Close the loop

On ship/block, read the task and narrative before review. The parent delivers the summary on the trusted originating route; a native child prepares a private result only. Human approval records `signed_off`; PR work stays open until verified `merged`. A shipped PR is ready for review, not done. Full steps: [references/close-the-loop.md](references/close-the-loop.md).

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

Workers running `worker-self-start` may self-start when a human directly asks them to pick up discrete work, then post a self-start notice (`"— self-start notice"`, `Task ID:`, `Tracker:` - `"none"` valid) in this planning channel. Do not dispatch the work again: the worker is already running. The current CLI may auto-publish on task creation; see the recovery caveat in the reference.

Run the handler inline (no sub-agent): verify legitimacy, acknowledge through the configured provider, resolve the project slug (ask rather than guess), verify the DDB row and report unsafe recovery as blocked, then log it in `memory/active-delegations.md` marked `[self-start]`. Full step-by-step: [references/inbound-self-start.md](references/inbound-self-start.md) - a rare path; do not deduplicate against `worker-self-start`'s own copy (independent skill resolution makes that unsafe).

## Hard limits

- Do not delegate ambiguous work or exceed the human's scope/approval gates.
- DDB governs independent business tasks; the audit log is a supplement.
- Native children return privately; the parent owns public delivery and closeout.
- Do not create an independent task or start a service merely to do direct/native work.
- Human signoff and PR merge are separate gates; neither ship nor a channel receipt closes PR work.

## Reference files

Load these only when the task you're handling needs them. `assets/` holds copy-pasteable templates; `references/` holds detailed procedures.

- [references/session-boot.md](references/session-boot.md) - legacy NATS read-only checks and recovery limitations.
- [references/create-delegation.md](references/create-delegation.md) - task-ID generation, `task create`/`task update` commands, project-slug picking, audit-log fields.
- [references/ddb-terminal-wake.md](references/ddb-terminal-wake.md) - full DDB-authoritative terminal-wake handler, reopen-on-reship, hard short-circuit.
- [references/close-the-loop.md](references/close-the-loop.md) - full § 7 close-the-loop steps, closeout checklist, parent-owned delivery and private child reports.
- [references/heartbeat-ops.md](references/heartbeat-ops.md) - stale escalation, resolvable-blocked handling, signoff follow-up, reconciliation.
- [references/inbound-self-start.md](references/inbound-self-start.md) - full handler for worker self-start notices.
- [assets/active-delegations-format.md](assets/active-delegations-format.md) - exact block template for `memory/active-delegations.md`, field semantics, reopen-on-reship.
- [assets/sub-agent-task-templates.md](assets/sub-agent-task-templates.md) - canonical, copy-pasteable `task:` briefs for every delegation-lifecycle sub-agent. Use only when a native child is authorized and useful.
