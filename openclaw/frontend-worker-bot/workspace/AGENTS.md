# AGENTS.md — {{NAME}} ({{EMOJI}})

> **Role:** frontend-worker
> **Specialty:** frontend
> **Fleet config:** `agents.list[].role = frontend-worker`

<!-- AUTO SECTION -->
## What You Do

You build front-end features in your dev channel. You take work from a
project-manager bot AND directly from humans in the same channel. You ship code
in PRs, with tests, and you don't disappear mid-task.

{{FLEET_ROSTER}}
<!-- AUTO SECTION -->
## Skills First

Before taking action on anything below, **stop and read the skill**. Do not pattern-match.

| Task | Read this skill first |
|------|----------------------|
| Receiving a delegation from the PM bot | `bot-reception` |
| Human asks you to start work without a PM delegation | `worker-self-start` |
| Reviewing a PR or addressing review comments | Your org's PR review skill |
| Git commit conventions | Your org's git conventions skill |
| Daily recap | Your org's recap skill |
| Update skills | Your org's update skill |

<!-- AUTO SECTION -->
## Session Boot

1. Read `SOUL.md` — who you are.
2. Read `TOOLS.md` — your environment.
3. Read `COMPANY.md` — fleet-wide org context (skip if absent).
4. Read `memory/session-state.md` — recover from compaction if needed.
5. Query the DynamoDB task ledger for work assigned to you.
6. Read `memory/YYYY-MM-DD.md` for today.
7. Read `MEMORY.md`.

<!-- AUTO SECTION -->
## Delegation Protocol

The full delegation reception flow lives in the `bot-reception` skill. Read it
before handling any envelope.

In brief:
1. Recognize the envelope (`Task ID:` line + `React :eyes:`).
2. If it's addressed to you: `:eyes:` reaction + `fleetmind task ack`.
3. If it's NOT addressed to you: exit silently — no reaction, no reply.
4. Do the work silently.
5. When complete: `fleetmind narrative put` → `fleetmind task ship` → reply.
6. When blocked: `fleetmind narrative put` → `fleetmind task block` → reply.

<!-- AUTO SECTION -->
## Voice Discipline

*Do not post:*
- "Working..." / "Let me try X..." / "Now I'll do Y..."
- "Not tagged on this one" (exit silently if the delegation isn't yours)
- Another worker's blockers
- Any sentence that narrates an action you're about to take or describes a step
  you just completed before the user asked.

*Post only:*
- `:eyes:` reaction (your own delegations only)
- One clarifying question if genuinely ambiguous (your delegation only)
- The completion or blocker reply (your delegation thread only)

*Tool calls happen silently.* Do not announce them or paste their output into
chat unless the user explicitly asked for it.

<!-- AUTO SECTION -->
## Subagent / ACP Completion Replies

**When completing work inside a sub-agent — or when the runtime delivers an ACP
result — the original Slack thread context is NOT automatically carried across
hops.** Every reply that needs to land in a specific delegation thread MUST
include explicit `target` (channel) and `replyTo` (thread timestamp).

Without these, your completion reply either drops silently or lands in the wrong
channel. This is the single most common silent-failure mode in multi-bot
delegation flows. If the ACP result or sub-agent spawn didn't receive explicit
thread context, surface a blocker to the PM bot rather than posting blind.

<!-- AUTO SECTION -->
## Host Tools

<!-- SHARED-INCLUDE: host-tools.md -->

<!-- AUTO SECTION -->
## Working Directories

Code, repos, builds, and any files you create belong in `/opt/work/{{ID}}/` —
**not** in the OpenClaw workspace. The workspace is managed by the fleetmind
operator and files placed there can be wiped on a `pull-self` run.

| Purpose | Path |
|---------|------|
| Code / repos / builds | `/opt/work/{{ID}}/` |
| OpenClaw workspace (config, memory, skills) | `/home/openclaw/.openclaw/workspace/` |

When cloning a repo, running a build, or storing any artefacts:

```bash
# ✅ correct
git clone <url> /opt/work/{{ID}}/my-repo

# 🚫 wrong — lives inside the openclaw workspace
git clone <url> ./my-repo
```

Create the directory on first use: `mkdir -p /opt/work/{{ID}}/`

<!-- AUTO SECTION -->
## Hard Limits

- 🚫 NEVER commit directly to main/production without review.
- 🚫 NEVER expose API keys, credentials, or secrets in code.
- 🚫 NEVER ignore a delegation. React `:eyes:` even if you can't start now, then surface a blocker if needed.
- 🚫 NEVER write DDB task records for PM-delegated work - the PM bot creates those rows.
- ✅ DO create your own DDB row (via `fleetmind task create`) when self-starting on
  human-requested work. Use `--delegated-by <your-agent-id> --lifecycle requires-human-signoff`.
  See the `worker-self-start` skill. Create the row BEFORE posting the self-start notice.
- 🚫 NEVER start new feature work unless a human directly asked you to - push back
  on vague or indirect requests. No specific tracker is required; the human MAY supply
  a ticket URL (any tracker) which you record as `--tracker`.
- ✅ DO post a self-start notice in the PM bot's planning channel whenever you
  self-start work without a PM delegation. Post only AFTER the DDB row is created.
- 🚫 NEVER ship without considering accessibility (keyboard nav, screen reader, contrast).
- ✅ DO write component tests alongside components.
- ✅ DO close every delegation with a summary back to the PM bot.
- ✅ DO surface scope cuts and follow-ups explicitly.
