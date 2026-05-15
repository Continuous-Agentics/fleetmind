# PATCHES.md — Workspace patches for pm-bot
#
# Applied by `fleetmind pull-self` after each workspace update.
# Patches are idempotent: if the detect string is found in the target file,
# the patch is skipped. Never remove a patch — bots that already have it
# just skip it.
#
# Format:
#   ## Patch: <name>
#   - **id:** `unique-slug`
#   - **file:** AGENTS.md | SOUL.md | MEMORY.md | etc.
#   - **detect:** `string — if found in target file, patch already applied`
#   - **after:** `heading text to insert after` | `end-of-file`
#   - **mode:** insert-after | append-file | replace-section  (default: insert-after)
#   - **added:** YYYY-MM-DD
#   - **deprecated:** YYYY-MM-DD  (optional — no-op if set)
#   - **roles:** all | pm | worker  (optional — default: all)
#   - **description:** what this patch does
#
#   ```markdown
#   ... content to insert ...
#   ```

---

<!-- AUTO SECTION -->
## Patch: slack-mention-format
- **id:** `slack-mention-format`
- **file:** AGENTS.md
- **detect:** `Always use \`<@USERID>\` format for mentions`
- **after:** `## Delegation Protocol`
- **mode:** insert-after
- **added:** 2026-05-13
- **roles:** all
- **description:** Slack mention format rule — plain @USERID doesn't notify. Learned from live fleet.

```markdown
<!-- AUTO SECTION -->
## Slack Conventions

**Always use `<@USERID>` format for mentions** — never plain `@USERID` or a
display name. Plain text does not render as a clickable mention and does not
trigger a Slack notification. This applies everywhere: delegation envelopes,
close-the-loop summaries, thread replies.

Capture each fleet member's Slack user ID in `MEMORY.md` on first interaction.
If you don't have a user ID yet, run `fleetmind slack discover` or ask the human.
```

---

<!-- AUTO SECTION -->
## Patch: no-how-in-envelopes
- **id:** `no-how-in-envelopes`
- **file:** AGENTS.md
- **detect:** `NEVER include implementation guidance`
- **after:** `## Hard Limits`
- **mode:** insert-after
- **added:** 2026-05-13
- **roles:** all
- **description:** Delegation envelopes must not include implementation guidance. Learned from live fleet.

```markdown
- 🚫 NEVER include implementation guidance, commands, code snippets, or
  step-by-step instructions in a delegation envelope or any follow-up message
  to a worker bot. Envelopes contain *what*, *why*, and a definition of done —
  never *how*. Worker bots own the implementation.
```

---

<!-- AUTO SECTION -->
## Patch: memory-fleet-roster
- **id:** `memory-fleet-roster`
- **file:** MEMORY.md
- **detect:** `## Fleet Members`
- **after:** `end-of-file`
- **mode:** append-file
- **added:** 2026-05-13
- **roles:** all
- **description:** Seed a Fleet Members section in MEMORY.md so the bot tracks Slack user IDs.

```markdown
<!-- AUTO SECTION -->
## Fleet Members

| Agent | Role | Slack User ID | Channel(s) |
|-------|------|---------------|------------|
| (fill in via fleetmind slack discover or on first interaction) | | | |

**Note:** Always use `<@USERID>` format when mentioning fleet members or humans in Slack.
```

---
