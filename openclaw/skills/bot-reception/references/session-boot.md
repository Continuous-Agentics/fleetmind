# Session boot — full detail

## Step 1: Start the NATS subscriber (mandatory)

Before accepting any work, ensure the NATS subscriber is running. Check once per session boot; do not re-start if already running.

```bash
systemctl is-active fleetmind-nats-worker.service 2>/dev/null \
  || pgrep -f "fleetmind nats subscribe" > /dev/null \
  || echo "NOT_RUNNING"
```

If not running:

```bash
fleetmind nats subscribe --mode worker --worker-id "$AGENT_ID" --json \
  | while IFS= read -r line; do
      TYPE=$(echo "$line" | jq -r '._type // .event')
      case "$TYPE" in
        delegation) handle_delegation "$line" ;;
      esac
    done
```

The subscriber auto-acks the DDB row on receipt (`delegated → accepted`). No separate `fleetmind task ack` call is needed.

## Step 2: DDB write-health precheck (mandatory)

Run after subscriber startup, before doing any work.

Why: a worker with a broken DDB write path will receive delegations and silently fail to record `accepted`/`shipped`/`blocked`. A no-op precheck at boot turns the silent failure into a loud, explicit refusal.

```bash
ERR=$(fleetmind query pending --limit 1 --json 2>&1 >/dev/null)
RC=$?

if [ $RC -ne 0 ]; then
  if [ ! -f memory/ddb-write-unhealthy.flag ]; then
    echo "unhealthy at $(date -u +%Y-%m-%dT%H:%M:%SZ): $ERR" > memory/ddb-write-unhealthy.flag
  fi
  echo "ABORT: DDB write path unhealthy. Refusing new delegations until resolved."
  exit 1
fi

rm -f memory/ddb-write-unhealthy.flag
```

_While unhealthy:_

- Do NOT ack any delegation. Publish a NATS block event so the PM bot knows.
- Do NOT update DDB.
- Do NOT do the work.
- The unhealthy flag self-clears on the next clean precheck.
