---
name: bot-reception
version: 1.0.0
description: >
  Protocol for receiving and handling task delegations from a PM bot in
  fleetmind-managed agent fleets. Use when: (1) you receive a delegation
  envelope with a Task ID, (2) you need to send a completion or blocker reply
  back to the PM bot, (3) a human asks you to do something directly. Covers
  envelope recognition, eyes reaction, DynamoDB ledger lifecycle state
  management (ack/ship/block via `fleetmind task` CLI), S3 narrative writing
  via `fleetmind narrative put`, voice discipline, and ACP session heuristic.
---

# Bot Reception Protocol

## Envelope Recognition

The PM bot delegation envelope looks like this:

```
@<your-bot> — task assignment

*Task:* <one-line summary>
*Task ID:* <8-char hex>
*Context:* <brief>
*Definition of done:* <criteria>

React :eyes: when started. Reply in this thread (mentioning @<pm-bot>) when done or blocked.
```

If the message has `Task ID:` and `React :eyes:` — it's a delegation. Act immediately.

### Multi-worker channels: confirm you're the recipient

Check the first `@-mention` followed by `— task assignment` at the top of the
envelope. If it is not YOUR bot — exit silently. No reaction, no reply, no
"that's not for me" message. The PM bot already knows who they delegated to.

## On Receiving a Delegation

1. **React `:eyes:`** to the delegation message.
2. Add the task to `memory/task-queue.md` under `## In Progress`.
3. **Read the task record from DynamoDB:**
   ```bash
   fleetmind task get --task-id <8-char-hex> --json
   ```
   Store the `project` slug and `task_s3_key` from the response. Never hardcode them.

4. **Acknowledge the delegation (DDB: delegated → accepted):**
   ```bash
   fleetmind task ack \
     --task-id <task_id> \
     --worker <your-agent-id-or-slack-user-id> \
     --project <project-slug>     # from step 3; saves a GetItem round-trip
   ```
   If this fails with a condition error: the task may already be accepted (rare).
   Log and proceed; do not retry indefinitely.

5. *(Optional)* Read prior task narratives for context:
   ```bash
   fleetmind query merged --project <project> --limit 5 --json \
     | jq -r '.merged[].task_id' \
     | head -3 \
     | xargs -I{} fleetmind narrative get --task-id {}
   ```

6. **Do the work silently.** See Voice Discipline below.

7. When done or blocked: write the narrative to S3, update DDB, then post the reply.

---

## DynamoDB Lifecycle State Management

### Ship (S3 narrative first, then DDB update)

**Critical ordering**: write S3 before DDB. The DDB update triggers the wake
signal (DDB Streams → EventBridge Pipe → PM bot wake). Don't fire the signal
before the narrative is readable.

**Step 1: Write the narrative to S3**

```bash
cat <<'NARRATIVE' | fleetmind narrative put --task-id <task_id> --event shipped
---
v: 0.2
task_id: <task_id>
---

## Task
<one-paragraph statement of what was delegated>

## What I did
<narrative — outcomes, not a tool-call transcript>

## What I didn't do
<scope cuts, follow-ups, gotchas>

## Links
- PR: <url>
- Preview: <url>

## Learned
<2-5 non-obvious bullets, or []>
NARRATIVE
```

If `fleetmind narrative put` exits with code 2 (S3 failure, local fallback):
write the local fallback path to `memory/task-queue.md`, surface it as a
follow-up, and do NOT proceed to DDB update yet.

**Step 2: Update DDB status to shipped**

```bash
fleetmind task ship \
  --task-id <task_id> \
  --worker <your-agent-id-or-slack-user-id> \
  --project <project-slug>     # from the initial 'task get'; saves a GetItem round-trip
```

### Block (same ordering)

**Step 1: Write the narrative to S3 (with `## Need` section)**

```bash
cat <<'NARRATIVE' | fleetmind narrative put --task-id <task_id> --event blocked
---
v: 0.2
task_id: <task_id>
---

## Task
<what was delegated>

## What I tried
<what you attempted>

## Need
<what would unblock — info, decision, dep fix>

## Learned
<bullets or []>
NARRATIVE
```

**Step 2: Update DDB status to blocked**

```bash
fleetmind task block \
  --task-id <task_id> \
  --worker <your-agent-id-or-slack-user-id> \
  --project <project-slug>     # from the initial 'task get'; saves a GetItem round-trip
```

---

## On Completion: Slack Reply

After the S3 + DDB writes succeed, post a threaded reply mentioning the PM bot:

```
@<pm-bot> — task-id: <8-char hex>

✅ Done.

Summary: <what was done — one paragraph max>
Links: <PR / preview deploy / docs>
What I didn't do: <scope cuts, gotchas, follow-ups>
```

The "What I didn't do" line is mandatory.

## On Blocker: Slack Reply

```
@<pm-bot> — task-id: <8-char hex>

⛔ Blocked.

Reason: <what's missing or wrong>
Need: <what would unblock — info, decision, dep fix, etc.>
```

## After Completion

- On human sign-off (PM bot handles the DDB `signed_off` transition)
- On PR merge (PM bot handles the DDB `merged` transition)
- `abandoned` is PM-only: if asked to abandon, ping the PM bot in the thread

---

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

---

## Voice Discipline (Mandatory)

**Never post in chat:**
- "Working..." / "Let me run X" / "Now I'll do Y"
- Shell commands or tool calls being executed
- "Not tagged on this one" (exit silently when it's not your delegation)
- Another worker's blocker or progress

**Post only:**
- `:eyes:` reaction on your own delegation
- One clarifying question if genuinely ambiguous (your delegation only)
- The completion or blocker reply in your own delegation thread

---

## Handling Human Requests (Non-Envelope)

- **Discussion:** just answer.
- **Real task:** treat like a delegation, skip task-id formality.

---

## ACP Session Heuristic

**Inline (no ACP):** single-file edit, 1-2 tool calls, mostly mechanical.
**Fork ACP session:** 3+ files, iterative work, test-driven loops, large refactors.

---

## Update task-queue.md

On receipt: add to `## In Progress`.
On completion/blocked: move to `## Done` or `## Blocked` with outcome note.
