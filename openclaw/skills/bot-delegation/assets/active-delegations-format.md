# `memory/active-delegations.md` — Block Format

The file has two sections: `## Active` (in-flight) and `## Closed` (terminal). Newest at top of each section. Move blocks from Active to Closed on terminal status — never delete history.

## Active block template

```
## Delegation: <8-char-hex-task-id>
- Created: <ISO 8601 UTC>
- Channel: <channel id or name>
- Assignee: <worker agent id or display name>
- Deadline: <ISO 8601 UTC, created + 10 min>
- Status: pending | acked | in-review | escalated
- Last update: <ISO 8601 UTC>
- Summary: <one-line>
- Definition of done: <DoD>
- Source planning channel: <channel id or name>
- Source planning thread: <ts of planning message>
- Requested by: <display name or user id>
- Tracker issue: <url or none>
- last-handled-terminal-at: <ISO 8601 UTC, optional>   # populated by close-the-loop on terminal; used by reopen-on-reship
- Closeloop subagent: <session-id>                     # populated when a close-the-loop sub-agent is spawned; cleared on reopen
- Closeloop spawned at: <ISO 8601 UTC>                 # cleared on reopen
```

## Closed block template

Same as above, with these additions/changes:

```
- Closed at: <ISO 8601 UTC>
- Status: done | blocked | escalated | abandoned
- Outcome: <2-3 lines: what shipped, where, how to verify>
- Sign-off: <who approved + when>           # only if DoD required human sign-off
- Tracker issue: <url> → Done               # update to terminal state if applicable
- Lifecycle correction: <one line>          # only if state was prematurely flipped and reverted
- Process miss: <one line>                  # only if a state transition was skipped
- Notes: <free-form, optional>              # follow-ups, links to next milestone, etc.
```

Drop the `Deadline` field on closure — it's not relevant anymore.

## Reopen-on-reship

The `last-handled-terminal-at` field is the freshness anchor for re-terminal events. The terminal-wake handler (§ 5a of `SKILL.md`) compares it against DDB's `shipped_at` / `blocked_at` / `merged_at` / `abandoned_at`. If DDB's value is newer, the block is moved from `## Closed` back to `## Active`:

- `Status:` is restored to `acked` (or `in-review` if `lifecycle: requires-human-signoff` and DDB `status: shipped`).
- `Closeloop subagent:` and `Closeloop spawned at:` are cleared.
- `Closed at:` and `Outcome:` are removed.
- `last-handled-terminal-at:` is left in place; the close-the-loop sub-agent overwrites it as its last mutation when it finishes the fresh close pass.
- The reopen is **silent**: no coordination-channel post, no notice. The downstream close-the-loop sub-agent posts normally when it completes.

## Field semantics

- _Status_ is the in-flight state. Values:
  - `pending` — NATS delegation event published, awaiting worker ack.
  - `acked` — worker sent NATS ack event, work in progress.
  - `in-review` — worker shipped, awaiting human sign-off (only when DoD requires it).
  - `escalated` — heartbeat hit a missed deadline.
- _Last update_ — refresh on every status change. Heartbeat uses this to compute idle time.
- _Lifecycle correction_ — record when a delegation/issue was prematurely flipped to Done before sign-off and had to be reverted. Format: `YYYY-MM-DDTHH:MMZ <session/cause> flipped issue to Done before sign-off; reverted to In Review at <ts>.`
- _Process miss_ — record skipped state transitions even if the outcome is correct. Format: `did not log the worker's :eyes: ack; issue transitioned Todo → Done directly. Cosmetic; outcome correct.`

Capturing both `Lifecycle correction` and `Process miss` separately matters: lifecycle issues are correctness bugs; process misses are paperwork bugs. They get tuned differently.
