---
name: bot-reception
version: 1.1.0
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

## Session boot — DDB write-health precheck (mandatory)

Before accepting any new delegation, every worker session validates that its
DDB read/write path works. This is the first thing the session does after boot —
ahead of envelope handling, ahead of any task-queue work.

Why: a worker with a broken DDB write path will read envelopes, react `:eyes:`,
and silently fail to record `accepted`/`shipped`/`blocked`. From the PM bot's
side that looks like a worker accepting work and then ghosting. A no-op precheck
at boot turns the silent failure into a loud, explicit refusal that humans can
resolve.

```bash
# A no-op query to exercise the DDB path. Uses the read side;
# any IAM permission gap, network failure, or config error surfaces here.
ERR=$(fleetmind query pending --limit 1 --json 2>&1 >/dev/null)
RC=$?

if [ $RC -ne 0 ]; then
  # Post ONCE in the worker channel and refuse new delegations.
  # Use a memory flag so we don't re-post on every boot when the gap persists.
  if [ ! -f memory/ddb-write-unhealthy.flag ]; then
    # message tool: top-level post in the worker channel
    # Body: ":warning: DDB write path unhealthy — refusing new work until resolved. Error: <first-line of ERR>"
    echo "unhealthy at $(date -u +%Y-%m-%dT%H:%M:%SZ): $ERR" > memory/ddb-write-unhealthy.flag
  fi
  echo "ABORT: DDB write path unhealthy. Refusing new delegations until resolved."
  exit 1
fi

# Healthy. Clear the flag if it existed (auto-recovery is fine).
rm -f memory/ddb-write-unhealthy.flag
```

*Behaviour while unhealthy:*
- Do NOT react `:eyes:` to delegation envelopes.
- Do NOT update DDB.
- Do NOT do the work.
- Do post one threaded reply on any *new* envelope:
  `":warning: DDB write path unhealthy — not accepting new work until verified. See top-level notice in this channel."`
  Use the same memory flag to ensure at most one such reply per envelope.
- The unhealthy flag self-clears on the next clean precheck. Workers do NOT
  post a "recovered" notice; the next successful `accepted`/`shipped` write
  is implicit recovery.

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

Examples of "exit silently":
- An envelope addressed to another worker mentions you in the Context — you
  wake on the `@-mention`, recognize it's not your delegation, do nothing.
- Another worker posts a ✅ reply in their own thread — you wake on the channel
  message, recognize it's not yours, do nothing.
- A human asks another worker about their work — you wake, recognize it's not
  yours, do nothing.

*The only exception:* if a human explicitly `@-mentions` you directly with a
non-envelope task or question (no `Task ID:` line), handle it per
§ Handling Human Requests. The exit-silently rule applies only to delegation
envelopes and worker-to-worker traffic.

## On Receiving a Delegation

1. **Write the task to `memory/task-queue.md`** under `## In Progress` with
   task ID and source thread ts. Do this *before* any other action — this is
   the crash-recovery record. If the session crashes between this write and
   the `:eyes:` reaction, the task is not lost.
2. **React `:eyes:`** to the delegation message.
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

## Unblock pattern

If you've called `task block` and the blocking condition has since been resolved (transient auth gap
fixed, missing dep installed, etc.), call `task unblock` to transition back to `accepted` and resume:

```bash
fleetmind task unblock --task-id <hex> --worker <your-id> --reason "auth restored"
```

Then proceed with the normal ship pattern (`narrative put` → `task ship`).

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
- **Real task:** treat like a delegation, skip task-id formality on the Slack surface,
  but **still write a DDB row + S3 narrative under `lifecycle: informal`** — see
  § Informal-task ledger below.

---

## Informal-task ledger (non-envelope work in bot channels)

Not all meaningful work arrives via a PM bot delegation envelope. A human asks
you a direct question, you open a PR to fix something you noticed, you run a
non-trivial debug session in a thread — without a TASK# row, the PM bot is blind
to a real chunk of dev-channel activity.

**Rule:** any non-trivial work you do outside of a formal delegation still gets a
TASK# row in DDB and an S3 narrative, with `lifecycle: informal`. The wake
pipeline fires the same way; the PM bot handles informal-lifecycle terminal
events the same as delegation terminals.

### What counts as "non-trivial"

*Write a row:*
- Any work that touches a repo (commit, PR, branch push).
- Any work that touches infrastructure (Terraform, AWS API write, deploy).
- Any debugging session that takes more than ~5 minutes of meaningful work.
- Any human request you'd treat as a real task per § Handling Human Requests.

*Do NOT write a row:*
- One-line answers to a question.
- Reactions on someone else's thread.
- Acknowledgements ("yes", "on it", "got it").
- Reading and not acting.

When ambiguous, err on the side of writing the row — the cost is microscopic;
the cost of the PM bot being blind is real.

### Creating an informal task row

```bash
fleetmind task create \
  --project <best-fit-project-slug> \
  --worker <your-agent-id> \
  --delegated-by <your-agent-id> \
  --dod "<one-line summary, no PII>" \
  --thread "<slack permalink to the thread the work originated in>" \
  --lifecycle informal \
  --task-id "${TASK_ID}" \
  --status accepted \
  --json
```

Key differences from a standard delegation row:
- `--lifecycle informal` (the PM bot's signoff watchdog ignores these).
- `--delegated-by` = your own agent ID (self-delegation).
- `--status accepted` from the start (no separate `delegated` step).
- No tracker link by default.

Generate the task ID at the moment work becomes meaningful (first commit, first
infra write, first significant debug step — not at the start of every reply).

### Completing an informal task

Write the S3 narrative first (per § Ship pattern), then call `fleetmind task ship`.
The DDB Streams wake fires the same way; the PM bot adopts the row into its audit
log on next heartbeat via its reconciliation pass.

---

## ACP Session Heuristic

**Inline (no ACP):** single-file edit, 1-2 tool calls, mostly mechanical.
**Fork ACP session:** 3+ files, iterative work, test-driven loops, large refactors.

---

## Update task-queue.md

On receipt: add to `## In Progress` (before `:eyes:` reaction — crash-recovery record).
On completion/blocked: move to `## Done` or `## Blocked` with outcome note.

---

## Changelog

- **1.1.0 (2026-05-11)** — Port substantive protocol improvements from Carpe POC
  v2.5.0–v2.5.1 (generalized; Carpe-specific channel IDs, bot IDs, and AWS table
  names stripped):
  - New § Session boot — DDB write-health precheck: every worker session does a
    no-op `fleetmind query` at boot before accepting any new delegation. On
    failure, posts once in the worker channel and refuses new work until
    verified. Closes the silent-worker failure mode where a broken DDB write
    path looked indistinguishable from a healthy worker that ghosted.
  - task-queue-before-:eyes: ordering (v2.5.1 fix): `memory/task-queue.md` is
    now written *before* the `:eyes:` reaction. This prevents the dark-period
    bug where a session crash between `:eyes:` and the task-queue write left
    the bot appearing to accept work it had no record of.
  - New § Informal-task ledger: non-trivial dev-channel work that isn't a PM
    bot delegation (direct human asks, self-initiated repo touches, infra
    writes, >5-min debug sessions) now gets a `lifecycle: informal` TASK# row.
    PM bot reconciliation adopts these rows automatically; signoff watchdog
    ignores them. Closes the visibility gap where meaningful worker activity
    was invisible to the PM bot.
- **1.0.0** — Initial release.
