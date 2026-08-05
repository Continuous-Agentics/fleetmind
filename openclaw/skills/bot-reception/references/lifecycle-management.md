# DynamoDB Lifecycle State Management — full detail

## Ship (S3 narrative first, then DDB update)

**Critical ordering**: write S3 before DDB. The DDB update triggers the wake signal (DDB Streams → EventBridge Pipe → PM bot wake). Don't fire the signal before the narrative is readable.

Write the narrative first, then update DDB. Copy the exact templates from [../assets/narrative-template.md](../assets/narrative-template.md) - do not compose the frontmatter/section headers ad-hoc.

```bash
fleetmind task ship \
  --task-id <task_id> \
  --worker <your-agent-id-or-slack-user-id> \
  --project <project-slug>     # from the initial 'task get'; saves a GetItem round-trip
```

If `fleetmind narrative put` exits with code 2 (S3 failure, local fallback): surface the fallback path as a follow-up, preserve it locally until the S3 write can be retried, and do NOT proceed to the DDB update yet.

## Block (same ordering)

Same S3-then-DDB ordering, using the block template (with `## Need`) from [../assets/narrative-template.md](../assets/narrative-template.md):

```bash
fleetmind task block \
  --task-id <task_id> \
  --worker <your-agent-id-or-slack-user-id> \
  --project <project-slug>     # from the initial 'task get'; saves a GetItem round-trip
```

## Unblock pattern

If you've called `task block` and the blocking condition has since been resolved (transient auth gap fixed, missing dep installed, etc.), call `task unblock` to transition back to `accepted` and resume:

```bash
fleetmind task unblock --task-id <hex> --worker <your-id> --reason "auth restored"
```

Then proceed with the normal ship pattern (`narrative put` → `task ship`).

If the DoD as written is ambiguous or impossible, you can request the PM update it via `task update` rather than blocking. Propose the revised wording in the delegation thread so the PM can run:

```bash
fleetmind task update --task-id <hex> --dod "..." --reason "clarified after worker review"
```

This avoids the overhead of abandoning and recreating the task when only the definition of done needs refinement.

## On Completion

After the S3 + DDB writes succeed, post in the _requestor's_ Slack thread:

```
✅ Done.

Summary: <what was done — one paragraph max>
Links: <PR / preview deploy / docs>
What I didn't do: <scope cuts, gotchas, follow-ups>
```

`fleetmind task ship` automatically publishes a `fleetmind.task.<id>.ship` NATS event — the PM bot receives it and closes out the DDB lifecycle. No separate reply to the PM bot is needed.

The "What I didn't do" line is mandatory.

## On Blocker

Post in the requestor's Slack thread:

```
⛔ Blocked.

Reason: <what's missing or wrong>
Need: <what would unblock — info, decision, dep fix, etc.>
```

`fleetmind task block` publishes `fleetmind.task.<id>.block` — the PM bot receives it automatically.

## After Completion

- On human sign-off: PM bot handles the DDB `signed_off` transition on receipt of the `ship` NATS event.
- On PR merge: PM bot handles the DDB `merged` transition.
- `abandoned` is PM-only: if asked to abandon, the PM bot calls `fleetmind task abandon`.
