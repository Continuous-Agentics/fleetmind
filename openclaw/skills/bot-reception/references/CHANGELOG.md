# `bot-reception` — Changelog

Full version history for `SKILL.md`. Load this only when you need historical
rationale for a specific rule; the current rules always live in `SKILL.md`
itself, not here.

- **1.6.0 (2026-07-09)** — Tracker-agnostic self-start trigger (#241):
  - § Handling Human Requests (Non-Delegation): removed Linear-specific bullets;
    "Linear issue assigned to you" replaced with "human directly asks you to pick
    up a discrete piece of work (non-delegation) → worker-self-start".
  - § Push-back: rewritten tracker-agnostic; no longer asks human to create a
    Linear issue; asks for task description + optional tracker URL.
- **1.5.0 (2026-07-09)** — Worker Self-Start Protocol integration (CON-91,
  re-authored from PR #169 onto NATS transport):
  - § Handling Human Requests renamed to "Non-Delegation"; classifies requests:
    discussion, push-back for unlinked feature requests, self-start for
    Linear-assigned tasks.
  - New § Push-back: exact reply text for unlinked feature requests.
  - § Informal-task ledger CLI corrected: `--lifecycle informal` and
    `--status accepted` are not valid CLI options (bug in v1.4.0 / main);
    replaced with `--lifecycle shipped-is-done` and explicit `task ack` step.
  - `--envelope-ts` documented as optional for NATS-only fleets.
- **1.2.0 (2026-05-21)** — Rewrite for NATS-only transport (CON-115):
  - Removed Slack envelope recognition entirely. Delegation arrives via NATS
    subscriber, not a Slack message with `Task ID:` / `React :eyes:`.
  - Session boot now has two steps: NATS subscriber startup (new) then DDB
    write-health precheck. DDB unhealthy → publish NATS block event instead
    of posting in Slack channel.
  - "On Receiving a Delegation" rewritten: handle NATS JSON event, open Slack
    thread with the human requestor (not a reaction in a bot channel), store
    `thread_ts` in task-queue.md.
  - New § Mid-task Progress Updates: `fleetmind nats progress` at milestones
    + brief update in the requestor's Slack thread.
  - Completion/blocker replies go in the requestor's Slack thread, not a
    reply mentioning the PM bot. `fleetmind task ship/block` publishes the
    NATS event automatically; PM bot receives and closes DDB lifecycle.
  - Voice discipline rewritten: Slack is human-facing only; NATS is
    agent-to-agent only.
  - task-queue.md now tracks `thread_ts` for the requestor's Slack thread.
  - `bot-delegation-nats` and `bot-reception-nats` standalone skills removed;
    NATS transport is now the only transport in these core skills.
- **1.1.0 (2026-05-11)** — DDB write-health precheck, informal-task ledger,
  task-queue-before-eyes ordering.
- **1.0.0** — Initial release.
