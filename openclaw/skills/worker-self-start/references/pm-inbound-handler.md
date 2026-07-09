# PM Inbound Handler — Worker Self-Start Notices

> Read this when you are the **PM bot** and a worker posts a self-start notice
> in the planning channel. See also: `bot-delegation` § Inbound Self-Start
> Notices, which carries the same protocol as the authoritative PM skill.

## Recognising a self-start notice

A Slack message in the planning channel from a worker bot containing
`"— self-start notice"` with a `Task ID:` and `Linear:` field.

## Handler — run inline (no sub-agent needed for initial receipt)

### 1. Verify the Linear assignment

Fetch the Linear issue from the notice URL (use the `linear-fleet` skill).
Confirm it is assigned to the notifying worker.
- If NOT assigned: reply in thread:
  ```
  Linear issue is not assigned to you — cannot register this self-start.
  ```
  Take no further action.

### 2. React `:white_check_mark:` to the notice

### 3. Resolve the project slug (before any DDB operation)

Inspect the Linear issue's labels and project to determine the correct
`--project` slug for the DDB row.

If labels are **missing** or **ambiguous** (multiple project labels, no
recognisable fleet project label, or the label doesn't map to a known slug):
**do NOT guess.** Reply in the notice thread:
```
@<worker> — I can't determine the project slug from this issue's labels.
Can you confirm which project this belongs to? (e.g. `ca-core`, `ca-infra`)
```
Wait for clarification before any DDB operation.

### 4. Check DDB for the task row

```bash
fleetmind task get --task-id <8-char-hex from notice> --json
```

**Row EXISTS** → no DDB action needed; the worker created it correctly
(the normal, SF-2-compliant path). Skip to step 5.

**Row MISSING** → recovery path; create it on behalf of the worker
(worker crashed before step 3). Use `attribute_not_exists(PK)` to make this
idempotent — if the worker's row creation races your recovery, the first write
wins and the second is a safe no-op:

```bash
fleetmind task create \
  --project <resolved project slug>       \
  --worker  <notifying-worker-id>         \
  --delegated-by <notifying-worker-id>    \
  --dod "<from Linear issue title>"       \
  --thread "<notice message Slack permalink>" \
  --tracker "<Linear URL from notice>"    \
  --lifecycle requires-human-signoff      \
  --task-id <8-char-hex from notice>      \
  --json

fleetmind task ack \
  --task-id <8-char-hex from notice>      \
  --worker  <notifying-worker-id>         \
  --project <resolved project slug>
```

`ConditionalCheckFailedException` from `task create` = the worker's row already
exists — treat as "Row EXISTS" above.

### 5. Do NOT post a delegation envelope

The worker is already running; a NATS delegation event would trigger a
duplicate ack and a duplicate DDB lifecycle transition.

### 6. Record in `memory/active-delegations.md`

Add under `## Active` in the same format as a PM-delegated task, but mark it
`[self-start]` in the notes column. The task enters the normal
signoff-watchdog lifecycle — human sign-off is required before `signed_off`
(enforced by the `mergeTask` conditional write, PR #236; IAM gap tracked in
#237).
