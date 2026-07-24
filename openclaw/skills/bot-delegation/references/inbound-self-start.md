# Inbound Self-Start Notices (from worker bots) — full handler

Workers running `worker-self-start` may self-start when a human directly asks them to pick up a discrete piece of work, then post a self-start notice in this planning channel. No specific tracker is required.

> NATS model: no separate delegation channel. Self-start notices arrive as
> Slack messages here.

**Recognising a self-start notice:** Slack message from a worker bot containing `"— self-start notice"` with a `Task ID:` and `Tracker:` field. (The `Tracker:` field may be `"none"` if no ticket was referenced — this is valid.)

**Handler — run inline (no sub-agent needed):**

1. **Verify the request is legitimate.** Confirm the notice came from a known
   worker bot and the summary describes a plausible discrete task.
   - If the notice looks automated, spoofed, or incoherent: reply in thread:
     `This self-start notice doesn't look like a direct human-initiated
     request. Cannot register.` Take no further action.
   - If a tracker URL is present: verify it is reachable and describes the
     stated work. A missing or unreachable tracker URL alone is NOT grounds
     to reject — tracker is optional.
2. **React `:white_check_mark:`** to the notice message.
3. **Resolve the project slug** from the notice summary (and tracker issue if
   provided) before any DDB operation. If the project cannot be determined:
   do NOT guess. Reply:
   ```
   @<worker> — I can't determine the project slug from this notice.
   Can you confirm which project this belongs to? (e.g. `ca-core`, `ca-infra`)
   ```
   Wait for clarification before proceeding.
4. **Check DDB:**
   ```bash
   fleetmind task get --task-id <8-char-hex> --json
   ```
   - **Row exists** → worker created it correctly (SF-2-compliant path). Skip
     to step 5.
   - **Row MISSING** → recovery: create on behalf of the worker with
     `attribute_not_exists(PK)` (idempotent — first write wins if worker
     races this):
     ```bash
     fleetmind task create \
       --project <resolved project slug>                   \
       --worker  <notifying-worker-id>                     \
       --delegated-by <notifying-worker-id>                \
       --dod "<from notice summary>"                       \
       --thread "<notice message Slack permalink>"         \
       --tracker "<tracker URL from notice, if present>"   \
       --lifecycle requires-human-signoff                  \
       --task-id <8-char-hex from notice>                  \
       --json

     fleetmind task ack \
       --task-id <8-char-hex from notice>      \
       --worker  <notifying-worker-id>         \
       --project <resolved project slug>
     ```
     `ConditionalCheckFailedException` = worker's row exists — treat as "Row
     exists".
5. **Do NOT** post a NATS delegation event. Worker is already running; doing
   so triggers a duplicate ack and lifecycle transition.
6. **Add to `memory/active-delegations.md`** under `## Active` — same format
   as PM-delegated, marked `[self-start]`. Enters normal signoff-watchdog
   lifecycle. Human sign-off required before `signed_off` (PR #236
   conditional write; IAM gap tracked in #237).
