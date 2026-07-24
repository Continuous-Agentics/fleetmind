# PM subscriber startup — full detail

Before handling any work, ensure the NATS PM subscriber is running. Check once per session boot; do not re-start if already running.

```bash
systemctl is-active fleetmind-nats-pm.service 2>/dev/null \
  || pgrep -f "fleetmind nats subscribe.*--mode pm" > /dev/null \
  || echo "NOT_RUNNING"
```

If not running:

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

This subscriber is the canonical wake path. Workers push `task.*` events; the PM bot reacts to them. There is no polling sweep - the `delegation.sweeps` schema field was removed in fleetmind 0.8.0-beta.8.
