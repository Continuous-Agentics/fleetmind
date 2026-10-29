# Close the loop: parent review and delivery

## Review the evidence

1. For independent fleet work, read `fleetmind task get --task-id <task_id> --json`
   and `fleetmind narrative get --task-id <task_id>`. DDB is authoritative;
   reuse a record already fetched for the same observation when appropriate.
   Native children instead return artifacts, checks and blockers privately.
2. Verify the outcome against what, why and DoD. A notification, accepted row,
   shipped PR or native completion alone does not prove business completion.
3. The parent owns user-facing closeout. Resolve provider/account/recipient and
   thread from trusted task/session context. Human-originated tasks reply to
   their originating thread; follow-on work uses the configured coordination
   route. Channel-less work returns via the parent/session. Missing routing
   blocks public delivery; do not guess.
4. Summarize task, worker, outcome, artifact, checks, blockers and narrative.
   For `requires-human-signoff`, present the PR as ready for review and keep
   the audit block active as `in-review`.
5. Only after authorized human approval may the parent record
   `fleetmind task signoff --task-id <task_id> --project <project>`.
   `signed_off` is approval, not merge. PR tasks remain active as `approved`.
6. Only after verifying the actual authorized PR merge may the parent record
   `fleetmind task merge --task-id <task_id> --project <project>` and mark done.
   This skill does not grant merge, deployment or publication authority.
7. Move a PR task to `## Closed` only after `merged` (or authorized abandonment).
   Non-PR work follows its explicitly chosen lifecycle and required signoff.
   Blocked work stays active until resolved or abandoned. Record the observed
   DDB timestamp as `last-handled-terminal-at` after handling the current signal;
   a newer signal must be reconciled again.

## Completion check

Before reporting completion, verify evidence, required human approval and actual
merge for PR work; confirm parent delivery on the correct route and the audit
log's corresponding state. A delivery failure remains pending. Report skipped
or unavailable steps explicitly; never synthesize success or a scheduler.

## Optional native child

The parent may perform review inline. If an authorized native child is useful,
use [../assets/sub-agent-task-templates.md](../assets/sub-agent-task-templates.md).
The child returns a substantive private result with evidence and proposed next
steps. It does not post publicly or close the parent's task. The parent reviews,
performs authorized ledger/tracker transitions and delivers the final response.
