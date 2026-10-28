# Independent worker capability check

Direct/solo work and same-Gateway native children do not require a fleet
subscriber or DDB task row. Children return privately; the parent owns closeout.

## Legacy NATS routes only

Read-only checks for an operator-provisioned subscriber:

```bash
systemctl is-active fleetmind-nats-worker.service
pgrep -f "fleetmind nats subscribe.*--mode worker"
```

Do not start, stop or repair subscribers from this skill. Report unhealthy or
missing routing to the parent/operator; no fallback wake or scheduler is
promised. Legacy auto-ack advances the ledger on receipt and is not proof that
native execution was admitted or started.

## Ledger capability

For enabled independent fleet tasks, a bounded query can identify read failures:

```bash
fleetmind query pending --limit 1 --json
```

This is read access only, not a DDB write-health test. Verify each actual task
transition succeeds; reread state after conditional failures. If ledger access
fails, preserve evidence and report the blocker through the authorized route.
Do not continue effects or claim accepted/shipped from a failed transition.
