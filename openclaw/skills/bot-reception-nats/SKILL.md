---
name: bot-reception-nats
version: 1.0.0
description: >
  Protocol for worker bots receiving task delegations over NATS transport.
  Use when: your fleet.yaml has delegation_transport: nats. Covers subscriber
  startup, delegation event handling, opening a Slack thread with the human
  requestor, DDB lifecycle management (ack/ship/block), sending progress
  updates to the PM bot via NATS, and human sign-off flow. NATS is
  agent-to-agent only — Slack is for human interaction exclusively.
---

# Bot Reception — NATS Transport

## Architecture overview

```
Ariadne (PM bot)
  │  publishes fleetmind.delegation.<worker_id>
  ▼
NATS bus
  │  delivers TaskEvent{event:"delegation", requestor, description, dod, tracker_link, …}
  ▼
Worker (you)
  │  acks DDB → publishes fleetmind.task.<id>.ack
  │  opens Slack thread with requestor
  │  does the work
  │  publishes progress events → fleetmind.task.<id>.progress
  │  gets human approval in Slack thread
  │  ships DDB → publishes fleetmind.task.<id>.ship
  ▼
Ariadne receives ship event, closes out DDB
```

Slack is never used for agent-to-agent coordination. Ariadne does not post a
delegation envelope in the channel — the NATS event is the entire handshake.

---

## Session boot — subscriber startup (mandatory)

Before accepting any work, ensure the NATS subscriber is running. Check once
per session boot; do not re-start if already running.

```bash
# Check if subscriber is already running
systemctl is-active fleetmind-nats-worker.service 2>/dev/null \
  || pgrep -f "fleetmind nats subscribe" > /dev/null \
  || echo "NOT_RUNNING"
```

