# § 7 / § 7a — Close the loop, full detail

## Close the loop

On terminal status (shipped or blocked):

1. Read the DDB record: `fleetmind task get --task-id "${TASK_ID}" --json`. Capture project, lifecycle, task_s3_key. If you arrived from § DDB Terminal Wake, reuse the `$ITEM` and `$NARRATIVE` already fetched there - do not re-fetch.
2. Read the narrative: `fleetmind narrative get --task-id "${TASK_ID}"`. The `Learned` section is the durable signal future delegations benefit from. Ground the closeout summary in it.
3. Route and post the close-the-loop summary based on task origin:

   Read `delegation_thread` from the DDB record (captured in step 1).

   - **Thread-originated task** (`delegation_thread` is non-empty) — the task came from a human planning conversation. Post a **threaded reply** to that planning thread (`replyTo = <planning_thread_ts>`, derived from the `delegation_thread` permalink).

   - **Follow-on operational task** (`delegation_thread` is empty or absent) — the task was spun up by the PM bot programmatically, not from a human discussion thread. Post **top-level** in the planning channel (no `replyTo`). This surfaces the update in the channel feed where the team will see it without needing to navigate to a specific thread.

   Summary contents (both cases):
   - Task ID, worker, outcome (shipped / blocked)
   - One-line summary of what got done (or what's blocked + what's needed)
   - Link to artifact (PR, deploy, etc.)
   - Reference to the narrative (`fleetmind narrative get --task-id <task_id>`)

4. If lifecycle = `requires-human-signoff` and status = `shipped`:
   - Use template **(b)** from [../assets/sub-agent-task-templates.md](../assets/sub-agent-task-templates.md) - In-Review handoff, NOT close-the-loop.
   - Update audit log to `in-review`. Wait for human signoff before closing.
5. On human signoff: `fleetmind task signoff --task-id "${TASK_ID}" --project "${PROJECT}"` Then update audit log to done. Use template **(c)**.
6. On PR merge: `fleetmind task merge --task-id "${TASK_ID}" --project "${PROJECT}"`
7. Move delegation block from `## Active` to `## Closed` in audit log. Set `closed_at`. Update `last-handled-terminal-at` to the DDB terminal timestamp as the **last** mutation before moving the block to `## Closed`.

**Closeout completion check (MANDATORY before reporting done):** verify each of steps 3-7 actually happened in this turn before finishing:

- [ ] Threaded planning-channel post sent (got back a `messageId` from `message(action=send, ...)`).
- [ ] `active-delegations.md` block has been _moved_ (not just edited) from `## Active` to `## Closed` with `Closed at: <iso-8601-utc>`.
- [ ] DDB status is now `merged` / `abandoned` (via `fleetmind task merge` / `fleetmind task abandon`), or explicitly skipped with reason.
- [ ] `last-handled-terminal-at` is set to the DDB terminal timestamp in the now-closed block.

If any box is unchecked, do that step now. Posting the planning summary and stopping is not closing the loop - it leaves the block in `## Active` and the heartbeat watchdog firing forever.

_Spawn task brief:_ Use the canonical template from [../assets/sub-agent-task-templates.md](../assets/sub-agent-task-templates.md). Match the variant to the trigger (a=close-the-loop, b=In-Review, c=signoff, d=blocked-handler). Copy verbatim; fill placeholders.

_Self-check before calling `sessions_spawn`:_ search the `task` string for the literal substring `NO_REPLY`. If it's not there, the template is wrong - abort and add it.

## § 7a — Sub-agent discipline (NO_REPLY-final-turn)

_This rule is non-negotiable. It applies to **every** sub-agent spawned from this skill - close-the-loop handlers, In-Review handoffs, signoff closers, blocked-handlers, or any future variant._

> **Hard rule for every spawned sub-agent:** Must end its final turn with the literal token `NO_REPLY` and nothing else. Slack writes are limited to _exactly_ the channel posts named in its task brief, posted via the `message` tool with explicit `target` and `replyTo`. Report-back to the parent goes via the **tool result** (plain-text return value of the `task`), never via a Slack message. A top-level "Done. Accomplished: ..." post (or any unsolicited post) in the planning channel is a **bug**, not a feature. This failure mode has recurred multiple times across real delegations; the `NO_REPLY` discipline and literal templates exist specifically to prevent it.

Every sub-agent `task` block in this skill must contain an `## Output discipline (READ THIS LAST, OBEY IT FIRST)` section embedding this rule verbatim, naming its one allowed Slack write with target + replyTo, and ending with the literal `NO_REPLY` requirement - see the fenced blocks in [../assets/sub-agent-task-templates.md](../assets/sub-agent-task-templates.md) for the exact wording to copy. When adding a new variant there, follow its § Maintenance checklist.
