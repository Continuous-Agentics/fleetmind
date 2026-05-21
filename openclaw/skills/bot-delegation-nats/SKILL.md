---
name: bot-delegation-nats
version: 1.0.0
description: >
  Protocol for PM bots delegating tasks to workers over NATS transport.
  Use when: your fleet.yaml has delegation_transport: nats. Covers subscriber
  startup for receiving worker events, task creation with full delegation
  payload (requestor, description, dod, tracker link), monitoring progress
  events, and closing out the DDB lifecycle on ship/block. NATS is
  agent-to-agent only — no Slack envelopes are posted for bot-to-bot
  handoffs.
---

# Bot Delegation — NATS Transport

## Architecture overview

```
Human works with Ariadne to define a feature
  │
  ▼
Ariadne creates DDB task record → fleetmind task create publishes:
  fleetmind.delegation.<worker_id>
  {task_id, requestor, description, dod, tracker_link, …}
  │
  ▼
Worker receives via NATS → acks DDB → opens Slack thread with requestor
  │
  ▼
Worker publishes progress: fleetmind.task.<id>.progress
Ariadne receives → logs, optionally notifies human
  │
  ▼
Worker ships: fleetmind.task.<id>.ship
Ariadne receives → DDB signed_off, tracker updated, closes out
```

No Slack envelope is posted in the dev channel. The requestor's Slack DM
(opened by the worker) is the human-facing surface. Ariadne's side is
entirely NATS-driven.

---

## Session boot — PM subscriber startup (mandatory)

Start the PM subscriber before handling any work. This replaces cron sweep jobs.

```bash
# Ensure the PM subscriber is running
systemctl is-active fleetmind-nats-pm.service 2>/dev/null \
  || pgrep -f "fleetmind nats subscribe.*--mode pm" > /dev/null \
  || echo "NOT_RUNNING"
```

If not running, start it:

```bash
fleetmind nats subscribe --mode pm --json \
  | while IFS= read -r line; do
      EVENT=$(echo "$line" | jq -r '.event // empty')
      TASK_ID=$(echo "$line" | jq -r '.task_id // empty')
      case "$EVENT" in
        ack)      handle_worker_ack "$line" ;;
        progress) handle_worker_progress "$line" ;;
        ship)     handle_worker_ship "$line" ;;
        block)    handle_worker_block "$line" ;;
      esac
    done
```

The subscriber feeds a persistent event loop. Each event type triggers
the appropriate DDB transition and (where needed) human notification.

---

## Creating a Delegation

After working with the human to define the work:

```bash
TASK_ID=$(fleetmind task create \
  --project <slug> \
  --worker <worker_agent_id> \
  --delegated-by "$AGENT_ID" \
  --dod "<definition of done>" \
  --description "<what needs to be built — context for the worker>" \
  --requestor "<human_slack_uid>" \
  --tracker "<linear_or_jira_url>" \
  --thread "<slack_permalink_to_architecture_discussion>" \
  --envelope-ts "<slack_ts_of_architecture_message>" \
  --json | jq -r '.task_id')
echo "Created task: $TASK_ID"
```

`fleetmind task create` automatically publishes the `delegation` event to
`fleetmind.delegation.<worker_id>` when `delegation_transport: nats`.
No additional publish step needed.

### Delegation payload fields

| Field | Source | Purpose |
|-------|--------|---------|
| `task_id` | auto-generated | Unique task identifier |
| `requestor` | human Slack UID | Worker uses this to open Slack thread |
| `description` | PM fills in | Work context / what to build |
| `definition_of_done` | PM + human agree | Worker's acceptance criteria |
| `tracker_link` | Linear/Jira URL | Worker updates ticket; Ariadne closes it |
| `project` | fleet config | DDB namespace |
| `worker` | routing | Which worker gets the delegation |
| `delegated_by` | this bot's ID | Worker knows who to send events back to |

---

## Receiving Worker Events

### ack

Worker has received the delegation and started.

```bash
handle_worker_ack() {
  local event="$1"
  local task_id=$(echo "$event" | jq -r '.task_id')
  local worker=$(echo "$event" | jq -r '.worker')
  # Log for audit. DDB is already updated by the worker (delegated → accepted).
  echo "[nats] task $task_id acked by $worker"
}
```

### progress

Worker is reporting a mid-task update.

```bash
handle_worker_progress() {
  local event="$1"
  local task_id=$(echo "$event" | jq -r '.task_id')
  local message=$(echo "$event" | jq -r '.message')
  # Log. Optionally surface to the human if the message warrants it.
  echo "[nats] task $task_id progress: $message"
}
```

### ship

Worker is done; human has approved. Transition DDB to `signed_off`.

```bash
handle_worker_ship() {
  local event="$1"
  local task_id=$(echo "$event" | jq -r '.task_id')
  local project=$(echo "$event" | jq -r '.project')

  # DDB: shipped → signed_off (Ariadne owns this transition)
  fleetmind task signoff \
    --task-id "$task_id" \
    --project "$project"

  # Update the tracker ticket (Linear → Done, etc.)
  # tracker_link is available in the event if you stored it at create time:
  local tracker=$(echo "$event" | jq -r '.tracker_link // empty')
  # [ close the ticket via linear-fleet skill or equivalent ]

  echo "[nats] task $task_id signed off."
}
```

### block

Worker is blocked. Surface to the human; do not close the task.

```bash
handle_worker_block() {
  local event="$1"
  local task_id=$(echo "$event" | jq -r '.task_id')
  local reason=$(echo "$event" | jq -r '.reason // "no reason provided"')

  # DDB: already updated to blocked by the worker.
  # Notify the human (requestor) that the task is blocked.
  # Use the Slack tool to post in the relevant thread or DM.
  echo "[nats] task $task_id blocked: $reason"
}
```

---

## DDB lifecycle (Ariadne's side)

| State transition | Who | Trigger |
|-----------------|-----|---------|
| → delegated | Ariadne | `fleetmind task create` |
| delegated → accepted | Worker | `fleetmind task ack` (auto on NATS receipt) |
| accepted → shipped | Worker | `fleetmind task ship` |
| shipped → signed_off | **Ariadne** | Receives `ship` NATS event → `fleetmind task signoff` |
| signed_off → merged | Ariadne | PR merge webhook / manual |
| any → blocked | Worker | `fleetmind task block` |
| blocked → accepted | Worker | `fleetmind task unblock` |
| any → abandoned | Ariadne | Human decision → `fleetmind task abandon` |

Ariadne's primary DDB write in this flow is `signoff`. Everything else
is written by the worker or auto-derived from events.

---

## No sweep cron jobs

With NATS transport, the cron sweep jobs defined in `delegation.sweeps`
are not needed — workers push events rather than being polled. Remove or
disable sweeps in `fleet.yaml` when running with NATS:

```yaml
delegation:
  delegation_transport: nats
  nats:
    servers: ["nats://myfleet.internal:4222"]
  # sweeps: []  ← leave empty or remove entirely
```

---

## Voice discipline

*Ariadne never posts a Slack envelope for the worker.* The worker opens
the Slack thread with the human. Ariadne is silent on Slack unless:
- Notifying the human about a blocker
- Closing out the work on sign-off (optional summary)
- The human asks Ariadne directly

*NATS (agent-to-agent — never visible to humans):*
- `delegation` — Ariadne publishes ✅
- `ack`, `progress`, `ship`, `block` — Ariadne receives ✅

---

## Changelog

- **1.0.0** — Initial release for feat/nats-transport POC (CON-115).
