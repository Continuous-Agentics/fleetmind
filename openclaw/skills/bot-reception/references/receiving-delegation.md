# On Receiving a Delegation — full detail

The subscriber emits one JSON line per delegation event:

```json
{
  "v": "1.0",
  "event": "delegation",
  "task_id": "a1b2c3d4",
  "project": "my-project",
  "worker": "forge",
  "delegated_by": "conductor",
  "at": "2026-05-20T23:00:00Z",
  "definition_of_done": "All tests pass and PR merged.",
  "description": "Refactor the auth module to use JWT instead of sessions.",
  "requestor": "U_REQUESTOR",
  "tracker_link": "https://github.com/acme/repo/issues/42"
}
```

## Steps

The first three steps below are **bookkeeping**. **Step 4 (post in Slack) is the first thing the human sees.** Do steps 1–3 in any order, but **step 4 MUST land before you start any task work** — before reading files in the target repo, running `gh`, calling external APIs, or doing any LLM-visible reasoning about the work itself. The Slack post is how the human knows you're alive and on the task; without it, all subsequent activity is invisible until you ship, which feels like the bot died. If you find yourself about to call a tool whose purpose is to do the work (not to post in Slack, not to read DDB), and you haven't posted in step 4 yet, **stop and post first**.

1. **Write to `memory/task-queue.md`** under `## In Progress` — crash recovery:

   ```
   - **<task_id>** — <description> | started <date> | requestor: <slack_uid> | thread_ts: (pending)
   ```

2. **DDB auto-acks** via the subscriber. Confirm `status === "accepted"` in the `ack_result` JSON line.

3. **Read the task record from DynamoDB** to get `project` and `task_s3_key`:

   ```bash
   fleetmind task get --task-id <task_id> --json
   ```

4. **Post your picked-up announcement in YOUR home channel — BEFORE any task work.**

   **Your home channel** is the Slack channel under your `channels:` block in `fleet.yaml` (and renders into the channel-routing entry of your `openclaw.json`). It is the channel YOU live in — separate from the PM bot's channel where the human pinged. The subscriber may already have posted an instant _"👋 Received delegation"_ line there and routed your wake into that fresh thread; check the active session's channel via your slack tool. Your job is to reply IN THAT THREAD with the considered picked-up message below. **Do not post in the PM's delegation thread — that thread lives in the PM's channel and is the PM↔human conversation.** Use the delegation_thread URL only as a back-link in your announcement so the human can trace which conversation triggered this work.

   This is the message the human is waiting for in YOUR channel; do not skip it, defer it, or parallelize it with the work itself.

   ```
   @<requestor> — picked up [<tracker_id>]: <title>

   <one-sentence description of what you'll build>
   Done when: <definition of done verbatim>
   Triggered by: <delegation_thread URL>
   <tracker_link if present>

   Let me know if anything needs clarification before I start.
   ```

   Store the Slack thread `ts` in `memory/task-queue.md` (replace `thread_ts: (pending)` with `thread_ts: <ts>`).

   **You may now begin task work.** Steps 5+ below are the work itself. All subsequent activity for this delegation (progress updates, the ship announcement) threads under the SAME root in YOUR home channel — never in the PM's delegation thread.

5. _(Optional)_ Read prior task narratives for context:

   ```bash
   fleetmind query merged --project <project> --limit 5 --json \
     | jq -r '.merged[].task_id' \
     | head -3 \
     | xargs -I{} fleetmind narrative get --task-id {}
   ```

6. **Do the work silently.** See Voice Discipline in `SKILL.md`.

7. When done or blocked: write the narrative to S3, update DDB, then post in the requestor's Slack thread.
