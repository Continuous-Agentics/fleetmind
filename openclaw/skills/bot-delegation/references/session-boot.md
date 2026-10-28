# Execution mode and recovery capability

Direct work and same-Gateway native children do not require a fleet subscriber.
Use available, authorized native capabilities; the child reports privately and
the parent owns user-facing closeout.

## Legacy NATS independent fleets only

If an operator has already provisioned NATS routing, these read-only checks can
identify whether the configured PM subscriber is present:

```bash
systemctl is-active fleetmind-nats-pm.service
pgrep -f "fleetmind nats subscribe.*--mode pm"
```

Do not start, stop or replace a service from this skill. Missing or unhealthy
delivery must be reported to the parent/operator. Leave the legacy subscriber
unchanged until a separately authorized operational change.

Legacy receipt/auto-ack does not prove native admission. No polling sweep,
restart recovery or watchdog is guaranteed by this reference. Identify the
actual configured reconciliation owner; absent capability remains a blocker.
