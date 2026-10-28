---
name: bot-reception
version: 1.7.0
description: "Independent fleet worker protocol: verify assignment and DDB state, task ack/ship/block, S3 narrative and trusted human-facing routing. Native children return privately to the parent. Use when a NATS delegation arrives, a task needs to ship or block, or a human makes a direct request. Slack is human-facing only."
---

# Bot Reception Protocol

## Session boot

Apply this protocol only to enabled independent fleet assignments. Direct work follows the human request; same-Gateway native children report privately to the parent, which owns user-facing closeout. Do not start a subscriber. Identify actual delivery and ledger capabilities; a query is not proof of write health. Full commands: [references/session-boot.md](references/session-boot.md).

## On Receiving a Delegation

Legacy NATS deployments may emit one JSON line per delegation event (see [references/receiving-delegation.md](references/receiving-delegation.md) for the exact shape).

Verify recipient and authoritative task state before work. A legacy auto-ack
is not native admission evidence. Resolve provider/account/recipient/thread from
trusted task/session context before any authorized worker notice. The parent
owns final closeout; native children send no public worker notice.

1. Verify assignment and DDB state, including `project` and `task_s3_key`.
2. Acknowledge actual pickup only when the current task is delegated to you.
3. Use the configured route for authorized receipt/progress updates; do not guess.
4. Read prior narratives when useful, then carry out the scoped work.
5. On ship/block, write S3 narrative before the DDB transition and return evidence.

Full steps, exact announcement template, and the home-channel-vs-PM-channel distinction: [references/receiving-delegation.md](references/receiving-delegation.md).

## Mid-task: Progress Updates

At meaningful milestones (PR open, tests passing, waiting on review):

```bash
fleetmind nats progress \
  --task-id <task_id> \
  --worker "$AGENT_ID" \
  --project <project> \
  --delegated-by <pm_bot_id> \
  --message "PR open at https://github.com/.../pull/42 — awaiting review"
```

For legacy NATS fleets only; for other configured routes use supported progress delivery. Any authorized human-facing update uses the trusted originating route. Keep it short — one or two sentences.

## DynamoDB Lifecycle State Management

**Critical ordering**: write the S3 narrative before the DDB update (the DDB update triggers the wake signal). Copy templates from [assets/narrative-template.md](assets/narrative-template.md) - never compose ad-hoc. Ship: `fleetmind task ship`. Block: `fleetmind task block` (same ordering, `## Need` section). `task unblock` resumes a resolved blocker back to `accepted`; prefer `task update` over blocking when only the DoD needs clarifying. Full commands, completion/blocker post templates, and post-completion PM-bot handoff: [references/lifecycle-management.md](references/lifecycle-management.md).

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

## Voice Discipline (Mandatory)

**Human-facing routing:** use the configured provider and trusted recipient/thread for authorized worker updates; the parent owns closeout. Legacy Slack routes use provider-specific IDs and `<@USERID>` mentions. Do NOT narrate tool calls, post raw NATS JSON, or post in the PM bot's planning channel.

**Legacy NATS independent fleets only:** `delegation` (received), `ack` (auto-published), `progress` (you publish at milestones), `ship`/`block` (published by the corresponding `fleetmind task` command).

## Handling Human Requests (Non-Delegation)

Classify before acting:

- **Discussion / one-liner:** just answer.
- **New feature request (vague scope):** push back - see § Push-back.
- **Human directly asks you to pick up discrete work (non-delegation):** follow `worker-self-start`.
- **Independent fleet task without a tracker:** follow safe registration in `worker-self-start`; PR work requires human signoff and verified merge. Direct/native work uses its parent/session.

## Push-back (unlinked feature requests)

When asked for new feature work that's vague, indirect, or unclear in scope: reply once asking them to describe the work and confirm, or share a tracker URL. Stop - do not implement anything. When they confirm, follow `worker-self-start`. One reply only, no repeats, no workarounds.

## Informal-task ledger (direct human requests)

Only independent fleet work uses the ledger procedures. PR work uses `requires-human-signoff`; an explicitly chosen non-PR lifecycle may allow completion at ship. Direct/native work uses its parent/session. One-line answers, reactions, and acknowledgements do not need a row. Full criteria, exact `task create`/`task ack` commands, and completion notes: [references/informal-task-ledger.md](references/informal-task-ledger.md).

## Native child use

Use only an available, authorized capability when useful. Children return privately with artifacts, checks and blockers; the parent reviews and owns user-facing closeout.

## Recovery and visibility

The DynamoDB task ledger is the only task-state source of truth. On receipt,
confirm the accepted record; on completion or blocking, update its lifecycle
through `fleetmind task`. Include `TASK#<task_id>` in the home-channel message
so a restarted worker can recover the human-facing thread through Slack search.

```
## In Progress
- **<task_id>** — <description> | started <date> | requestor: <slack_uid> | thread_ts: <ts>

## Recently Shipped
- **<task_id>** — <description> | shipped <date> | PR: <url>
```

## Reference & asset files

Load these only when the task you're handling needs them. `assets/` holds copy-pasteable templates; `references/` holds detailed procedures.

- [references/session-boot.md](references/session-boot.md) - legacy read-only subscriber checks and ledger capability limitations.
- [references/receiving-delegation.md](references/receiving-delegation.md) - full delegation-receipt steps, JSON event shape, and the exact picked-up announcement template.
- [references/lifecycle-management.md](references/lifecycle-management.md) - full ship/block/unblock commands, completion and blocker post templates, post-completion handoff.
- [references/informal-task-ledger.md](references/informal-task-ledger.md) - full non-trivial-work criteria and informal task-row commands.
- [assets/narrative-template.md](assets/narrative-template.md) - exact S3 narrative frontmatter/section templates for ship and block events. **Always copy from here; never compose the narrative headers ad-hoc.**
