---
name: worker-self-start
version: 1.0.0
description: >
  Worker Self-Start Protocol. Use when: (1) a human asks you to do something
  without a PM delegation envelope, (2) you notice a Linear issue assigned to
  you that has no corresponding delegation, (3) you need to push back on an
  unlinked feature request, or (4) you are notifying the PM bot that you have
  self-started. Covers the approval signal (Linear assignment), push-back
  phrasing, self-start notification format, DDB row creation, and the PM bot's
  inbound handler.
---

# Worker Self-Start Protocol

## The core rule

**Linear assignment = approval.** When a Linear issue is assigned to you, you
may begin work without waiting for a delegation envelope. For everything else,
push back.

---

## Step 0 — Classify the inbound request

| Check | Action |
|-------|--------|
| Ariadne sent a delegation envelope with `Task ID:` | → Follow `bot-reception`. This skill does not apply. |
| Linear issue exists, assigned to me | → § Self-start flow |
| Human asks for new work, no Linear issue, or issue not assigned to me | → § Push-back |
| Research spike / design question (< 1 day, no issue) | → § Informal start |

---

## Push-back

When a human asks for new feature work without a linked, assigned Linear issue:

1. Reply once in the same channel/thread:
   ```
   This looks like new feature scope — can you create a Linear issue and assign
   it to me? I'll kick off as soon as it's linked. (If there's already an issue,
   share the link and I'll start now.)
   ```
2. Stop. Do not implement anything.
3. When they share the Linear URL: verify it's assigned to you, then follow
   § Self-start flow.

One reply, no repeats, no caveats.

---

## Self-start flow

### 1. Generate a task ID

```bash
TASK_ID=$(openssl rand -hex 4)
```

### 2. Write to `memory/task-queue.md` first (crash-recovery record)

Add to `## In Progress`:
```
- **<TASK_ID>** — <one-line summary> | self-start | Linear: <url>
```

### 3. Post self-start notice in the fleet delegation channel

Post a top-level message (not a thread reply) in the delegation channel,
mentioning the PM bot:

```
<@PM_BOT_SLACK_ID> — self-start notice

Worker: <your name and emoji>
Linear: <full Linear issue URL>
Task ID: <TASK_ID>
Summary: <one sentence — what you're starting and why>
```

### 4. Create a DDB row

```bash
fleetmind task create \
  --project <best-fit-project-slug>         \
  --worker  <your-agent-id>                 \
  --delegated-by <your-agent-id>            \
  --dod "<definition of done — one line>"   \
  --thread "<Slack permalink to your self-start notice>" \
  --tracker "<Linear issue URL>"            \
  --lifecycle requires-human-signoff        \
  --task-id  "${TASK_ID}"                   \
  --status   accepted                       \
  --json
```

Key flags:
- `--lifecycle requires-human-signoff` — human sign-off required, same as PM-delegated tasks.
- `--delegated-by <your-agent-id>` — self-delegation; PM bot did not create the row.
- `--status accepted` from the start; no separate `delegated` step.
- `--tracker` is mandatory for Linear-assigned self-starts.

### 5. Do the work silently

Follow the same voice discipline as delegated tasks (no "working on it…" posts).

### 6. Ship

Follow the `bot-reception` ship pattern:
1. Write narrative to S3 (`fleetmind narrative put --event shipped`)
2. Update DDB (`fleetmind task ship`)
3. Post completion reply mentioning the PM bot

---

## Informal start (research spike / design question)

When doing a short-horizon spike (< 1 day) with no Linear issue:
- No self-start notice required if it stays under 1 day.
- If the spike produces real deliverable work, convert it: generate a task ID,
  post a self-start notice, create a DDB row with `--lifecycle informal`, and
  proceed as a self-start.

---

## PM bot: inbound self-start handler

When the PM bot sees a message in the delegation channel matching `"— self-start notice"`:

1. **Verify**: fetch the Linear issue from the notice URL. Confirm it's assigned
   to the notifying worker (use the `linear-fleet` skill).
2. **React `:white_check_mark:`** to the notice.
3. **Check DDB**: run `fleetmind task get --task-id <8-char-hex> --json`.
   - Row exists → no action needed; worker already created it.
   - Row MISSING → create it on behalf of the worker:
     ```bash
     fleetmind task create \
       --project <inferred from Linear project/labels> \
       --worker  <notifying-worker-id>   \
       --delegated-by <notifying-worker-id> \
       --dod "<from Linear issue title>" \
       --thread "<notice message permalink>" \
       --tracker "<Linear URL from notice>" \
       --lifecycle requires-human-signoff \
       --task-id <8-char-hex from notice> \
       --status  accepted \
       --json
     ```
4. **Do NOT** post a delegation envelope. The worker is already running.

---

## Hard limits

- ❌ NEVER self-start on infrastructure changes (Terraform, AWS API writes) without a PR.
- ❌ NEVER pick up a Linear issue assigned to another worker.
- ❌ NEVER widen issue scope without sign-off from the human or PM bot.
- ❌ NEVER omit the PM bot self-start notice when acting on a Linear-assigned issue.
- ✅ DO create a DDB row for every self-started Linear task.
- ✅ DO push back on unlinked feature requests — every time, no exceptions.

---

## Changelog

- **1.0.0 (2026-05-16)** — Initial release. Implements the Worker Self-Start
  Protocol approved for ca-fleet (CON-91). Generalized for all fleetmind fleets.
