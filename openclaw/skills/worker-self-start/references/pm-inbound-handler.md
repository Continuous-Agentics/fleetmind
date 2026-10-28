# Inbound Independent Worker Self-Start Notices

Only for enabled independent fleet work. Direct work and native child results
return through their session/parent and do not trigger worker registration.
The parent owns user-facing closeout.

## Recognize and verify

A notice on the trusted configured coordination route contains "— self-start
notice", `Task ID:` and `Tracker:` (`none` is valid). Legacy Slack notices use
`<@USERID>`; other providers require their supported mention/routing syntax.
Verify the known worker identity, direct human request and bounded what/why/DoD.
A plausible summary or a tracker URL alone is not authorization. Missing tracker
access alone is not a rejection; verify the human request from trusted context.

Acknowledge through the configured provider, then resolve the project slug.
If unclear, ask for the missing project before a ledger operation; do not guess.

## Read the authoritative row

```bash
fleetmind task get --task-id <8-char-hex from notice> --json
```

If present, verify worker, project, requester and lifecycle against the request.
Preserve the existing task ID and history. A conditional create failure is not
proof of correct ownership; reread before treating a duplicate as handled.

If missing, report registration as unresolved. Do not blindly recover with
`task create`: the current CLI may publish another NATS assignment and wake a
second execution. A recovery write requires an actually supported safe producer
path with `attribute_not_exists(PK)` and verified ownership; that producer gate
is not implemented by this skill. Never dispatch again merely to repair a notice.
Do not mark accepted from a notice; verify actual worker pickup and task state.

## Audit and review

After verification, adopt the row under `## Active` in
`memory/active-delegations.md`, marked `[self-start]`. DDB is authoritative; the
local audit log is supplementary. Preserve what/why/DoD and any tracker reference.
Human signoff is required for `requires-human-signoff` (ledger conditional-write
policy, not an IAM guarantee; raw-SDK bypass remains a known gap). `signed_off`
is approval; PR-producing work remains active until verified `merged`.
No scheduler, heartbeat or watchdog is installed or guaranteed by this handler.
