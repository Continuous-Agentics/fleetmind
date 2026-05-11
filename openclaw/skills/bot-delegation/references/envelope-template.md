# Envelope Template

The delegation envelope is the canonical hand-off from the PM bot to a
specialist worker. It is posted top-level (NOT in a thread) in the worker's
dev channel.

## The envelope

```
@<ASSIGNEE> — task assignment

*Task:* <one-line summary>
*Task ID:* <8-char hex>
*Requested by:* @<REQUESTER>
*Context:* <2-3 sentence brief, links if any>
*Definition of done:* <what "done" looks like>

React :eyes: when started. Reply in this thread (mentioning @<PM_BOT>) when done or blocked.
```

- `@<ASSIGNEE>` is the worker bot's user mention in your chat system.
- `@<REQUESTER>` is the *human* who asked for the work — pulling them into the
  thread automatically so the worker can ping them with questions. Required on
  every envelope. Use the requester's user mention (not their display name) so
  the chat system actually notifies them.
- `@<PM_BOT>` is your own user mention; goes in the ack instruction so the
  worker knows where to thread completion replies.

## Multi-worker channels: never mention the other worker

When a single channel hosts multiple specialist workers, **never @-mention any
worker other than the recipient inside the envelope body** — including in
*Context*, *Definition of done*, or follow-up notes. Other workers wake on
every @-mention they see, even when the message clearly isn't for them, and
the multi-specialist filter discipline is fragile.

**Wrong:**

```
*Context:* Building API for the launch widget; @<FRONTEND_BOT> will wire the status panel separately.
```

**Right:**

```
*Context:* Building API for the launch widget; the frontend worker will wire the status panel separately.
```

Use the worker's plain display name (or a role label like "the frontend
worker") in narrative text. The single allowed @-mention of a worker is the
*recipient* at the top of the envelope (`@<ASSIGNEE> — task assignment`).

This rule applies to every worker beyond the recipient, no matter how many
specialists share the channel.

## Sending the envelope

Use the fleetmind delivery tool (or your chat system's send command) with an
explicit channel target and *no* thread parent — the envelope must be
top-level so the resulting thread is the durable delegation surface.

For replies inside an active delegation thread, always pass the channel
target *and* the thread parent explicitly. Subagent and ACP completion
replies in particular must carry both, because the originating thread
context is not preserved across hops.

## What NOT to put in the envelope

- ❌ External issue-tracker identifier or URL — workers don't track tickets;
  link out from the narrative instead if relevant.
- ❌ Estimated time or due date — deadlines are the PM's concern, not the
  worker's.
- ❌ Multiple tasks bundled together — one envelope = one task ID = one
  Definition of done.
- ❌ Long context dumps — link out to the source (design doc, PR, log) rather
  than pasting it into the envelope.
