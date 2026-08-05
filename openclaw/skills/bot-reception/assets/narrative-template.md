# S3 narrative templates (ship / block)

Copy the matching template verbatim into `fleetmind narrative put`. Both templates share the `v: 0.2` / `task_id` frontmatter and a `## Learned` closing section — see `SKILL.md` § `Learned` section: good vs. bad for what belongs there.

## Ship narrative

```bash
cat <<'NARRATIVE' | fleetmind narrative put --task-id <task_id> --event shipped
---
v: 0.2
task_id: <task_id>
---

## Task
<one-paragraph statement of what was delegated>

## What I did
<narrative — outcomes, not a tool-call transcript>

## What I didn't do
<scope cuts, follow-ups, gotchas>

## Links
- PR: <url>
- Preview: <url>

## Learned
<2-5 non-obvious bullets, or []>
NARRATIVE
```

If `fleetmind narrative put` exits with code 2 (S3 failure, local fallback): surface the fallback path as a follow-up, preserve it locally until the S3 write can be retried, and do NOT proceed to the DDB update yet.

## Block narrative

```bash
cat <<'NARRATIVE' | fleetmind narrative put --task-id <task_id> --event blocked
---
v: 0.2
task_id: <task_id>
---

## Task
<what was delegated>

## What I tried
<what you attempted>

## Need
<what would unblock — info, decision, dep fix>

## Learned
<bullets or []>
NARRATIVE
```
