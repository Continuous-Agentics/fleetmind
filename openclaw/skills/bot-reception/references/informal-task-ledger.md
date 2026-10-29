# Independent fleet informal-task ledger — legacy CLI reference

Direct work and native children use their parent/session, not this registration flow. Children report privately; the parent owns closeout. Before any independent self-registration, read `worker-self-start`: current `task create` may publish a NATS assignment and duplicate execution must be excluded. Missing safe producer capability is a blocker, not permission to re-dispatch.

Not all meaningful work arrives via a PM bot NATS delegation. A human asks you a direct question, you open a PR to fix something you noticed, you run a non-trivial debug session in a thread — without a TASK# row, the PM bot is blind to a real chunk of dev-channel activity.

**Rule:** any non-trivial work you do outside of a formal delegation still gets a TASK# row in DDB and an S3 narrative, with the explicitly selected non-PR lifecycle. PR-producing work requires `requires-human-signoff` and finishes at verified merge; `--lifecycle informal` is not a CLI option.

## What counts as "non-trivial"

_Write a row:_

- Independent fleet work that touches a repo; PR work always requires human signoff and merge.
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

- `--lifecycle shipped-is-done` — only for explicitly authorized non-PR completion. Never use it to bypass human signoff/merge for a PR. (`--lifecycle informal` is not a valid CLI option; `--status accepted` is not a valid flag on `task create`.)
- `--delegated-by` = your own agent ID (self-delegation).
- `task ack` after `task create` advances the row from `delegated` to `accepted`. There is no `--status` flag on `task create`.
- `--envelope-ts` — use the timestamp of the Slack message that triggered the work (optional for NATS-only fleets).
- No tracker link by default.

Generate the task ID at the moment work becomes meaningful (first commit, first infra write, first significant debug step — not at the start of every reply).

## Completing an informal task

Write the S3 narrative first (per § Ship pattern in [lifecycle-management.md](lifecycle-management.md)), then call `fleetmind task ship`. A notification is not proof of parent resumption. The parent reconciles when an actual configured check runs; no scheduler/recovery is guaranteed by this reference.
