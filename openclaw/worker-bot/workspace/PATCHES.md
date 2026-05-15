# PATCHES.md — Workspace patches for worker-bot
#
# Applied by `fleetmind pull-self` after each workspace update.
# See pm-bot/workspace/PATCHES.md for format documentation.

---

<!-- AUTO SECTION -->
## Patch: acp-thread-context
- **id:** `acp-thread-context`
- **file:** AGENTS.md
- **detect:** `original Slack thread context is NOT automatically carried across hops`
- **after:** `## Subagent / ACP Completion Replies`
- **mode:** insert-after
- **added:** 2026-05-13
- **roles:** all
- **description:** ACP/sub-agent thread context callout — learned from live fleet, the single most common silent-failure mode.

```markdown
**When completing work inside a sub-agent — or when the runtime delivers an ACP
result — the original Slack thread context is NOT automatically carried across
hops.** Every reply that needs to land in a specific delegation thread MUST
include explicit `target` (channel) and `replyTo` (thread timestamp).

Without these, your completion reply either drops silently or lands in the wrong
channel. This is the single most common silent-failure mode in multi-bot
delegation flows.
```

---

<!-- AUTO SECTION -->
## Patch: memory-active-tasks
- **id:** `memory-active-tasks`
- **file:** MEMORY.md
- **detect:** `## Active Tasks`
- **after:** `end-of-file`
- **mode:** append-file
- **added:** 2026-05-13
- **roles:** all
- **description:** Seed an Active Tasks section in MEMORY.md.

```markdown
<!-- AUTO SECTION -->
## Active Tasks

| Task ID | Description | Status | Thread |
|---------|-------------|--------|--------|
| (updated by bot as tasks are received and completed) | | | |
```

---
