# `bot-delegation` — Changelog

Full version history for `SKILL.md`. Load this only when you need historical
rationale for a specific rule; the current rules always live in `SKILL.md`
itself, not here.

- **1.5.0 (2026-07-15)** - Close-the-loop routing by task origin (#ea73f9e4):
  - § 7 Step 3: close-the-loop summaries now route based on `delegation_thread`
    presence in DDB. Thread-originated tasks (non-empty `delegation_thread`)
    keep the existing threaded-reply behavior. Follow-on operational tasks
    (empty `delegation_thread`) now post top-level in the planning channel so
    the update surfaces in the channel feed without requiring thread navigation.
  - references/sub-agent-task-templates.md Template (a): Output discipline and
    Step 6 updated with conditional routing logic matching § 7 Step 3.
- **1.4.0 (2026-07-09)** - Tracker-agnostic self-start trigger (#241):
  - § Inbound Self-Start Notices: "Linear-assigned tasks" replaced with
    "human directly asks the worker to pick up a discrete piece of work".
  - Recognition pattern: `Linear:` field renamed to `Tracker:` (optional;
    may be `"none"`).
  - Handler step 1: "Verify Linear assignment via linear-fleet" replaced with
    "Verify the request is legitimate" — confirms notice came from a known
    worker and describes plausible work; tracker URL checked if present but
    not mandatory.
  - Handler step 3: project-slug inference now uses notice summary + optional
    tracker issue instead of Linear issue labels.
  - Recovery `task create`: `--dod` now derived from notice summary (not
    "Linear issue title"); `--tracker` now marked as optional.
- **1.3.0 (2026-07-09)** - Worker Self-Start Protocol integration (CON-91,
  re-authored from PR #169 onto NATS transport):
  - New § Inbound Self-Start Notices: handler for when worker bots post a
    `"— self-start notice"` message in the planning channel. Covers
    `:white_check_mark:` reaction, project-slug inference (with ambiguity
    guard), DDB row check / idempotent recovery via `attribute_not_exists(PK)`,
    and the explicit "do NOT send a delegation event" rule (SF-2-aware ordering).
  - Updated Hard limits: self-start notices in the planning channel are now
    a recognised in-protocol trigger.
  - NATS-model clarification: no "delegation channel"; self-start notices
    arrive in the planning channel.
  - Human-signoff enforcement prose: describes ledger conditional-write
    (PR #236); notes IAM gap tracked in #237; does not close #237.
- **1.2.1 (2026-05-27)** - Documentation fix: Step 4 minimum fields now
  correctly reference `Source planning channel` + `Source planning thread`
  instead of removed `thread` field. Aligns with active-delegations-format
  schema.
- **1.2.0 (2026-05-21)** - Rewrite for NATS-only transport (CON-115):
  - New § Session boot - PM subscriber startup: start `fleetmind nats
    subscribe --mode pm` before handling any work. This is the replacement
    for sweep cron jobs - workers push events, PM bot reacts.
  - `fleetmind task create` now includes `--description`, `--requestor`,
    and `--tracker` flags. Removed `--envelope-ts` (no envelope). The command
    auto-publishes the NATS delegation event - no separate publish step.
  - § 3 "Post the delegation envelope" replaced with § 3 "Delegation is sent
    via NATS". No Slack envelope is posted in the worker's channel.
  - § 5 table updated: `:eyes:` reaction and threaded reply signals replaced
    with NATS `ack`/`progress`/`ship`/`block` events from the subscriber.
    `DDB_TERMINAL_WAKE` retained as a fallback path.
  - `references/envelope-template.md` removed from reference files (no
    envelope format to maintain).
  - `bot-delegation-nats` and `bot-reception-nats` standalone skills removed;
    NATS transport is now the only transport in these core skills.
- **1.1.0 (2026-05-11)** - DDB-first idempotency, reopen-on-reship, signoff
  watchdog, reconciliation, § 7 completion checklist, NO_REPLY sub-agent
  discipline, canonical sub-agent task templates.
- **1.0.0** - Initial release.
