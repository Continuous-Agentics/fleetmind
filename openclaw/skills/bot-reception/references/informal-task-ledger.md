# Informal-task ledger (direct human requests) — full detail

Not all meaningful work arrives via a PM bot NATS delegation. A human asks you a direct question, you open a PR to fix something you noticed, you run a non-trivial debug session in a thread — without a TASK# row, the PM bot is blind to a real chunk of dev-channel activity.

**Rule:** any non-trivial work you do outside of a formal delegation still gets a TASK# row in DDB and an S3 narrative, with `lifecycle: informal`. The wake pipeline fires the same way; the PM bot handles informal-lifecycle terminal events the same as delegation terminals.

## What counts as "non-trivial"

_Write a row:_

- Any work that touches a repo (commit, PR, branch push).
- Any work that touches infrastructure (Terraform, AWS API write, deploy).
- Any debugging session that takes more than ~5 minutes of meaningful work.
- Any human request you'd treat as a real task per § Handling Human Requests in `SKILL.md`.

_Do NOT write a row:_

- One-line answers to a question.
- Reactions on someone else's thread.
- Acknowledgements ("yes", "on it", "got it").
- Reading and not acting.

When ambiguous, err on the side of writing the row — the cost is microscopic; the cost of the PM bot being blind is real.

## Creating an informal task row

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

- `--lifecycle shipped-is-done` — no human sign-off required; task closes automatically when shipped. (`--lifecycle informal` is not a valid CLI option; `--status accepted` is not a valid flag on `task create`.)
- `--delegated-by` = your own agent ID (self-delegation).
- `task ack` after `task create` advances the row from `delegated` to `accepted`. There is no `--status` flag on `task create`.
- `--envelope-ts` — use the timestamp of the Slack message that triggered the work (optional for NATS-only fleets).
- No tracker link by default.

Generate the task ID at the moment work becomes meaningful (first commit, first infra write, first significant debug step — not at the start of every reply).

## Completing an informal task

Write the S3 narrative first (per § Ship pattern in [lifecycle-management.md](lifecycle-management.md)), then call `fleetmind task ship`. The DDB Streams wake fires the same way; the PM bot adopts the row into its audit log on next heartbeat via its reconciliation pass.
