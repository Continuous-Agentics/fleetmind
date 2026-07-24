---
name: bot-reception
version: 1.6.0
description: "Worker protocol for NATS delegation receipt: session boot, DDB health precheck, task ack/ship/block via fleetmind task CLI, S3 narrative, and human-requestor Slack threading. Use when a NATS delegation arrives, a task needs to ship or block, or a human makes a direct request. Slack is human-facing only."
---

# Bot Reception Protocol

## Session boot

Before accepting any work: (1) ensure the NATS subscriber is running (auto-acks DDB on receipt - no manual `task ack` needed), and (2) run the DDB write-health precheck so a broken write path is a loud refusal, not a silent failure. Full commands: [references/session-boot.md](references/session-boot.md).

## On Receiving a Delegation

The subscriber emits one JSON line per delegation event (see [references/receiving-delegation.md](references/receiving-delegation.md) for the exact shape).

**Step 4 (post in Slack) must land before any task work** - before reading files, running `gh`, or doing any LLM-visible reasoning about the work. The Slack post is how the human knows you're alive; without it, all activity is invisible until you ship. Steps in order:

1. Write to `memory/task-queue.md` under `## In Progress` (crash recovery).
2. Confirm DDB auto-ack (`status === "accepted"`).
3. `fleetmind task get --task-id <task_id> --json` for `project` and `task_s3_key`.
4. **Post the picked-up announcement in YOUR home channel** (not the PM's delegation thread) - the message the human is waiting for. Store the thread `ts` in `memory/task-queue.md`.
5. _(Optional)_ Read prior task narratives for context.
6. Do the work silently (see Voice Discipline).
7. When done or blocked: write the narrative to S3, update DDB, then post in the requestor's thread.

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

Also post a brief update in the requestor's Slack thread so they know where things stand. Keep it short — one or two sentences.

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

**Slack (human-facing only):** open a thread with the requestor on receipt; post progress and the final completion/blocker summary there. Do NOT narrate tool calls, post raw NATS JSON, or post in the PM bot's planning channel.

**NATS (agent-to-agent, never visible to humans):** `delegation` (received), `ack` (auto-published), `progress` (you publish at milestones), `ship`/`block` (published by the corresponding `fleetmind task` command).

## Handling Human Requests (Non-Delegation)

Classify before acting:

- **Discussion / one-liner:** just answer.
- **New feature request (vague scope):** push back - see § Push-back.
- **Human directly asks you to pick up discrete work (non-delegation):** follow `worker-self-start`.
- **Real task without a tracker (bug fix, triage, informal request):** write a DDB row + S3 narrative with `--lifecycle shipped-is-done` - see § Informal-task ledger.

## Push-back (unlinked feature requests)

When asked for new feature work that's vague, indirect, or unclear in scope: reply once asking them to describe the work and confirm, or share a tracker URL. Stop - do not implement anything. When they confirm, follow `worker-self-start`. One reply only, no repeats, no workarounds.

## Informal-task ledger (direct human requests)

Any non-trivial work done outside a formal delegation (touches a repo, touches infra, >5 min of debugging, or any request treated as a real task) still gets a TASK# row in DDB and an S3 narrative, with `--lifecycle shipped-is-done`. One-line answers, reactions, and acknowledgements do not need a row. Full criteria, exact `task create`/`task ack` commands, and completion notes: [references/informal-task-ledger.md](references/informal-task-ledger.md).

## ACP Session Heuristic

**Inline (no ACP):** single-file edit, 1-2 tool calls, mostly mechanical. **Fork ACP session:** 3+ files, iterative work, test-driven loops, large refactors.

## Update task-queue.md

On receipt: add to `## In Progress` before starting any work. Update `thread_ts` once the Slack thread opens. On completion/blocked: move to `## Recently Shipped` or `## Blocked` with an outcome note.

```
## In Progress
- **<task_id>** — <description> | started <date> | requestor: <slack_uid> | thread_ts: <ts>

## Recently Shipped
- **<task_id>** — <description> | shipped <date> | PR: <url>
```

## Reference & asset files

Load these only when the task you're handling needs them. `assets/` holds copy-pasteable templates; `references/` holds detailed procedures.

- [references/session-boot.md](references/session-boot.md) - full NATS subscriber startup and DDB write-health precheck commands.
- [references/receiving-delegation.md](references/receiving-delegation.md) - full delegation-receipt steps, JSON event shape, and the exact picked-up announcement template.
- [references/lifecycle-management.md](references/lifecycle-management.md) - full ship/block/unblock commands, completion and blocker post templates, post-completion handoff.
- [references/informal-task-ledger.md](references/informal-task-ledger.md) - full non-trivial-work criteria and informal task-row commands.
- [assets/narrative-template.md](assets/narrative-template.md) - exact S3 narrative frontmatter/section templates for ship and block events. **Always copy from here; never compose the narrative headers ad-hoc.**