If not running, start it (or rely on your system's service manager):

```bash
# Foreground (dev / manual): pipe JSON events to the handler loop
fleetmind nats subscribe --mode worker --worker-id "$AGENT_ID" --json \
  | while IFS= read -r line; do
      TYPE=$(echo "$line" | jq -r '._type // .event')
      case "$TYPE" in
        delegation) handle_delegation "$line" ;;
        ack_result) : ;; # no-op — auto-ack already fired
      esac
    done
```

The subscriber auto-acks the DDB row when it receives a delegation
(`delegated → accepted`). You do not need to call `fleetmind task ack`
separately.

---

## DDB write-health precheck (mandatory)

Same as the Slack skill — run before accepting any delegation:

```bash
ERR=$(fleetmind query pending --limit 1 --json 2>&1 >/dev/null)
RC=$?
if [ $RC -ne 0 ]; then
  if [ ! -f memory/ddb-write-unhealthy.flag ]; then
    echo "unhealthy at $(date -u +%Y-%m-%dT%H:%M:%SZ): $ERR" > memory/ddb-write-unhealthy.flag
  fi
  # Do NOT ack the delegation. Publish a block event so Ariadne knows.
  echo "ABORT: DDB write path unhealthy."
  exit 1
fi
rm -f memory/ddb-write-unhealthy.flag
```

---

## On Receiving a Delegation Event

The subscriber emits one JSON line per event. A delegation looks like:

```json
{
  "v": "1.0",
  "event": "delegation",
  "task_id": "a1b2c3d4",
  "project": "my-project",
  "worker": "daedalus",
  "delegated_by": "ariadne",
  "at": "2026-05-20T23:00:00Z",
  "definition_of_done": "All tests pass and PR merged.",
  "description": "Refactor the auth module to use JWT instead of sessions.",
  "requestor": "U0ASYLGHU9E",
  "tracker_link": "https://linear.app/acme/issue/ENG-42"
}
```

### Steps

1. **Write to `memory/task-queue.md`** under `## In Progress` — crash recovery:
   ```
   - **<task_id>** — <description or dod> | started <date> | requestor: <slack_uid>
   ```

2. **DDB ack fires automatically** via the subscriber's auto-ack. Confirm
   in the `ack_result` JSON line that `status === "accepted"`.

3. **Open a Slack thread with the requestor.** Use the Slack tool to post
   in the appropriate channel (your dev channel) and @-mention the requestor.
   Thread subject line format:
   ```
   @<requestor> — I've picked up [<tracker_id>]: <title or short description>
   ```
   Include:
   - One-sentence description of what you'll build
   - Definition of done (verbatim from the event)
   - Tracker link if present
   - A clear ask: "Let me know if anything needs clarification before I start."

   Store the Slack thread timestamp (`ts`) in `memory/task-queue.md` so you
   can reply to the same thread for updates and sign-off.

4. **Get any clarifying questions answered in that thread**, then start work.

---

## Mid-task: Progress Updates

Send progress events to Ariadne periodically (at meaningful milestones —
not every tool call):

```bash
fleetmind nats progress \
  --task-id <task_id> \
  --worker "$AGENT_ID" \
  --project <project> \
  --delegated-by ariadne \
  --message "PR open at https://github.com/.../pull/42 — awaiting requestor review"
```

Also post a brief update in the Slack thread with the requestor so they
know where things stand. Keep it short — one or two sentences.

---

## Human Sign-off

Work is done when the human approves in the Slack thread. That approval is
your trigger to ship — do not self-certify.

Signs of approval (any of these suffice):
- "Looks good" / "LGTM" / "ship it" / "approved" from the requestor
- Requestor merges the PR or clicks approve on a review
- Explicit "done" or "signed off" message

### Ship flow

**Step 1: Write the S3 narrative**

```bash
cat <<'NARRATIVE' | fleetmind narrative put --task-id <task_id> --event shipped
---
v: 0.2
task_id: <task_id>
---

## Task
<one-paragraph restatement of what was delegated>

## What I did
<outcomes — not a tool transcript>

## What I didn't do
<scope cuts, follow-ups, gotchas>

## Links
- PR: <url>

## Learned
<2-5 non-obvious bullets, or []>
NARRATIVE
```

**Step 2: Update DDB shipped**

```bash
fleetmind task ship \
  --task-id <task_id> \
  --worker "$AGENT_ID" \
  --project <project>
```

This also publishes a `fleetmind.task.<id>.ship` NATS event automatically
(when transport = nats) — Ariadne receives it and closes out the DDB lifecycle.

**Step 3: Reply in the Slack thread**

Post a final update to the requestor's thread:
```
✅ Done. <one-sentence summary>
PR: <url>
What I didn't do: <scope cuts>
```

**Step 4: Update `memory/task-queue.md`** — move to `## Recently Shipped`.

---

## Block flow

If genuinely blocked (missing info, dep, access):

**Step 1: Write the S3 narrative**

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

**Step 2: Update DDB blocked**

```bash
fleetmind task block \
  --task-id <task_id> \
  --worker "$AGENT_ID" \
  --project <project>
```

This publishes `fleetmind.task.<id>.block` — Ariadne receives it.

**Step 3: Post in the Slack thread**

Tell the requestor what you're blocked on and what you need.

---

## Voice Discipline

*In Slack (human-facing):*
- Open a thread with the requestor on delegation receipt ✅
- Post progress updates and ask clarifying questions ✅
- Post the final completion summary ✅
- Do NOT narrate tool calls ("I'm now running...") ❌
- Do NOT post raw NATS event JSON ❌

*NATS (agent-to-agent — never visible to humans):*
- `delegation` — received from Ariadne ✅
- `ack` — auto-published by subscriber ✅
- `progress` — you publish at milestones ✅
- `ship` / `block` — published by `task ship/block` ✅

---

## task-queue.md maintenance

```
## In Progress
- **<task_id>** — <description> | started <date> | requestor: <slack_uid> | thread_ts: <ts>

## Recently Shipped
- **<task_id>** — <description> | shipped <date> | PR: <url>
```

---

## Changelog

- **1.0.0** — Initial release for feat/nats-transport POC (CON-115).
